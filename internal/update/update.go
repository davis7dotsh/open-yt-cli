// Package update implements secure self-updating from GitHub Releases.
//
// The updater resolves a release, downloads the platform archive and the
// release's checksums.txt, verifies the archive's SHA-256, extracts the
// binary with path-traversal protection, and atomically replaces the
// current executable. It never reads, needs, or transmits the YouTube API
// key: the only network traffic is unauthenticated GitHub release metadata
// and asset downloads.
package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var (
	defaultGOOS   = runtime.GOOS
	defaultGOARCH = runtime.GOARCH
)

// DefaultRepo is the canonical GitHub repository for oytc releases.
const DefaultRepo = "davis7dotsh/open-yt-cli"

// DefaultAPIBaseURL is the GitHub REST API endpoint.
const DefaultAPIBaseURL = "https://api.github.com"

const (
	maxMetadataBytes = 4 << 20   // release JSON
	maxChecksumBytes = 1 << 20   // checksums.txt
	maxArchiveBytes  = 256 << 20 // release archive
)

// Updater performs a self-update. Every external dependency is injectable
// so behavior is fully testable with httptest servers and temp dirs.
type Updater struct {
	Repo           string
	APIBaseURL     string
	HTTPClient     *http.Client
	CurrentVersion string
	GOOS           string
	GOARCH         string
	// ExecutablePath overrides os.Executable for tests.
	ExecutablePath string
}

// Options control a single update run.
type Options struct {
	// TargetVersion is an explicit release tag such as "v1.2.0". Empty
	// means the latest non-prerelease release. Explicitly requesting a
	// tag permits installing that exact version even if it is older.
	TargetVersion string
	// CheckOnly reports the available version without changing anything.
	CheckOnly bool
}

// Release is the subset of the GitHub release payload the updater needs.
type Release struct {
	TagName    string  `json:"tag_name"`
	Prerelease bool    `json:"prerelease"`
	Assets     []Asset `json:"assets"`
}

// Asset is a single downloadable release artifact.
type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// Result describes what an update run concluded or performed.
type Result struct {
	CurrentVersion string `json:"currentVersion"`
	TargetVersion  string `json:"targetVersion"`
	Updated        bool   `json:"updated"`
	UpToDate       bool   `json:"upToDate"`
	AssetName      string `json:"assetName,omitempty"`
	ExecutablePath string `json:"executablePath,omitempty"`
}

// AssetName returns the release asset filename for a tag and platform,
// e.g. "oytc_v0.1.0_linux_amd64.tar.gz". This naming is shared verbatim by
// the release workflow, the installer script, and the website.
func AssetName(tag, goos, goarch string) string {
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("oytc_%s_%s_%s.%s", tag, goos, goarch, ext)
}

// ChecksumsName is the release checksum manifest filename.
const ChecksumsName = "checksums.txt"

// Run executes the update (or check) and returns what happened.
func (u *Updater) Run(ctx context.Context, options Options) (Result, error) {
	result := Result{CurrentVersion: u.CurrentVersion}
	executable, err := u.executable()
	if err != nil {
		return result, err
	}
	result.ExecutablePath = executable
	if err := guardManagedInstall(executable); err != nil {
		return result, err
	}

	release, err := u.resolveRelease(ctx, options.TargetVersion)
	if err != nil {
		return result, err
	}
	result.TargetVersion = release.TagName
	result.AssetName = AssetName(release.TagName, u.goos(), u.goarch())

	comparison, comparable := CompareVersions(release.TagName, u.CurrentVersion)
	if comparable && comparison == 0 {
		result.UpToDate = true
		return result, nil
	}
	if comparable && comparison < 0 && options.TargetVersion == "" {
		return result, fmt.Errorf("latest release %s is older than the current version %s; refusing to downgrade (pass an explicit version to override)", release.TagName, u.CurrentVersion)
	}
	if options.CheckOnly {
		return result, nil
	}

	if err := checkWritable(executable); err != nil {
		return result, err
	}

	assetURL, checksumsURL, err := findAssets(release, result.AssetName)
	if err != nil {
		return result, err
	}
	expected, err := u.fetchChecksum(ctx, checksumsURL, result.AssetName)
	if err != nil {
		return result, err
	}
	archive, err := u.downloadVerified(ctx, assetURL, expected)
	if err != nil {
		return result, err
	}
	defer os.Remove(archive)

	binary, err := extractBinary(archive, u.goos())
	if err != nil {
		return result, err
	}
	if err := replaceExecutable(binary, executable, u.goos()); err != nil {
		return result, err
	}
	result.Updated = true
	return result, nil
}

func (u *Updater) executable() (string, error) {
	if u.ExecutablePath != "" {
		return u.ExecutablePath, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate current executable: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return executable, nil
	}
	return resolved, nil
}

func (u *Updater) goos() string {
	if u.GOOS != "" {
		return u.GOOS
	}
	return defaultGOOS
}

func (u *Updater) goarch() string {
	if u.GOARCH != "" {
		return u.GOARCH
	}
	return defaultGOARCH
}

func (u *Updater) httpClient() *http.Client {
	if u.HTTPClient != nil {
		return u.HTTPClient
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

func (u *Updater) apiBaseURL() string {
	if u.APIBaseURL != "" {
		return strings.TrimRight(u.APIBaseURL, "/")
	}
	return DefaultAPIBaseURL
}

func (u *Updater) repo() string {
	if u.Repo != "" {
		return u.Repo
	}
	return DefaultRepo
}

func (u *Updater) resolveRelease(ctx context.Context, tag string) (Release, error) {
	endpoint := u.apiBaseURL() + "/repos/" + u.repo() + "/releases/latest"
	if tag != "" {
		if !strings.HasPrefix(tag, "v") {
			tag = "v" + tag
		}
		endpoint = u.apiBaseURL() + "/repos/" + u.repo() + "/releases/tags/" + tag
	}
	body, err := u.get(ctx, endpoint, maxMetadataBytes, "application/vnd.github+json")
	if err != nil {
		return Release{}, fmt.Errorf("resolve release: %w", err)
	}
	var release Release
	if err := json.Unmarshal(body, &release); err != nil {
		return Release{}, fmt.Errorf("parse release metadata: %w", err)
	}
	if release.TagName == "" {
		return Release{}, errors.New("release metadata is missing a tag name")
	}
	return release, nil
}

func (u *Updater) get(ctx context.Context, url string, limit int64, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	req.Header.Set("User-Agent", "oytc-updater/"+u.CurrentVersion)
	resp, err := u.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("GET %s: not found (has a release been published?)", url)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: unexpected status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("GET %s: response exceeds %d bytes", url, limit)
	}
	return body, nil
}

func findAssets(release Release, assetName string) (assetURL, checksumsURL string, err error) {
	for _, asset := range release.Assets {
		switch asset.Name {
		case assetName:
			assetURL = asset.BrowserDownloadURL
		case ChecksumsName:
			checksumsURL = asset.BrowserDownloadURL
		}
	}
	if assetURL == "" {
		return "", "", fmt.Errorf("release %s has no asset %q for this platform", release.TagName, assetName)
	}
	if checksumsURL == "" {
		return "", "", fmt.Errorf("release %s has no %s asset; refusing to install an unverifiable binary", release.TagName, ChecksumsName)
	}
	return assetURL, checksumsURL, nil
}

func (u *Updater) fetchChecksum(ctx context.Context, url, assetName string) (string, error) {
	body, err := u.get(ctx, url, maxChecksumBytes, "")
	if err != nil {
		return "", fmt.Errorf("download %s: %w", ChecksumsName, err)
	}
	checksum, err := ParseChecksums(body, assetName)
	if err != nil {
		return "", err
	}
	return checksum, nil
}

// ParseChecksums extracts the SHA-256 hex digest for name from a
// sha256sum-format manifest ("<hex>  <filename>" per line).
func ParseChecksums(manifest []byte, name string) (string, error) {
	for _, line := range strings.Split(string(manifest), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") == name {
			digest := strings.ToLower(fields[0])
			if len(digest) != sha256.Size*2 {
				return "", fmt.Errorf("%s contains a malformed digest for %q", ChecksumsName, name)
			}
			if _, err := hex.DecodeString(digest); err != nil {
				return "", fmt.Errorf("%s contains a malformed digest for %q", ChecksumsName, name)
			}
			return digest, nil
		}
	}
	return "", fmt.Errorf("%s has no entry for %q", ChecksumsName, name)
}

func (u *Updater) downloadVerified(ctx context.Context, url, expected string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "oytc-updater/"+u.CurrentVersion)
	resp, err := u.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("download release archive: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download release archive: unexpected status %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp("", "oytc-update-*.archive")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	hasher := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(tmp, hasher), io.LimitReader(resp.Body, maxArchiveBytes))
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("save release archive: %w", errors.Join(copyErr, closeErr))
	}
	actual := hex.EncodeToString(hasher.Sum(nil))
	if actual != expected {
		os.Remove(tmpName)
		return "", fmt.Errorf("checksum mismatch for downloaded archive: expected %s, got %s; refusing to install", expected, actual)
	}
	return tmpName, nil
}

// extractBinary pulls the oytc binary out of a verified archive. Only an
// entry whose cleaned path is exactly the expected binary name is accepted,
// which also defeats path traversal (../, absolute paths, nested paths).
func extractBinary(archivePath, goos string) (string, error) {
	want := "oytc"
	if goos == "windows" {
		want = "oytc.exe"
	}
	if strings.HasSuffix(archivePath, ".zip") || goos == "windows" {
		return extractFromZip(archivePath, want)
	}
	return extractFromTarGz(archivePath, want)
}

func safeEntryMatch(name, want string) bool {
	cleaned := path.Clean(strings.ReplaceAll(name, `\`, "/"))
	return cleaned == want
}

func extractFromTarGz(archivePath, want string) (string, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return "", fmt.Errorf("open release archive: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read release archive: %w", err)
		}
		if header.Typeflag != tar.TypeReg || !safeEntryMatch(header.Name, want) {
			continue
		}
		return writeBinaryTemp(reader, want)
	}
	return "", fmt.Errorf("release archive does not contain %q", want)
}

func extractFromZip(archivePath, want string) (string, error) {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", fmt.Errorf("open release archive: %w", err)
	}
	defer reader.Close()
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() || !safeEntryMatch(entry.Name, want) {
			continue
		}
		content, err := entry.Open()
		if err != nil {
			return "", err
		}
		defer content.Close()
		return writeBinaryTemp(content, want)
	}
	return "", fmt.Errorf("release archive does not contain %q", want)
}

func writeBinaryTemp(content io.Reader, want string) (string, error) {
	tmp, err := os.CreateTemp("", "oytc-binary-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	_, copyErr := io.Copy(tmp, io.LimitReader(content, maxArchiveBytes))
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("extract %s: %w", want, errors.Join(copyErr, closeErr))
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	return tmpName, nil
}

// replaceExecutable atomically swaps the new binary into place. The staged
// copy lives in the same directory as the target so the final rename is
// atomic on POSIX filesystems. On Windows a running executable cannot be
// overwritten, but it can be renamed: the current binary is moved aside to
// "<name>.old" first.
func replaceExecutable(newBinary, executable, goos string) error {
	defer os.Remove(newBinary)
	dir := filepath.Dir(executable)
	staged, err := os.CreateTemp(dir, ".oytc-new-*")
	if err != nil {
		return installPermissionError(executable, err)
	}
	stagedName := staged.Name()
	source, err := os.Open(newBinary)
	if err != nil {
		staged.Close()
		os.Remove(stagedName)
		return err
	}
	_, copyErr := io.Copy(staged, source)
	source.Close()
	closeErr := staged.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(stagedName)
		return fmt.Errorf("stage new binary: %w", errors.Join(copyErr, closeErr))
	}
	if err := os.Chmod(stagedName, 0o755); err != nil {
		os.Remove(stagedName)
		return err
	}
	if goos == "windows" {
		old := executable + ".old"
		_ = os.Remove(old)
		if err := os.Rename(executable, old); err != nil {
			os.Remove(stagedName)
			return fmt.Errorf("move the running executable aside (%w); on Windows, download the new release manually from https://github.com/%s/releases and replace %s", err, DefaultRepo, executable)
		}
		if err := os.Rename(stagedName, executable); err != nil {
			_ = os.Rename(old, executable)
			os.Remove(stagedName)
			return installPermissionError(executable, err)
		}
		return nil
	}
	if err := os.Rename(stagedName, executable); err != nil {
		os.Remove(stagedName)
		return installPermissionError(executable, err)
	}
	return nil
}

func checkWritable(executable string) error {
	dir := filepath.Dir(executable)
	probe, err := os.CreateTemp(dir, ".oytc-write-probe-*")
	if err != nil {
		return installPermissionError(executable, err)
	}
	probe.Close()
	os.Remove(probe.Name())
	return nil
}

func installPermissionError(executable string, err error) error {
	if errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("no permission to replace %s: %w\nRe-run the update with sufficient privileges, or reinstall to a user-writable location with the install script (https://davis7dotsh.github.io/open-yt-cli/install.sh)", executable, err)
	}
	return err
}

func guardManagedInstall(executable string) error {
	normalized := filepath.ToSlash(executable)
	for _, marker := range []string{"/Cellar/", "/homebrew/", "/linuxbrew/"} {
		if strings.Contains(normalized, marker) {
			return fmt.Errorf("%s looks like a Homebrew-managed install; update it with your package manager instead of the self-updater", executable)
		}
	}
	return nil
}

// CompareVersions compares two semantic version tags such as "v1.2.3" or
// "1.2.3-rc.1". It returns (-1|0|1, true) when both parse, and (0, false)
// when either does not (for example a "dev" build).
func CompareVersions(a, b string) (int, bool) {
	av, aok := parseVersion(a)
	bv, bok := parseVersion(b)
	if !aok || !bok {
		return 0, false
	}
	for i := range 3 {
		if av.nums[i] != bv.nums[i] {
			if av.nums[i] < bv.nums[i] {
				return -1, true
			}
			return 1, true
		}
	}
	// A release version is greater than any of its prereleases.
	switch {
	case av.pre == bv.pre:
		return 0, true
	case av.pre == "":
		return 1, true
	case bv.pre == "":
		return -1, true
	case av.pre < bv.pre:
		return -1, true
	default:
		return 1, true
	}
}

type parsedVersion struct {
	nums [3]int
	pre  string
}

func parseVersion(tag string) (parsedVersion, bool) {
	tag = strings.TrimPrefix(strings.TrimSpace(tag), "v")
	if tag == "" {
		return parsedVersion{}, false
	}
	core, pre, _ := strings.Cut(tag, "-")
	core, _, _ = strings.Cut(core, "+")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return parsedVersion{}, false
	}
	var parsed parsedVersion
	parsed.pre = pre
	for i, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return parsedVersion{}, false
		}
		parsed.nums[i] = number
	}
	return parsed, true
}

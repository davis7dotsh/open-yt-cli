package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tarGzWithEntry(t *testing.T, entryName string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: entryName, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipWithEntry(t *testing.T, entryName string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	writer, err := zw.Create(entryName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type fixture struct {
	updater    *Updater
	executable string
	archive    []byte
	checksums  string
	assetName  string
}

func newFixture(t *testing.T, tag, goos, goarch, currentVersion string, binaryContent []byte) *fixture {
	t.Helper()
	entry := "oytc"
	if goos == "windows" {
		entry = "oytc.exe"
	}
	var archive []byte
	if goos == "windows" {
		archive = zipWithEntry(t, entry, binaryContent)
	} else {
		archive = tarGzWithEntry(t, entry, binaryContent)
	}
	assetName := AssetName(tag, goos, goarch)
	sum := sha256.Sum256(archive)
	checksums := fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), assetName)

	dir := t.TempDir()
	executable := filepath.Join(dir, "oytc")
	if err := os.WriteFile(executable, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	f := &fixture{executable: executable, archive: archive, checksums: checksums, assetName: assetName}
	mux := http.NewServeMux()
	var server *httptest.Server
	release := func() Release {
		return Release{
			TagName: tag,
			Assets: []Asset{
				{Name: assetName, BrowserDownloadURL: server.URL + "/assets/" + assetName},
				{Name: ChecksumsName, BrowserDownloadURL: server.URL + "/assets/" + ChecksumsName},
			},
		}
	}
	mux.HandleFunc("/repos/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(release())
	})
	mux.HandleFunc("/repos/owner/repo/releases/tags/", func(w http.ResponseWriter, r *http.Request) {
		requested := strings.TrimPrefix(r.URL.Path, "/repos/owner/repo/releases/tags/")
		if requested != tag {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(release())
	})
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		switch strings.TrimPrefix(r.URL.Path, "/assets/") {
		case f.assetName:
			_, _ = w.Write(f.archive)
		case ChecksumsName:
			_, _ = w.Write([]byte(f.checksums))
		default:
			http.NotFound(w, r)
		}
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)

	f.updater = &Updater{
		Repo:           "owner/repo",
		APIBaseURL:     server.URL,
		HTTPClient:     server.Client(),
		CurrentVersion: currentVersion,
		GOOS:           goos,
		GOARCH:         goarch,
		ExecutablePath: executable,
	}
	return f
}

func TestUpdateDownloadsVerifiesAndReplaces(t *testing.T) {
	binary := []byte("new-binary-content")
	f := newFixture(t, "v0.2.0", "linux", "amd64", "v0.1.0", binary)
	result, err := f.updater.Run(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated || result.TargetVersion != "v0.2.0" {
		t.Fatalf("result = %#v", result)
	}
	installed, err := os.ReadFile(f.executable)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, binary) {
		t.Fatalf("installed binary = %q", installed)
	}
	info, err := os.Stat(f.executable)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("installed binary is not executable: %v", info.Mode())
	}
}

func TestUpdateRefusesChecksumMismatch(t *testing.T) {
	f := newFixture(t, "v0.2.0", "linux", "amd64", "v0.1.0", []byte("payload"))
	f.checksums = strings.Repeat("0", 64) + "  " + f.assetName + "\n"
	_, err := f.updater.Run(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v", err)
	}
	original, _ := os.ReadFile(f.executable)
	if string(original) != "old-binary" {
		t.Fatalf("executable was modified on checksum failure")
	}
}

func TestUpdateRefusesMissingChecksums(t *testing.T) {
	f := newFixture(t, "v0.2.0", "linux", "amd64", "v0.1.0", []byte("payload"))
	f.checksums = "deadbeef  something-else.tar.gz\n"
	_, err := f.updater.Run(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "no entry") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdateAlreadyCurrent(t *testing.T) {
	f := newFixture(t, "v0.2.0", "linux", "amd64", "v0.2.0", []byte("payload"))
	result, err := f.updater.Run(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.UpToDate || result.Updated {
		t.Fatalf("result = %#v", result)
	}
	original, _ := os.ReadFile(f.executable)
	if string(original) != "old-binary" {
		t.Fatalf("executable modified for an up-to-date version")
	}
}

func TestUpdateRefusesImplicitDowngrade(t *testing.T) {
	f := newFixture(t, "v0.1.0", "linux", "amd64", "v0.2.0", []byte("payload"))
	_, err := f.updater.Run(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "refusing to downgrade") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdateExplicitVersionAllowsPinnedInstall(t *testing.T) {
	binary := []byte("pinned")
	f := newFixture(t, "v0.1.5", "linux", "amd64", "v0.2.0", binary)
	result, err := f.updater.Run(context.Background(), Options{TargetVersion: "v0.1.5"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated {
		t.Fatalf("result = %#v", result)
	}
	installed, _ := os.ReadFile(f.executable)
	if !bytes.Equal(installed, binary) {
		t.Fatalf("installed = %q", installed)
	}
}

func TestUpdateCheckOnlyDoesNotModify(t *testing.T) {
	f := newFixture(t, "v0.3.0", "linux", "amd64", "v0.1.0", []byte("payload"))
	result, err := f.updater.Run(context.Background(), Options{CheckOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Updated || result.UpToDate || result.TargetVersion != "v0.3.0" {
		t.Fatalf("result = %#v", result)
	}
	original, _ := os.ReadFile(f.executable)
	if string(original) != "old-binary" {
		t.Fatalf("check-only modified the executable")
	}
}

func TestUpdateWindowsZipAndRenameAside(t *testing.T) {
	binary := []byte("windows-binary")
	f := newFixture(t, "v0.2.0", "windows", "amd64", "v0.1.0", binary)
	result, err := f.updater.Run(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated {
		t.Fatalf("result = %#v", result)
	}
	installed, _ := os.ReadFile(f.executable)
	if !bytes.Equal(installed, binary) {
		t.Fatalf("installed = %q", installed)
	}
	old, err := os.ReadFile(f.executable + ".old")
	if err != nil || string(old) != "old-binary" {
		t.Fatalf("previous binary not preserved aside: %v", err)
	}
}

func TestExtractRejectsPathTraversal(t *testing.T) {
	for _, entry := range []string{"../oytc", "/oytc", "nested/oytc", "..\\oytc"} {
		archive := tarGzWithEntry(t, entry, []byte("evil"))
		tmp := filepath.Join(t.TempDir(), "a.tar.gz")
		if err := os.WriteFile(tmp, archive, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := extractFromTarGz(tmp, "oytc"); err == nil || !strings.Contains(err.Error(), "does not contain") {
			t.Fatalf("entry %q: err = %v", entry, err)
		}
	}
}

func TestUpdateRefusesHomebrewInstall(t *testing.T) {
	f := newFixture(t, "v0.2.0", "linux", "amd64", "v0.1.0", []byte("payload"))
	f.updater.ExecutablePath = "/opt/homebrew/Cellar/oytc/0.1.0/bin/oytc"
	_, err := f.updater.Run(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "Homebrew") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdateMissingAssetForPlatform(t *testing.T) {
	f := newFixture(t, "v0.2.0", "linux", "amd64", "v0.1.0", []byte("payload"))
	f.updater.GOARCH = "riscv64"
	_, err := f.updater.Run(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "no asset") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseChecksums(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	manifest := []byte(fmt.Sprintf("%s  oytc_v1.0.0_linux_amd64.tar.gz\n%s *oytc_v1.0.0_darwin_arm64.tar.gz\n", digest, digest))
	for _, name := range []string{"oytc_v1.0.0_linux_amd64.tar.gz", "oytc_v1.0.0_darwin_arm64.tar.gz"} {
		got, err := ParseChecksums(manifest, name)
		if err != nil || got != digest {
			t.Fatalf("ParseChecksums(%q) = %q, %v", name, got, err)
		}
	}
	if _, err := ParseChecksums(manifest, "missing.tar.gz"); err == nil {
		t.Fatal("expected error for missing entry")
	}
	if _, err := ParseChecksums([]byte("nothex  oytc.tar.gz\n"), "oytc.tar.gz"); err == nil {
		t.Fatal("expected error for malformed digest")
	}
}

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b       string
		want       int
		comparable bool
	}{
		{"v1.2.3", "v1.2.3", 0, true},
		{"v1.2.3", "1.2.3", 0, true},
		{"v0.2.0", "v0.10.0", -1, true},
		{"v2.0.0", "v1.9.9", 1, true},
		{"v1.0.0-rc.1", "v1.0.0", -1, true},
		{"v1.0.0", "v1.0.0-rc.1", 1, true},
		{"v1.0.0-rc.1", "v1.0.0-rc.2", -1, true},
		{"dev", "v1.0.0", 0, false},
		{"v1.0.0", "unknown", 0, false},
	}
	for _, test := range tests {
		got, ok := CompareVersions(test.a, test.b)
		if got != test.want || ok != test.comparable {
			t.Errorf("CompareVersions(%q, %q) = %d, %t; want %d, %t", test.a, test.b, got, ok, test.want, test.comparable)
		}
	}
}

func TestAssetName(t *testing.T) {
	if got := AssetName("v0.1.0", "linux", "arm64"); got != "oytc_v0.1.0_linux_arm64.tar.gz" {
		t.Fatalf("AssetName = %q", got)
	}
	if got := AssetName("v0.1.0", "windows", "amd64"); got != "oytc_v0.1.0_windows_amd64.zip" {
		t.Fatalf("AssetName = %q", got)
	}
}

func TestDevBuildStillUpdatesToLatest(t *testing.T) {
	binary := []byte("release-binary")
	f := newFixture(t, "v0.2.0", "linux", "amd64", "dev", binary)
	result, err := f.updater.Run(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated {
		t.Fatalf("result = %#v", result)
	}
}

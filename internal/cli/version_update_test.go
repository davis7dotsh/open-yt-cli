package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"open-yt-cli/internal/update"
	"open-yt-cli/internal/version"
)

func TestVersionCommandJSON(t *testing.T) {
	oldVersion := version.Version
	t.Cleanup(func() { version.Version = oldVersion })
	version.Version = "v1.2.3"

	app := New()
	out := &bytes.Buffer{}
	app.Out = out
	app.IsOutputTTY = false
	if err := execute(t, app, "version", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(out.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state["version"] != "v1.2.3" || state["os"] != runtime.GOOS {
		t.Fatalf("version output: %s", out.String())
	}
}

func TestVersionFlag(t *testing.T) {
	oldVersion := version.Version
	t.Cleanup(func() { version.Version = oldVersion })
	version.Version = "v1.2.3"

	for _, flag := range []string{"-v", "--version"} {
		t.Run(flag, func(t *testing.T) {
			app := New()
			var out bytes.Buffer
			app.Out = &out
			if err := execute(t, app, flag); err != nil {
				t.Fatal(err)
			}
			if got := out.String(); got != "oytc v1.2.3\n" {
				t.Fatalf("output = %q", got)
			}
		})
	}
}

func TestUpdateCommandRunsThroughInjectedUpdater(t *testing.T) {
	oldVersion := version.Version
	t.Cleanup(func() { version.Version = oldVersion })
	version.Version = "v0.1.0"

	binary := []byte("released-binary")
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "oytc", Mode: 0o755, Size: int64(len(binary)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(binary); err != nil {
		t.Fatal(err)
	}
	_ = tw.Close()
	_ = gz.Close()

	asset := update.AssetName("v0.2.0", "linux", "amd64")
	sum := sha256.Sum256(archive.Bytes())
	checksums := fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), asset)

	var server *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"tag_name":"v0.2.0","assets":[{"name":%q,"browser_download_url":%q},{"name":"checksums.txt","browser_download_url":%q}]}`,
			asset, server.URL+"/a", server.URL+"/c")
	})
	mux.HandleFunc("/a", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(archive.Bytes()) })
	mux.HandleFunc("/c", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(checksums)) })
	server = httptest.NewServer(mux)
	defer server.Close()

	executable := filepath.Join(t.TempDir(), "oytc")
	if err := os.WriteFile(executable, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}

	app := New()
	out := &bytes.Buffer{}
	app.Out = out
	app.IsOutputTTY = false
	app.UpdaterFactory = func(u *update.Updater) *update.Updater {
		u.Repo = "owner/repo"
		u.APIBaseURL = server.URL
		u.HTTPClient = server.Client()
		u.GOOS = "linux"
		u.GOARCH = "amd64"
		u.ExecutablePath = executable
		return u
	}
	if err := execute(t, app, "update", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(executable)
	if err != nil || !bytes.Equal(installed, binary) {
		t.Fatalf("installed = %q, err = %v", installed, err)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"updated": true`)) {
		t.Fatalf("output: %s", out.String())
	}

	// The upgrade alias resolves to the same command.
	if err := execute(t, app, "upgrade", "--check", "--format", "json"); err != nil {
		t.Fatal(err)
	}
}

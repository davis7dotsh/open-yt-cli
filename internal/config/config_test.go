package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSaveLoadRemoveAndModes(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OYTC_CONFIG_DIR", filepath.Join(dir, "nested"))
	t.Setenv("OYTC_API_KEY", "")

	path, err := Save("test-secret-key")
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(dir, "nested", "auth.json") {
		t.Fatalf("unexpected path %q", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if file.APIKey != "test-secret-key" {
		t.Fatalf("wrong saved key %q", file.APIKey)
	}
	if runtime.GOOS != "windows" {
		if mode := mustStat(t, path).Mode().Perm(); mode != 0o600 {
			t.Fatalf("file mode = %o, want 600", mode)
		}
		if mode := mustStat(t, filepath.Dir(path)).Mode().Perm(); mode != 0o700 {
			t.Fatalf("directory mode = %o, want 700", mode)
		}
	}
	credentials, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Key != "test-secret-key" || credentials.Source != "auth.json" {
		t.Fatalf("unexpected credentials: %#v", credentials)
	}
	if _, err := Save("replacement-secret"); err != nil {
		t.Fatalf("replace credentials: %v", err)
	}
	credentials, err = Load()
	if err != nil || credentials.Key != "replacement-secret" {
		t.Fatalf("replacement credentials: %#v, %v", credentials, err)
	}
	removedPath, removed, err := Remove()
	if err != nil || !removed || removedPath != path {
		t.Fatalf("Remove() = %q, %t, %v", removedPath, removed, err)
	}
	_, removed, err = Remove()
	if err != nil || removed {
		t.Fatalf("idempotent Remove() = %t, %v", removed, err)
	}
}

func TestEnvironmentKeyHasPrecedence(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "environment-secret")
	if _, err := Save("file-secret"); err != nil {
		t.Fatal(err)
	}
	credentials, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Key != "environment-secret" || credentials.Source != "OYTC_API_KEY" {
		t.Fatalf("unexpected credentials: %#v", credentials)
	}
}

func TestFingerprintDoesNotExposeKey(t *testing.T) {
	key := "this-is-a-secret-key"
	fingerprint := Fingerprint(key)
	if !strings.HasPrefix(fingerprint, "sha256:") || strings.Contains(fingerprint, key) || len(fingerprint) != len("sha256:")+12 {
		t.Fatalf("unsafe fingerprint %q", fingerprint)
	}
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

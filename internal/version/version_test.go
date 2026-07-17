package version

import (
	"runtime"
	"testing"
)

func TestGetDefaults(t *testing.T) {
	info := Get()
	if info.Version == "" {
		t.Fatal("version is empty")
	}
	if info.GoVersion != runtime.Version() {
		t.Fatalf("goVersion = %q", info.GoVersion)
	}
	if info.OS != runtime.GOOS || info.Arch != runtime.GOARCH {
		t.Fatalf("platform = %s/%s", info.OS, info.Arch)
	}
}

func TestGetUsesInjectedValues(t *testing.T) {
	oldVersion, oldCommit, oldDate := Version, Commit, Date
	t.Cleanup(func() { Version, Commit, Date = oldVersion, oldCommit, oldDate })
	Version, Commit, Date = "v9.9.9", "abcdef1", "2026-01-02T03:04:05Z"
	info := Get()
	if info.Version != "v9.9.9" || info.Commit != "abcdef1" || info.Date != "2026-01-02T03:04:05Z" {
		t.Fatalf("info = %#v", info)
	}
}

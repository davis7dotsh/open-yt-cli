//go:build !windows

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLoadRejectsFIFOWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OYTC_CONFIG_DIR", dir)
	t.Setenv("OYTC_API_KEY", "")
	path := filepath.Join(dir, "auth.json")
	if err := unix.Mkfifo(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("Load FIFO error = %v", err)
	}
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeNamedPipe == 0 {
		t.Fatalf("test path is not a FIFO: %v, %v", info, err)
	}
}

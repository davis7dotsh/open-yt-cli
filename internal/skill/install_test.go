package skill

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestInstallFSWritesAndReplacesCompleteSkill(t *testing.T) {
	target := filepath.Join(t.TempDir(), ".agents", "skills", "oytc")
	source := fstest.MapFS{
		"SKILL.md":               {Data: []byte("updated skill")},
		"references/commands.md": {Data: []byte("commands")},
		"references/recipes.md":  {Data: []byte("recipes")},
	}

	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "stale.md"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installFS(source, target); err != nil {
		t.Fatal(err)
	}

	for name, want := range map[string]string{
		"SKILL.md":               "updated skill",
		"references/commands.md": "commands",
		"references/recipes.md":  "recipes",
	} {
		got, err := os.ReadFile(filepath.Join(target, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if string(got) != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(target, "stale.md")); !os.IsNotExist(err) {
		t.Fatalf("stale file survived replacement: %v", err)
	}
	entries, err := filepath.Glob(filepath.Join(filepath.Dir(target), ".oytc-*-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestBundledSkillIsComplete(t *testing.T) {
	for _, name := range files {
		info, err := fs.Stat(skillbundleFS(), name)
		if err != nil {
			t.Fatalf("bundled %s: %v", name, err)
		}
		if info.Size() == 0 {
			t.Fatalf("bundled %s is empty", name)
		}
	}
}

func skillbundleFS() fs.FS {
	return bundledFiles
}

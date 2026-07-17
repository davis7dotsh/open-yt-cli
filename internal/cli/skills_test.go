package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillsInstallRequiresConfirmationAndWritesBundle(t *testing.T) {
	app, out, errOut := testApp(nil)
	target := filepath.Join(t.TempDir(), ".agents", "skills", "oytc")
	app.SkillInstallPath = target
	app.In = strings.NewReader("yes\n")

	if err := execute(t, app, "skills", "install"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut.String(), target) || !strings.Contains(errOut.String(), "Permission requested") {
		t.Fatalf("confirmation did not show path and permission: %s", errOut.String())
	}
	content, err := os.ReadFile(filepath.Join(target, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(content, []byte("Query public YouTube data")) {
		t.Fatalf("installed unexpected skill: %s", content)
	}
	for _, name := range []string{"references/commands.md", "references/recipes.md"} {
		if _, err := os.Stat(filepath.Join(target, filepath.FromSlash(name))); err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
	}
	if !strings.Contains(out.String(), "Installed oytc agent skill") {
		t.Fatalf("missing success output: %s", out.String())
	}
}

func TestSkillsInstallDeclineMakesNoChanges(t *testing.T) {
	app, out, _ := testApp(nil)
	target := filepath.Join(t.TempDir(), ".agents", "skills", "oytc")
	app.SkillInstallPath = target
	app.In = strings.NewReader("no\n")

	if err := execute(t, app, "skill", "install"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("declined install changed target: %v", err)
	}
	if !strings.Contains(out.String(), "cancelled") {
		t.Fatalf("missing cancellation output: %s", out.String())
	}
}

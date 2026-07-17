// Package skill installs the bundled oytc agent skill.
package skill

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	skillbundle "open-yt-cli/skills/oytc"
)

var bundledFiles fs.FS = skillbundle.Files

var files = []string{
	"SKILL.md",
	"references/commands.md",
	"references/recipes.md",
}

// DefaultPath returns the conventional cross-agent skill destination.
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, ".agents", "skills", "oytc"), nil
}

// Install atomically replaces target with the skill embedded in this binary.
func Install(target string) error {
	return installFS(bundledFiles, target)
}

func installFS(source fs.FS, target string) error {
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create skills directory: %w", err)
	}

	stage, err := os.MkdirTemp(parent, ".oytc-install-*")
	if err != nil {
		return fmt.Errorf("stage skill installation: %w", err)
	}
	defer os.RemoveAll(stage)
	if err := os.Chmod(stage, 0o755); err != nil {
		return err
	}

	for _, name := range files {
		content, err := fs.ReadFile(source, name)
		if err != nil {
			return fmt.Errorf("read bundled %s: %w", name, err)
		}
		destination := filepath.Join(stage, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return fmt.Errorf("create skill references directory: %w", err)
		}
		if err := os.WriteFile(destination, content, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
	}

	backup := ""
	if _, err := os.Lstat(target); err == nil {
		backupDir, err := os.MkdirTemp(parent, ".oytc-backup-*")
		if err != nil {
			return fmt.Errorf("prepare existing skill backup: %w", err)
		}
		if err := os.Remove(backupDir); err != nil {
			return err
		}
		backup = backupDir
		if err := os.Rename(target, backup); err != nil {
			return fmt.Errorf("move existing skill aside: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect existing skill: %w", err)
	}

	if err := os.Rename(stage, target); err != nil {
		if backup != "" {
			_ = os.Rename(backup, target)
		}
		return fmt.Errorf("install skill: %w", err)
	}
	if backup != "" {
		if err := os.RemoveAll(backup); err != nil {
			return fmt.Errorf("remove replaced skill: %w", err)
		}
	}
	return nil
}

// Package config manages oytc's API-key configuration.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const envKey = "OYTC_API_KEY"

type File struct {
	APIKey string `json:"api_key"`
}

type Credentials struct {
	Key    string
	Source string
	Path   string
}

func Dir() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("OYTC_CONFIG_DIR")); dir != "" {
		return expandHome(dir), nil
	}
	var dir string
	var err error
	switch runtime.GOOS {
	case "darwin":
		dir, err = os.UserHomeDir()
		if err == nil {
			dir = filepath.Join(dir, "Library", "Application Support", "oytc")
		}
	case "windows":
		dir = os.Getenv("APPDATA")
		if dir == "" {
			err = errors.New("APPDATA is not set")
		} else {
			dir = filepath.Join(dir, "oytc")
		}
	default:
		dir = os.Getenv("XDG_CONFIG_HOME")
		if dir == "" {
			dir, err = os.UserHomeDir()
			if err == nil {
				dir = filepath.Join(dir, ".config")
			}
		}
		dir = filepath.Join(dir, "oytc")
	}
	if err != nil {
		return "", fmt.Errorf("determine config directory: %w", err)
	}
	return dir, nil
}

func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "auth.json"), nil
}

func Load() (Credentials, error) {
	path, err := Path()
	if err != nil {
		return Credentials{}, err
	}
	if key := strings.TrimSpace(os.Getenv(envKey)); key != "" {
		return Credentials{Key: key, Source: envKey, Path: path}, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{Path: path}, nil
	}
	if err != nil {
		return Credentials{Path: path}, fmt.Errorf("read credentials: %w", err)
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		return Credentials{Path: path}, fmt.Errorf("parse credentials: %w", err)
	}
	file.APIKey = strings.TrimSpace(file.APIKey)
	if file.APIKey == "" {
		return Credentials{Path: path}, errors.New("credential file contains an empty API key")
	}
	return Credentials{Key: file.APIKey, Source: "auth.json", Path: path}, nil
}

func Save(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "", errors.New("API key cannot be empty")
	}
	path, err := Path()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create config directory: %w", err)
	}
	_ = os.Chmod(dir, 0o700)
	data, err := json.MarshalIndent(File{APIKey: key}, "", "  ")
	if err != nil {
		return "", err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(dir, ".auth-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temporary credential file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", fmt.Errorf("secure temporary credential file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return "", fmt.Errorf("write credentials: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", fmt.Errorf("sync credentials: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := replaceFile(tmpName, path); err != nil {
		return "", fmt.Errorf("install credentials: %w", err)
	}
	_ = os.Chmod(path, 0o600)
	return path, nil
}

func Remove() (string, bool, error) {
	path, err := Path()
	if err != nil {
		return "", false, err
	}
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return path, false, nil
		}
		return path, false, fmt.Errorf("remove credentials: %w", err)
	}
	return path, true, nil
}

func Fingerprint(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	return "sha256:" + hex.EncodeToString(sum[:])[:12]
}

func EnvKeySet() bool { return strings.TrimSpace(os.Getenv(envKey)) != "" }

func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			if len(path) == 1 {
				return home
			}
			return filepath.Join(home, path[2:])
		}
	}
	return path
}

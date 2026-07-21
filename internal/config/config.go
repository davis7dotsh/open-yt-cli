// Package config manages oytc's API-key and OAuth configuration.
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

const (
	envKey               = "OYTC_API_KEY"
	envOAuthClientID     = "OYTC_OAUTH_CLIENT_ID"
	envOAuthClientSecret = "OYTC_OAUTH_CLIENT_SECRET"
)

type File struct {
	APIKey string            `json:"api_key,omitempty"`
	OAuth  *OAuthCredentials `json:"oauth,omitempty"`
}

type OAuthCredentials struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	Expiry       string   `json:"expiry"`
	Scopes       []string `json:"scopes"`
}

type Credentials struct {
	Key    string
	Source string
	OAuth  *OAuthCredentials
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
	file, exists, err := loadFile(path)
	if err != nil {
		// A corrupt or unreadable auth.json must not block the
		// higher-precedence environment key.
		if key := strings.TrimSpace(os.Getenv(envKey)); key != "" {
			return Credentials{Key: key, Source: envKey, Path: path}, nil
		}
		return Credentials{Path: path}, err
	}
	credentials := Credentials{Path: path}
	if exists {
		credentials.Key = strings.TrimSpace(file.APIKey)
		credentials.OAuth = cloneOAuth(file.OAuth)
		if credentials.Key != "" {
			credentials.Source = "auth.json"
		}
	}
	if key := strings.TrimSpace(os.Getenv(envKey)); key != "" {
		credentials.Key = key
		credentials.Source = envKey
	}
	return credentials, nil
}

// OAuthBootstrap returns environment credentials used only to bootstrap `login --oauth`.
// Each variable independently avoids its corresponding prompt, analogous to OYTC_API_KEY's
// environment-first behavior. Authorized tokens are still loaded from auth.json.
func OAuthBootstrap() (clientID, clientSecret string) {
	return strings.TrimSpace(os.Getenv(envOAuthClientID)), strings.TrimSpace(os.Getenv(envOAuthClientSecret))
}

func Save(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "", errors.New("API key cannot be empty")
	}
	return updateFile(func(file *File) { file.APIKey = key })
}

func SaveOAuth(credentials OAuthCredentials) (string, error) {
	if err := normalizeOAuth(&credentials); err != nil {
		return "", err
	}
	return updateFile(func(file *File) { file.OAuth = cloneOAuth(&credentials) })
}

// SaveRefreshedOAuth persists a token refresh only if the stored authorization
// is still the one that was refreshed. This prevents a refresh that began
// before logout (or a new login) from restoring obsolete credentials.
func SaveRefreshedOAuth(expected, credentials OAuthCredentials) (bool, error) {
	if err := normalizeOAuth(&credentials); err != nil {
		return false, err
	}
	path, err := Path()
	if err != nil {
		return false, err
	}
	unlock, err := acquireUpdateLock(path)
	if err != nil {
		return false, err
	}
	defer unlock()
	file, _, err := loadFile(path)
	if err != nil {
		return false, err
	}
	if !sameOAuth(file.OAuth, &expected) {
		return false, nil
	}
	_, err = saveFile(path, File{APIKey: file.APIKey, OAuth: cloneOAuth(&credentials)})
	return err == nil, err
}

func ClearAPIKey() (string, error) {
	return updateFile(func(file *File) { file.APIKey = "" })
}

func ClearOAuth() (string, error) {
	return updateFile(func(file *File) { file.OAuth = nil })
}

func Remove() (string, bool, error) {
	path, err := Path()
	if err != nil {
		return "", false, err
	}
	// Take the same lock as saves: a concurrent save that already read the
	// file must not be able to recreate credentials after removal.
	unlock, err := acquireUpdateLock(path)
	if err != nil {
		return "", false, err
	}
	defer unlock()
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

func EnvOAuthClientIDSet() bool {
	return strings.TrimSpace(os.Getenv(envOAuthClientID)) != ""
}

func EnvOAuthClientSecretSet() bool {
	return strings.TrimSpace(os.Getenv(envOAuthClientSecret)) != ""
}

func updateFile(update func(*File)) (string, error) {
	path, err := Path()
	if err != nil {
		return "", err
	}
	// Serialize the read-modify-write across processes with an exclusive
	// advisory lock on a sidecar file; the atomic rename alone cannot
	// prevent one concurrent update from silently overwriting another
	// (e.g. a token refresh racing an API-key save).
	unlock, err := acquireUpdateLock(path)
	if err != nil {
		return "", err
	}
	defer unlock()
	file, _, err := loadFile(path)
	if err != nil {
		return "", err
	}
	update(&file)
	return saveFile(path, file)
}

func acquireUpdateLock(path string) (func(), error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create config directory: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(dir, ".auth.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open credential lock file: %w", err)
	}
	if err := lockFile(lock); err != nil {
		lock.Close()
		return nil, fmt.Errorf("lock credential file: %w", err)
	}
	return func() {
		_ = unlockFile(lock)
		lock.Close()
	}, nil
}

func loadFile(path string) (File, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{}, false, nil
	}
	if err != nil {
		return File{}, false, fmt.Errorf("read credentials: %w", err)
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		return File{}, true, fmt.Errorf("parse credentials: %w", err)
	}
	return file, true, nil
}

func saveFile(path string, file File) (string, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create config directory: %w", err)
	}
	_ = os.Chmod(dir, 0o700)
	data, err := json.MarshalIndent(file, "", "  ")
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

func normalizeOAuth(credentials *OAuthCredentials) error {
	credentials.ClientID = strings.TrimSpace(credentials.ClientID)
	credentials.ClientSecret = strings.TrimSpace(credentials.ClientSecret)
	credentials.AccessToken = strings.TrimSpace(credentials.AccessToken)
	credentials.RefreshToken = strings.TrimSpace(credentials.RefreshToken)
	credentials.Expiry = strings.TrimSpace(credentials.Expiry)
	if credentials.ClientID == "" || credentials.ClientSecret == "" {
		return errors.New("OAuth client ID and client secret cannot be empty")
	}
	if credentials.AccessToken == "" && credentials.RefreshToken == "" {
		return errors.New("OAuth access token or refresh token is required")
	}
	return nil
}

func sameOAuth(left, right *OAuthCredentials) bool {
	if left == nil || right == nil {
		return left == right
	}
	if left.ClientID != right.ClientID || left.ClientSecret != right.ClientSecret || left.AccessToken != right.AccessToken || left.RefreshToken != right.RefreshToken || left.Expiry != right.Expiry || len(left.Scopes) != len(right.Scopes) {
		return false
	}
	for i, scope := range left.Scopes {
		if scope != right.Scopes[i] {
			return false
		}
	}
	return true
}

func cloneOAuth(credentials *OAuthCredentials) *OAuthCredentials {
	if credentials == nil {
		return nil
	}
	copy := *credentials
	copy.Scopes = append([]string(nil), credentials.Scopes...)
	return &copy
}

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

package mcpauth

import "testing"

func TestLocalPath(t *testing.T) {
	for path, want := range map[string]bool{
		"/console":                 true,
		"/authorize?client_id=x&a": true,
		"":                         false,
		"console":                  false,
		"//evil.example":           false,
		"/\\evil.example":          false,
		"/\t/evil.example":         false,
		"https://evil.example":     false,
	} {
		if got := localPath(path); got != want {
			t.Errorf("localPath(%q) = %v, want %v", path, got, want)
		}
	}
}

package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"open-yt-cli/internal/youtube"
)

func TestFiniteListsPreservePartialResponseFields(t *testing.T) {
	tests := []struct {
		name     string
		resource string
		args     []string
	}{
		{"categories", "videoCategories", []string{"category", "list", "--region", "US"}},
		{"languages", "i18nLanguages", []string{"language", "list"}},
		{"regions", "i18nRegions", []string{"region", "list"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
			t.Setenv("OYTC_API_KEY", "key")
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != "/youtube/v3/"+test.resource {
					t.Errorf("path = %q", r.URL.Path)
				}
				if fields := r.URL.Query().Get("fields"); fields != "items(id)" {
					t.Errorf("fields = %q, want items(id)", fields)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				_, _ = w.Write([]byte(`{"items":[{"id":"one"}]}`))
			}))
			defer server.Close()

			app, out, _ := testApp(server)
			args := append(append([]string{}, test.args...), "--fields", "items(id)", "--format", "json")
			if err := execute(t, app, args...); err != nil {
				t.Fatal(err)
			}
			var result youtube.ListResult
			if err := json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if requests != 1 || !reflect.DeepEqual(result.Items, []map[string]any{{"id": "one"}}) {
				t.Fatalf("requests = %d, result = %#v", requests, result)
			}
		})
	}
}

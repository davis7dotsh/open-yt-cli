package cli

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"open-yt-cli/internal/youtube"
)

func TestCustomEndpointDerivesEveryURL(t *testing.T) {
	tests := []struct {
		name, env, base string
	}{
		{"unset", "", ""},
		{"origin", "https://mirror.test", "https://mirror.test"},
		{"trailing slashes and spaces", " http://mirror.test:8080// ", "http://mirror.test:8080"},
		{"path prefix", "https://mirror.test/yt/", "https://mirror.test/yt"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("YOUTUBE_API_BASE_URL", test.env)
			app := New()
			if app.endpointErr != nil {
				t.Fatal(app.endpointErr)
			}
			got := []string{app.CustomEndpoint, app.BaseURL, app.AnalyticsBaseURL, app.OAuthAuthURL, app.OAuthTokenURL, app.OAuthRevokeURL}
			want := []string{"", youtube.DefaultBaseURL, "", "", "", ""}
			if test.base != "" {
				want = []string{test.base, test.base + "/youtube/v3", test.base + "/v2", test.base + "/o/oauth2/v2/auth", test.base + "/token", test.base + "/revoke"}
			}
			if strings.Join(got, " ") != strings.Join(want, " ") {
				t.Fatalf("endpoints = %q, want %q", got, want)
			}
		})
	}
}

func TestInvalidCustomEndpointIsUsageError(t *testing.T) {
	for _, value := range []string{"mirror.test", "ftp://mirror.test", "https://mirror.test/?key=x", "https://user:pass@mirror.test"} {
		t.Setenv("YOUTUBE_API_BASE_URL", value)
		app, _, _ := testApp(nil)
		var usage *UsageError
		if err := execute(t, app, "version"); !errors.As(err, &usage) || !strings.Contains(err.Error(), "YOUTUBE_API_BASE_URL") {
			t.Fatalf("%q: err = %v", value, err)
		}
	}
}

// A yt-mirror-shaped server: one origin, Google's paths, and a consent
// endpoint that redirects straight back with a code.
func TestCustomEndpointLoginStatusAndReadsUseOneOrigin(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/o/oauth2/v2/auth":
			callback, _ := url.Parse(r.URL.Query().Get("redirect_uri"))
			callback.RawQuery = url.Values{"code": {"mirror-code"}, "state": {r.URL.Query().Get("state")}}.Encode()
			http.Redirect(w, r, callback.String(), http.StatusFound)
		case "/token":
			if err := r.ParseForm(); err != nil || r.Form.Get("client_secret") != "mirror-key" {
				t.Errorf("token form = %v, %v", r.Form, err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"mirror-access","refresh_token":"mirror-refresh","expires_in":3600,"token_type":"Bearer","scope":"https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly"}`))
		case "/youtube/v3/channels":
			if r.Header.Get("Authorization") != "Bearer mirror-access" {
				t.Errorf("authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"items":[{"id":"UCQPuk2FgKQj1ggJKeIMuPew","snippet":{"title":"Mirror Dev"}}]}`))
		case "/v2/reports":
			_, _ = w.Write([]byte(`{"columnHeaders":[{"name":"views"}],"rows":[[42]]}`))
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	t.Setenv("OYTC_CONFIG_DIR", dir)
	t.Setenv("OYTC_API_KEY", "")
	t.Setenv("OYTC_OAUTH_CLIENT_ID", "anything")
	t.Setenv("OYTC_OAUTH_CLIENT_SECRET", "mirror-key")
	t.Setenv("YOUTUBE_API_BASE_URL", server.URL+"/")

	run := func(args ...string) string {
		t.Helper()
		out := &bytes.Buffer{}
		app := New()
		app.In, app.Out, app.Err = bytes.NewBuffer(nil), out, &bytes.Buffer{}
		app.HTTPClient = server.Client()
		app.IsOutputTTY = false
		if err := execute(t, app, args...); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return out.String()
	}
	run("login", "--oauth")
	status := run("status")
	host := strings.ReplaceAll(strings.TrimPrefix(server.URL, "http://"), ":", "_")
	if !strings.Contains(status, `"endpoint": "`+server.URL+`"`) || !strings.Contains(status, filepath.Join(dir, "auth."+host+".json")) {
		t.Fatalf("status = %s", status)
	}
	if out := run("channel", "get", "UCQPuk2FgKQj1ggJKeIMuPew"); !strings.Contains(out, "Mirror Dev") {
		t.Fatalf("channel get = %s", out)
	}
	if out := run("analytics", "overview"); !strings.Contains(out, "42") {
		t.Fatalf("analytics = %s", out)
	}
	want := "/o/oauth2/v2/auth /token /youtube/v3/channels /v2/reports"
	if got := strings.Join(paths, " "); got != want {
		t.Fatalf("paths = %q, want %q", got, want)
	}
}

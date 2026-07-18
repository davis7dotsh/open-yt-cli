package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"open-yt-cli/internal/config"
	"open-yt-cli/internal/youtube"
)

func TestLoginValidatesAndAtomicallySaves(t *testing.T) {
	var requestKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestKey = r.Header.Get("X-Goog-Api-Key")
		if r.URL.Path != "/youtube/v3/i18nLanguages" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"en"}]}`))
	}))
	defer server.Close()
	dir := t.TempDir()
	t.Setenv("OYTC_CONFIG_DIR", dir)
	t.Setenv("OYTC_API_KEY", "")
	app, out, _ := testApp(server)
	app.ReadSecret = func() (string, error) { return "login-secret", nil }
	if err := execute(t, app, "login"); err != nil {
		t.Fatal(err)
	}
	if requestKey != "login-secret" {
		t.Fatalf("validation header = %q", requestKey)
	}
	credentials, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Key != "login-secret" {
		t.Fatalf("saved key = %q", credentials.Key)
	}
	if bytes.Contains(out.Bytes(), []byte("login-secret")) {
		t.Fatalf("key leaked in output: %s", out.String())
	}
}

func TestOAuthLoginLoopbackSavesWithoutClobberingAPIKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OYTC_CONFIG_DIR", dir)
	t.Setenv("OYTC_API_KEY", "")
	t.Setenv("OYTC_OAUTH_CLIENT_ID", "desktop-id")
	t.Setenv("OYTC_OAUTH_CLIENT_SECRET", "desktop-secret")
	if _, err := config.Save("existing-key"); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/token" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("code") != "login-code" || r.Form.Get("client_secret") != "desktop-secret" {
			t.Errorf("token form = %v", r.Form)
		}
		_, _ = w.Write([]byte(`{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"scope":"https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly"}`))
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	app.OpenBrowser = func(target string) error {
		parsed, err := url.Parse(target)
		if err != nil {
			return err
		}
		callback := parsed.Query().Get("redirect_uri") + "?code=login-code&state=" + url.QueryEscape(parsed.Query().Get("state"))
		go func() {
			response, err := http.Get(callback)
			if err == nil {
				response.Body.Close()
			}
		}()
		return nil
	}
	if err := execute(t, app, "login", "--oauth"); err != nil {
		t.Fatal(err)
	}
	credentials, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Key != "existing-key" || credentials.OAuth == nil || credentials.OAuth.RefreshToken != "refresh-secret" {
		t.Fatalf("credentials = %#v", credentials)
	}
	for _, secret := range []string{"desktop-secret", "access-secret", "refresh-secret"} {
		if bytes.Contains(out.Bytes(), []byte(secret)) {
			t.Fatalf("OAuth secret leaked in output: %s", out.String())
		}
	}
}

func TestAnalyticsCommands(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	if _, err := config.SaveOAuth(config.OAuthCredentials{
		ClientID: "id", ClientSecret: "secret", AccessToken: "oauth-access", RefreshToken: "oauth-refresh",
		Expiry: "2099-01-01T00:00:00Z", Scopes: []string{youtubeReadonlyScope, analyticsReadonlyScope},
	}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		args       []string
		metrics    string
		dimensions string
		filters    string
	}{
		{"report", []string{"analytics", "report", "--metrics", "views,likes", "--dimensions", "day"}, "views,likes", "day", ""},
		{"overview", []string{"analytics", "overview", "--by", "month"}, "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained", "month", ""},
		{"video", []string{"analytics", "video", "video-id"}, "views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained", "", "video==video-id"},
		{"traffic", []string{"analytics", "traffic-sources"}, "views,estimatedMinutesWatched", "insightTrafficSourceType", ""},
		{"demographics", []string{"analytics", "demographics"}, "viewerPercentage", "ageGroup,gender", ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/youtubeanalytics/v2/reports" || r.Header.Get("Authorization") != "Bearer oauth-access" {
					t.Errorf("request = %s, authorization = %q", r.URL.Path, r.Header.Get("Authorization"))
				}
				query := r.URL.Query()
				if query.Get("ids") != "channel==MINE" || query.Get("metrics") != test.metrics || query.Get("dimensions") != test.dimensions || query.Get("filters") != test.filters {
					t.Errorf("query = %s", r.URL.RawQuery)
				}
				_, _ = w.Write([]byte(`{"columnHeaders":[{"name":"views"}],"rows":[[42]]}`))
			}))
			defer server.Close()
			app, out, _ := testApp(server)
			args := append(append([]string(nil), test.args...), "--start", "2026-01-01", "--end", "2026-01-28", "--format", "json")
			if err := execute(t, app, args...); err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(out.Bytes(), []byte(`"views": 42`)) {
				t.Fatalf("output = %s", out.String())
			}
		})
	}
}

func TestAnalyticsRequiresOAuthAndValidDates(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	app, _, _ := testApp(nil)
	err := execute(t, app, "analytics", "report", "--metrics", "views", "--start", "not-a-date")
	var usage *UsageError
	if !errors.As(err, &usage) {
		t.Fatalf("expected UsageError, got %T: %v", err, err)
	}
	err = execute(t, app, "analytics", "report", "--metrics", "views", "--start", "2026-01-01", "--end", "2026-01-28")
	if !errors.Is(err, youtube.ErrMissingOAuth) || !bytes.Contains([]byte(err.Error()), []byte("login --oauth")) {
		t.Fatalf("expected missing OAuth hint, got %T: %v", err, err)
	}
}

func TestStatusHidesOAuthSecretsAndLogoutRevokes(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	if _, err := config.SaveOAuth(config.OAuthCredentials{
		ClientID: "visible-client-id", ClientSecret: "hidden-client-secret", AccessToken: "hidden-access-token",
		RefreshToken: "hidden-refresh-token", Expiry: "2099-01-01T00:00:00Z", Scopes: []string{analyticsReadonlyScope},
	}); err != nil {
		t.Fatal(err)
	}
	var revoked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/revoke" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		revoked = r.Form.Get("token")
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "status", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte("visible-client-id")) {
		t.Fatalf("status omitted client ID: %s", out.String())
	}
	for _, secret := range []string{"hidden-client-secret", "hidden-access-token", "hidden-refresh-token"} {
		if bytes.Contains(out.Bytes(), []byte(secret)) {
			t.Fatalf("status leaked OAuth secret: %s", out.String())
		}
	}
	app, _, _ = testApp(server)
	if err := execute(t, app, "logout"); err != nil {
		t.Fatal(err)
	}
	if revoked != "hidden-refresh-token" {
		t.Fatalf("revoked token = %q", revoked)
	}
	credentials, err := config.Load()
	if err != nil || credentials.OAuth != nil {
		t.Fatalf("credentials after logout = %#v, %v", credentials, err)
	}
}

func TestSearchRequestAndPagination(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "search-secret")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		if r.Header.Get("X-Goog-Api-Key") != "search-secret" {
			t.Errorf("missing key header")
		}
		if r.URL.Query().Get("key") != "" {
			t.Errorf("key leaked in query")
		}
		if r.URL.Query().Get("q") != "go testing" || r.URL.Query().Get("type") != "video" || r.URL.Query().Get("regionCode") != "CA" {
			t.Errorf("unexpected query: %s", r.URL.RawQuery)
		}
		if request == 1 {
			_, _ = w.Write([]byte(`{"items":[{"id":{"videoId":"a"}}],"nextPageToken":"p2"}`))
		} else {
			if r.URL.Query().Get("pageToken") != "p2" {
				t.Errorf("page token = %q", r.URL.Query().Get("pageToken"))
			}
			_, _ = w.Write([]byte(`{"items":[{"id":{"videoId":"b"}}]}`))
		}
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	err := execute(t, app, "search", "go testing", "--type", "video", "--region", "CA", "--all", "--format", "json")
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Items    []map[string]any `json:"items"`
		Requests int              `json:"requests"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.Requests != 2 {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestVideoTrainabilityRequiresNoKeyAndSendsNone(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Goog-Api-Key") != "" || r.URL.Query().Get("key") != "" {
			t.Errorf("trainability sent a key")
		}
		if r.URL.Query().Get("id") != "video123" {
			t.Errorf("id = %q", r.URL.Query().Get("id"))
		}
		_, _ = w.Write([]byte(`{"kind":"youtube#videoTrainability","videoId":"video123","permitted":["none"]}`))
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "video", "trainability", "video123", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"videoId": "video123"`)) {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestChannelUploadsResolvesPlaylistAndListsItems(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	channelID := "UC1234567890123456789012"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/youtube/v3/channels":
			if r.URL.Query().Get("id") != channelID || r.URL.Query().Get("part") != "contentDetails" {
				t.Errorf("channel query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"relatedPlaylists":{"uploads":"UUuploads"}}}]}`))
		case "/youtube/v3/playlistItems":
			if r.URL.Query().Get("playlistId") != "UUuploads" {
				t.Errorf("playlist query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"videoId":"v1"}}]}`))
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "channel", "uploads", channelID, "--format", "json"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"videoId": "v1"`)) {
		t.Fatalf("unexpected output: %s", out.String())
	}
}

func TestLiveChatStreamPollsWithTokenAndDeduplicates(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		if request == 1 {
			_, _ = w.Write([]byte(`{"items":[{"id":"a","snippet":{"displayMessage":"first"}}],"nextPageToken":"resume","pollingIntervalMillis":1}`))
			return
		}
		if r.URL.Query().Get("pageToken") != "resume" {
			t.Errorf("page token = %q", r.URL.Query().Get("pageToken"))
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"a"},{"id":"b","snippet":{"displayMessage":"second"}}],"nextPageToken":"done","offlineAt":"2025-01-01T00:00:00Z"}`))
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "live-chat", "stream", "--chat-id", "chat", "--format", "jsonl", "--page-size", "200"); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d", requests.Load())
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(lines) != 2 || bytes.Count(out.Bytes(), []byte(`"id":"a"`)) != 1 || bytes.Count(out.Bytes(), []byte(`"id":"b"`)) != 1 {
		t.Fatalf("unexpected stream: %s", out.String())
	}
}

func TestCommentThreadsRejectsIncompatibleFiltersWithoutRequest(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected request") }))
	defer server.Close()
	app, _, _ := testApp(server)
	err := execute(t, app, "comment", "threads", "--video", "v", "--channel", "c")
	var usage *UsageError
	if err == nil || !errors.As(err, &usage) {
		t.Fatalf("expected UsageError, got %T: %v", err, err)
	}
}

func TestStatusIsLocalOnlyByDefault(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OYTC_CONFIG_DIR", dir)
	t.Setenv("OYTC_API_KEY", "ephemeral-secret")
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("status made a remote request") }))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "status", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out.Bytes(), []byte("ephemeral-secret")) || !bytes.Contains(out.Bytes(), []byte("sha256:")) {
		t.Fatalf("unsafe status output: %s", out.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("status changed config: %v", err)
	}
}

func execute(t *testing.T, app *App, args ...string) error {
	t.Helper()
	root := app.Root()
	root.SetArgs(args)
	return root.ExecuteContext(t.Context())
}

func testApp(server *httptest.Server) (*App, *bytes.Buffer, *bytes.Buffer) {
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	app := New()
	app.In = bytes.NewBuffer(nil)
	app.Out = out
	app.Err = errOut
	if server != nil {
		app.BaseURL = server.URL + "/youtube/v3"
		app.AnalyticsBaseURL = server.URL + "/youtubeanalytics/v2"
		app.OAuthAuthURL = server.URL + "/authorize"
		app.OAuthTokenURL = server.URL + "/token"
		app.OAuthRevokeURL = server.URL + "/revoke"
		app.HTTPClient = server.Client()
	}
	app.IsOutputTTY = false
	return app, out, errOut
}

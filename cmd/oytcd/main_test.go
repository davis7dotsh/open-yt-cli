package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/mcptools"
	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/store"
)

func TestLoadConfig(t *testing.T) {
	_, err := loadConfig(func(string) string { return "" })
	for _, name := range []string{"OYTCD_BASE_URL", "OYTCD_SECRET_KEY", "OYTCD_GOOGLE_CLIENT_ID", "OYTCD_GOOGLE_CLIENT_SECRET", "OYTCD_YOUTUBE_API_KEY", "OYTCD_ALLOWED_EMAILS"} {
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("empty env error %v does not mention %s", err, name)
		}
	}

	env := map[string]string{
		"OYTCD_BASE_URL":             "https://oytc.example/",
		"OYTCD_SECRET_KEY":           base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)),
		"OYTCD_GOOGLE_CLIENT_ID":     "id",
		"OYTCD_GOOGLE_CLIENT_SECRET": "secret",
		"OYTCD_YOUTUBE_API_KEY":      "key",
		"OYTCD_ALLOWED_EMAILS":       " Ben@Example.com, ,other@example.com",
	}
	cfg, err := loadConfig(func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "https://oytc.example" || cfg.DBPath != "/data/oytcd.db" || cfg.Port != "8080" || len(cfg.SecretKey) != 32 ||
		!slices.Equal(cfg.AllowedEmails, []string{"ben@example.com", "other@example.com"}) {
		t.Fatalf("config = %+v", cfg)
	}

	env["OYTCD_SECRET_KEY"] = base64.StdEncoding.EncodeToString([]byte("short"))
	env["OYTCD_BASE_URL"] = "https://oytc.example/app"
	_, err = loadConfig(func(name string) string { return env[name] })
	if err == nil || !strings.Contains(err.Error(), "OYTCD_SECRET_KEY must") || !strings.Contains(err.Error(), "OYTCD_BASE_URL must") {
		t.Fatalf("invalid env error = %v", err)
	}
}

const (
	youtubeScope   = "https://www.googleapis.com/auth/youtube.readonly"
	analyticsScope = "https://www.googleapis.com/auth/yt-analytics.readonly"
)

func TestEndToEnd(t *testing.T) {
	ctx := context.Background()
	google := newFakeGoogle(t)
	clock := &fakeClock{now: time.Now()}
	st, err := store.Open(filepath.Join(t.TempDir(), "oytcd.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	srv := httptest.NewUnstartedServer(nil)
	base := "http://" + srv.Listener.Addr().String()
	handler, con, err := newHandler(config{
		BaseURL: base, SecretKey: bytes.Repeat([]byte{1}, 32),
		GoogleClientID: "client", GoogleClientSecret: "secret", YouTubeAPIKey: "yt-key",
		AllowedEmails: []string{"ben@example.com"},
		GoogleAuthURL: google.URL + "/auth", GoogleTokenURL: google.URL + "/token",
		GoogleRevokeURL: google.URL + "/revoke", GoogleUserInfoURL: google.URL + "/userinfo",
		YouTubeBaseURL: google.URL + "/youtube/v3", AnalyticsBaseURL: google.URL + "/analytics/v2",
		HTTPClient: google.Client(), Now: clock.Now,
	}, st)
	if err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = handler
	srv.Start()
	defer srv.Close()
	endpoint := base + "/mcp"

	ben := newBrowser(t, base)
	if status, _, body := ben.do("GET", "/healthz", nil); status != 200 || body != "ok" {
		t.Fatalf("healthz = %d %q", status, body)
	}
	if status, _, body := ben.do("GET", "/", nil); status != 200 || !strings.Contains(body, `href="/auth/google"`) {
		t.Fatalf("landing = %d", status)
	}
	if status, location, _ := ben.do("GET", "/console", nil); status != 302 || location != "/auth/google?return_to=%2Fconsole" {
		t.Fatalf("signed-out console = %d %q", status, location)
	}

	// Sign in; the allowlist ignores case.
	status, location, _ := ben.do("GET", "/auth/google?return_to=/console", nil)
	consent := mustQuery(t, location)
	if status != 302 || consent.Get("scope") != "openid email" || consent.Get("prompt") != "select_account" || consent.Get("access_type") != "online" {
		t.Fatalf("sign-in redirect = %d %q", status, location)
	}
	if status, location, _ := ben.do("GET", callback(t, location, "signin:Ben@Example.com"), nil); status != 302 || location != "/console" {
		t.Fatalf("sign-in callback = %d %q", status, location)
	}
	if status, location, _ := ben.do("GET", "/", nil); status != 302 || location != "/console" {
		t.Fatalf("signed-in landing = %d %q", status, location)
	}

	connect := func(code string) (int, string, string) {
		t.Helper()
		status, location, _ := ben.do("POST", "/channels/connect", url.Values{})
		consent := mustQuery(t, location)
		if status != 303 || consent.Get("scope") != youtubeScope+" "+analyticsScope || consent.Get("prompt") != "consent select_account" || consent.Get("access_type") != "offline" {
			t.Fatalf("connect redirect = %d %q", status, location)
		}
		return ben.do("GET", callback(t, location, code), nil)
	}
	if status, _, body := connect("channel-partial"); status != 400 || !strings.Contains(body, "Tick both") {
		t.Fatalf("partial-scope connect = %d", status)
	}
	if status, location, _ := connect("channel"); status != 303 || location != "/console" {
		t.Fatalf("connect callback = %d %q", status, location)
	}

	// A new key is shown exactly once.
	status, _, body := ben.do("POST", "/keys", url.Values{"name": {"laptop"}})
	key := regexp.MustCompile(`oytc_k_[A-Za-z0-9_-]{43}`).FindString(body)
	if status != 200 || key == "" || !strings.Contains(body, "Test Channel") || !strings.Contains(body, "laptop") {
		t.Fatalf("create key = %d, key %q", status, key)
	}
	if _, _, body := ben.do("GET", "/console", nil); strings.Contains(body, key) || !strings.Contains(body, key[:12]) {
		t.Fatal("console must list the key prefix but never the key again")
	}
	if status := ben.crossSitePost("/keys"); status != http.StatusForbidden {
		t.Fatalf("cross-site POST = %d", status)
	}

	want := mcptools.Channel{ID: "UCtest", Title: "Test Channel", Handle: "@testchannel", Default: true, Status: "ok"}
	if got := listChannels(t, endpoint, key); !slices.Equal(got, []mcptools.Channel{want}) {
		t.Fatalf("list_channels = %+v", got)
	}
	for _, bad := range []string{"", "oytc_k_bogus"} {
		if status := mcpStatus(t, endpoint, bad); status != http.StatusUnauthorized {
			t.Fatalf("/mcp with key %q = %d", bad, status)
		}
	}

	rows, err := st.ChannelsWithStatus(ctx, store.StatusOK)
	if err != nil || len(rows) != 1 {
		t.Fatalf("channels = %v, %v", rows, err)
	}

	// MCP OAuth access tokens share the verifier and must honor expires_at.
	for token, expiresAt := range map[string]time.Time{"oytc_at_live": clock.Now().Add(time.Hour), "oytc_at_expired": clock.Now().Add(-time.Second)} {
		hash := sha256.Sum256([]byte(token))
		err := st.CreateToken(ctx, store.Token{Hash: hash[:], UserID: rows[0].UserID, Kind: store.KindAccess, Label: "client", Prefix: token[:12], ClientID: "client", ExpiresAt: expiresAt.Unix(), CreatedAt: clock.Now().Unix()})
		if err != nil {
			t.Fatal(err)
		}
	}
	if status := mcpStatus(t, endpoint, "oytc_at_live"); status != http.StatusOK {
		t.Fatalf("/mcp with live access token = %d", status)
	}
	if status := mcpStatus(t, endpoint, "oytc_at_expired"); status != http.StatusUnauthorized {
		t.Fatalf("/mcp with expired access token = %d", status)
	}
	resolver := con.Resolver(rows[0].UserID)
	report := func(channel string) error {
		client, err := resolver.Analytics(ctx, channel)
		if err != nil {
			return err
		}
		_, err = client.Report(ctx, analytics.Query{StartDate: "2026-01-01", EndDate: "2026-01-31", Metrics: []string{"views"}})
		return err
	}
	if err := report("@TestChannel"); err != nil {
		t.Fatal(err)
	}
	if err := report("UCother"); err == nil || !strings.Contains(err.Error(), "channel UCother is not connected; connect it at "+base+"/console") {
		t.Fatalf("unknown channel err = %v", err)
	}

	// Google revokes the grant: the next call marks the channel revoked and
	// says how to fix it.
	google.revoke("refresh-2")
	revoked := "Google access for Test Channel was revoked; reconnect it at " + base + "/console"
	for range 2 {
		if err := report(""); !errors.Is(err, oauth.ErrGrantRevoked) || err.Error() != revoked {
			t.Fatalf("revoked report err = %v", err)
		}
	}
	if got := listChannels(t, endpoint, key); len(got) != 1 || got[0].Status != "revoked" {
		t.Fatalf("list_channels after revoke = %+v", got)
	}

	// Reconnecting restores access with the new token.
	if status, _, _ := connect("channel"); status != 303 {
		t.Fatalf("reconnect = %d", status)
	}
	if err := report(""); err != nil {
		t.Fatalf("report after reconnect: %v", err)
	}

	// Disconnecting revokes the token with Google and clears the default.
	if status, _, _ := ben.do("POST", "/channels/UCtest/disconnect", url.Values{}); status != 303 {
		t.Fatalf("disconnect = %d", status)
	}
	if got := google.revokeCalls(); !slices.Equal(got, []string{"refresh-3"}) {
		t.Fatalf("revoked tokens = %v", got)
	}
	if err := report(""); err == nil || !strings.Contains(err.Error(), "no YouTube channel is connected") {
		t.Fatalf("report after disconnect err = %v", err)
	}

	if status, _, _ := ben.do("POST", "/keys/"+key[:12]+"/revoke", url.Values{}); status != 303 {
		t.Fatalf("revoke key = %d", status)
	}
	if status := mcpStatus(t, endpoint, key); status != http.StatusUnauthorized {
		t.Fatalf("/mcp with revoked key = %d", status)
	}

	intruder := newBrowser(t, base)
	_, location, _ = intruder.do("GET", "/auth/google", nil)
	if status, _, _ := intruder.do("GET", callback(t, location, "signin:intruder@example.com"), nil); status != http.StatusForbidden {
		t.Fatalf("disallowed sign-in = %d", status)
	}

	// Upkeep notices a revoked grant, deletes the channel after 30 days,
	// and purges the expired session.
	if status, _, _ := connect("channel"); status != 303 {
		t.Fatalf("connect again = %d", status)
	}
	google.revoke("refresh-4")
	con.Upkeep(ctx)
	if got, err := resolver.Channels(ctx); err != nil || len(got) != 1 || got[0].Status != "revoked" {
		t.Fatalf("channels after upkeep = %+v, %v", got, err)
	}
	clock.add(31 * 24 * time.Hour)
	con.Upkeep(ctx)
	if got, err := resolver.Channels(ctx); err != nil || len(got) != 0 {
		t.Fatalf("channels after 31 days = %+v, %v", got, err)
	}
	if status, _, _ := ben.do("GET", "/console", nil); status != 302 {
		t.Fatalf("console with expired session = %d", status)
	}
}

// fakeGoogle serves Google's OAuth, userinfo, YouTube Data, and Analytics
// endpoints. Authorization codes pick the outcome: "signin:<email>",
// "channel", or "channel-partial" (only youtube.readonly granted). Each
// channel grant issues refresh-N; access tokens are "access:<refresh>".
type fakeGoogle struct {
	*httptest.Server
	mu      sync.Mutex
	issued  int
	revoked map[string]bool
	revokes []string
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	g := &fakeGoogle{revoked: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		g.mu.Lock()
		defer g.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			if r.Form.Get("code_verifier") == "" {
				t.Error("token exchange without a PKCE verifier")
			}
			code := r.Form.Get("code")
			if email, ok := strings.CutPrefix(code, "signin:"); ok {
				fmt.Fprintf(w, `{"access_token":"userinfo:%s","token_type":"Bearer","expires_in":3600,"scope":"openid email"}`, email)
				return
			}
			scope := youtubeScope + " " + analyticsScope
			if code == "channel-partial" {
				scope = youtubeScope
			}
			g.issued++
			refresh := fmt.Sprintf("refresh-%d", g.issued)
			fmt.Fprintf(w, `{"access_token":"access:%s","refresh_token":%q,"token_type":"Bearer","expires_in":3600,"scope":%q}`, refresh, refresh, scope)
		case "refresh_token":
			refresh := r.Form.Get("refresh_token")
			if g.revoked[refresh] {
				w.WriteHeader(http.StatusBadRequest)
				io.WriteString(w, `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`)
				return
			}
			fmt.Fprintf(w, `{"access_token":"access:%s","token_type":"Bearer","expires_in":3600}`, refresh)
		}
	})
	mux.HandleFunc("GET /userinfo", func(w http.ResponseWriter, r *http.Request) {
		email := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer userinfo:")
		json.NewEncoder(w).Encode(map[string]any{"sub": "sub-" + strings.ToLower(email), "email": email, "email_verified": true})
	})
	mux.HandleFunc("POST /revoke", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		g.mu.Lock()
		g.revokes = append(g.revokes, r.Form.Get("token"))
		g.mu.Unlock()
	})
	mux.HandleFunc("GET /youtube/v3/channels", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer access:") || r.URL.Query().Get("mine") != "true" {
			http.Error(w, `{"error":{"code":401,"message":"unauthorized"}}`, http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"items":[{"id":"UCtest","snippet":{"title":"Test Channel","customUrl":"@testchannel"}}]}`)
	})
	mux.HandleFunc("GET /analytics/v2/reports", func(w http.ResponseWriter, r *http.Request) {
		refresh, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer access:")
		g.mu.Lock()
		revoked := g.revoked[refresh]
		g.mu.Unlock()
		if !ok || revoked {
			http.Error(w, `{"error":{"code":401,"message":"Request had invalid authentication credentials."}}`, http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"columnHeaders":[{"name":"views","columnType":"METRIC","dataType":"INTEGER"}],"rows":[[42]]}`)
	})
	g.Server = httptest.NewServer(mux)
	t.Cleanup(g.Close)
	return g
}

func (g *fakeGoogle) revoke(refresh string) {
	g.mu.Lock()
	g.revoked[refresh] = true
	g.mu.Unlock()
}

func (g *fakeGoogle) revokeCalls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.revokes)
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// browser keeps cookies, does not follow redirects, and sends POSTs the way a
// same-origin form submission would.
type browser struct {
	t      *testing.T
	base   string
	client *http.Client
}

func newBrowser(t *testing.T, base string) *browser {
	jar, _ := cookiejar.New(nil)
	return &browser{t: t, base: base, client: &http.Client{
		Jar:           jar,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (b *browser) do(method, path string, form url.Values) (status int, location, body string) {
	b.t.Helper()
	var reader io.Reader
	if form != nil {
		reader = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequest(method, b.base+path, reader)
	if err != nil {
		b.t.Fatal(err)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := b.client.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("Location"), string(data)
}

func (b *browser) crossSitePost(path string) int {
	b.t.Helper()
	req, _ := http.NewRequest("POST", b.base+path, strings.NewReader("name=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := b.client.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func mustQuery(t *testing.T, location string) url.Values {
	t.Helper()
	u, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query()
}

// callback is the path Google redirects back to after consenting with code.
func callback(t *testing.T, consentURL, code string) string {
	t.Helper()
	consent := mustQuery(t, consentURL)
	redirect, err := url.Parse(consent.Get("redirect_uri"))
	if err != nil {
		t.Fatal(err)
	}
	return redirect.Path + "?" + url.Values{"code": {code}, "state": {consent.Get("state")}}.Encode()
}

type bearer string

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+string(b))
	return http.DefaultTransport.RoundTrip(r)
}

func listChannels(t *testing.T, endpoint, key string) []mcptools.Channel {
	t.Helper()
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "v0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: endpoint, HTTPClient: &http.Client{Transport: bearer(key)}, DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "list_channels"})
	if err != nil || result.IsError {
		t.Fatalf("list_channels = %+v, %v", result, err)
	}
	data, _ := json.Marshal(result.StructuredContent)
	var out struct{ Channels []mcptools.Channel }
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out.Channels
}

func mcpStatus(t *testing.T, endpoint, key string) int {
	t.Helper()
	req, _ := http.NewRequest("POST", endpoint, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

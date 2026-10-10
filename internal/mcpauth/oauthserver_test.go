package mcpauth

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
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"

	"open-yt-cli/internal/seal"
	"open-yt-cli/internal/store"
)

const testBase = "https://oytc.example"

// testServer drives the handlers directly, as a signed-in browser.
type testServer struct {
	t      *testing.T
	auth   *Auth
	mux    *http.ServeMux
	store  *store.Store
	now    time.Time
	userID string
}

func newTestServer(t *testing.T, metadataClient *http.Client) *testServer {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "oytcd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := seal.New(bytes.Repeat([]byte{1}, 32))
	s := &testServer{t: t, mux: http.NewServeMux(), store: st, now: time.Unix(1_800_000_000, 0)}
	s.auth = New(Config{BaseURL: testBase, AllowedEmails: []string{"ben@example.com"}, MetadataClient: metadataClient, Now: func() time.Time { return s.now }}, st, box)
	s.auth.Register(s.mux)
	user, err := st.UpsertUser(ctx, "sub", "ben@example.com", s.now.Unix())
	if err == nil {
		err = st.CreateSession(ctx, hash("session"), user.ID, s.now.Add(time.Hour).Unix())
	}
	if err != nil {
		t.Fatal(err)
	}
	s.userID = user.ID
	return s
}

func (s *testServer) do(method, target string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, testBase+target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-oytc_session", Value: "session"})
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func (s *testServer) post(target string, form url.Values) *httptest.ResponseRecorder {
	return s.do("POST", target, strings.NewReader(form.Encode()), "application/x-www-form-urlencoded")
}

func (s *testServer) register(redirectURIs ...string) string {
	s.t.Helper()
	body, _ := json.Marshal(map[string]any{"redirect_uris": redirectURIs, "client_name": "Test App"})
	rec := s.do("POST", "/register", bytes.NewReader(body), "application/json")
	var out struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); rec.Code != 201 || err != nil {
		s.t.Fatalf("register = %d %s", rec.Code, rec.Body)
	}
	return out.ClientID
}

var requestField = regexp.MustCompile(`name="request" value="([^"]+)"`)

// approve consents to an authorization request and returns the redirect.
func (s *testServer) approve(query url.Values, decision string) *url.URL {
	s.t.Helper()
	rec := s.do("GET", "/authorize?"+query.Encode(), nil, "")
	match := requestField.FindStringSubmatch(rec.Body.String())
	if rec.Code != 200 || match == nil {
		s.t.Fatalf("authorize = %d %s", rec.Code, rec.Body)
	}
	rec = s.post("/authorize", url.Values{"request": {match[1]}, "decision": {decision}})
	location, err := url.Parse(rec.Header().Get("Location"))
	if rec.Code != http.StatusSeeOther || err != nil {
		s.t.Fatalf("consent = %d %q", rec.Code, rec.Header().Get("Location"))
	}
	return location
}

func (s *testServer) token(form url.Values) (int, map[string]any) {
	rec := s.post("/token", form)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Header().Get("Cache-Control") != "no-store" {
		s.t.Errorf("token response Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	return rec.Code, out
}

func s256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// with returns a copy of values with changes applied; an empty value
// deletes the key.
func with(values, changes url.Values) url.Values {
	out := url.Values{}
	for k, v := range values {
		out[k] = v
	}
	for k, v := range changes {
		if len(v) == 1 && v[0] == "" {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}

const verifier = "a-pkce-code-verifier-that-is-long-enough-1234567890"

func authorizeQuery(clientID, redirectURI string) url.Values {
	return url.Values{
		"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirectURI}, "state": {"xyz"},
		"code_challenge": {s256(verifier)}, "code_challenge_method": {"S256"}, "resource": {testBase + "/mcp"}, "scope": {"ignored"},
	}
}

func TestMetadata(t *testing.T) {
	s := newTestServer(t, nil)
	for _, path := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		rec := s.do("GET", path, nil, "")
		var prm struct {
			Resource             string   `json:"resource"`
			AuthorizationServers []string `json:"authorization_servers"`
		}
		json.Unmarshal(rec.Body.Bytes(), &prm)
		if rec.Code != 200 || prm.Resource != testBase+"/mcp" || len(prm.AuthorizationServers) != 1 || prm.AuthorizationServers[0] != testBase || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("GET %s = %d %s", path, rec.Code, rec.Body)
		}
	}
	if got := s.auth.ResourceMetadataURL(); got != testBase+"/.well-known/oauth-protected-resource/mcp" {
		t.Fatalf("ResourceMetadataURL = %q", got)
	}

	rec := s.do("GET", "/.well-known/oauth-authorization-server", nil, "")
	var meta map[string]any
	json.Unmarshal(rec.Body.Bytes(), &meta)
	if rec.Code != 200 || meta["issuer"] != testBase || meta["token_endpoint"] != testBase+"/token" || meta["client_id_metadata_document_supported"] != true ||
		fmt.Sprint(meta["code_challenge_methods_supported"]) != "[S256]" || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("authorization server metadata = %d %s", rec.Code, rec.Body)
	}
	for _, path := range []string{"/register", "/token"} {
		rec := s.do("OPTIONS", path, nil, "")
		if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") {
			t.Fatalf("OPTIONS %s = %d %v", path, rec.Code, rec.Header())
		}
	}
}

func TestRegister(t *testing.T) {
	s := newTestServer(t, nil)
	for _, tc := range []struct {
		body, wantError string
	}{
		{`{"redirect_uris":["https://app.example/callback"],"client_name":" App ","token_endpoint_auth_method":"client_secret_basic","grant_types":["authorization_code"],"application_type":"web"}`, ""},
		{`{"redirect_uris":["http://[::1]:3000/callback"]}`, ""},
		{`{"redirect_uris":[]}`, "invalid_redirect_uri"},
		{`{"redirect_uris":["http://app.example/callback"]}`, "invalid_redirect_uri"},
		{`{"redirect_uris":["https://app.example/callback#x"]}`, "invalid_redirect_uri"},
		{`{"redirect_uris":["cursor://anysphere.cursor-mcp/oauth/callback"]}`, ""},
		{`{"redirect_uris":["javascript://x/%0aalert(1)"]}`, "invalid_redirect_uri"},
		{`{"redirect_uris":["https://user@app.example/callback"]}`, "invalid_redirect_uri"},
		{`{"redirect_uris":["https://app.example/` + strings.Repeat("x", 600) + `"]}`, "invalid_redirect_uri"},
		{`{"redirect_uris":"https://app.example/callback"}`, "invalid_client_metadata"},
		{`not json`, "invalid_client_metadata"},
	} {
		rec := s.do("POST", "/register", strings.NewReader(tc.body), "application/json")
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		if tc.wantError != "" {
			if rec.Code != 400 || out["error"] != tc.wantError {
				t.Errorf("register %s = %d %s", tc.body, rec.Code, rec.Body)
			}
			continue
		}
		if rec.Code != 201 || out["client_id"] == "" || out["token_endpoint_auth_method"] != "none" || out["client_id_issued_at"] == nil {
			t.Errorf("register %s = %d %s", tc.body, rec.Code, rec.Body)
		}
	}
	rec := s.do("POST", "/register", strings.NewReader(`{"redirect_uris":["http://localhost:1/cb"]}`), "application/json")
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["client_name"] != "localhost" {
		t.Fatalf("fallback client_name = %v", out["client_name"])
	}
}

func TestAuthorize(t *testing.T) {
	s := newTestServer(t, nil)
	client := s.register("https://app.example/callback", "http://127.0.0.1/callback")
	valid := authorizeQuery(client, "https://app.example/callback")
	for _, tc := range []struct {
		name      string
		changes   url.Values
		status    int
		wantError string
	}{
		{"valid", nil, 200, ""},
		{"no resource", url.Values{"resource": {""}}, 200, ""},
		{"loopback on any port", url.Values{"redirect_uri": {"http://127.0.0.1:5555/callback"}}, 200, ""},
		{"loopback with another host", url.Values{"redirect_uri": {"http://localhost:5555/callback"}}, 400, ""},
		{"loopback with another path", url.Values{"redirect_uri": {"http://127.0.0.1:5555/other"}}, 400, ""},
		{"https on another port", url.Values{"redirect_uri": {"https://app.example:8443/callback"}}, 400, ""},
		{"unregistered redirect", url.Values{"redirect_uri": {"https://evil.example/callback"}}, 400, ""},
		{"unknown client", url.Values{"client_id": {"unknown"}}, 400, ""},
		// Invalid requests from a verified client still get a page, never a
		// redirect: /authorize must not be an open redirector.
		{"wrong resource", url.Values{"resource": {"https://other.example/mcp"}}, 400, "resource must be"},
		{"no PKCE", url.Values{"code_challenge": {""}, "code_challenge_method": {""}}, 400, "PKCE is required"},
		{"plain PKCE", url.Values{"code_challenge_method": {"plain"}}, 400, "PKCE is required"},
		{"implicit grant", url.Values{"response_type": {"token"}}, 400, "response_type must be code"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := s.do("GET", "/authorize?"+with(valid, tc.changes).Encode(), nil, "")
			location, _ := url.Parse(rec.Header().Get("Location"))
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.status, rec.Body)
			}
			switch tc.status {
			case 200:
				if !strings.Contains(rec.Body.String(), "Allow Test App to use oytc?") {
					t.Fatalf("consent page = %s", rec.Body)
				}
			case 400:
				if location.String() != "" {
					t.Fatalf("redirected to %q", location)
				}
				if !strings.Contains(rec.Body.String(), tc.wantError) {
					t.Fatalf("error page = %s, want %q", rec.Body, tc.wantError)
				}
			}
		})
	}

	signedOut := httptest.NewRecorder()
	s.mux.ServeHTTP(signedOut, httptest.NewRequest("GET", testBase+"/authorize?"+valid.Encode(), nil))
	if location := signedOut.Header().Get("Location"); signedOut.Code != 302 || location != LoginURL("/authorize?"+valid.Encode()) {
		t.Fatalf("signed-out authorize = %d %q", signedOut.Code, location)
	}

	denied := s.approve(valid, "deny").Query()
	if denied.Get("error") != "access_denied" || denied.Get("state") != "xyz" || denied.Get("iss") != testBase {
		t.Fatalf("deny = %v", denied)
	}

	rec := s.do("GET", "/authorize?"+valid.Encode(), nil, "")
	request := requestField.FindStringSubmatch(rec.Body.String())[1]
	for name, value := range map[string]string{"tampered": "x" + request, "expired": request} {
		if name == "expired" {
			s.now = s.now.Add(consentTTL + time.Second)
		}
		if rec := s.post("/authorize", url.Values{"request": {value}, "decision": {"allow"}}); rec.Code != 400 || rec.Header().Get("Location") != "" {
			t.Fatalf("%s consent = %d %q", name, rec.Code, rec.Header().Get("Location"))
		}
	}
}

func TestToken(t *testing.T) {
	s := newTestServer(t, nil)
	client := s.register("https://app.example/callback", "http://127.0.0.1/callback")
	other := s.register("https://app.example/callback")
	exchange := url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "redirect_uri": {"https://app.example/callback"}, "code_verifier": {verifier}, "resource": {testBase + "/mcp"}}

	for _, tc := range []struct {
		name      string
		changes   url.Values
		advance   time.Duration
		wantError string
	}{
		{"valid", nil, 0, ""},
		{"no resource", url.Values{"resource": {""}}, 0, ""},
		{"PKCE mismatch", url.Values{"code_verifier": {strings.Repeat("x", 43)}}, 0, "invalid_grant"},
		{"no verifier", url.Values{"code_verifier": {""}}, 0, "invalid_grant"},
		{"redirect mismatch", url.Values{"redirect_uri": {"http://127.0.0.1/callback"}}, 0, "invalid_grant"},
		{"another client", url.Values{"client_id": {other}}, 0, "invalid_grant"},
		{"no client", url.Values{"client_id": {""}}, 0, "invalid_client"},
		{"wrong resource", url.Values{"resource": {testBase}}, 0, "invalid_target"},
		{"expired code", nil, codeTTL + time.Second, "invalid_grant"},
		{"unsupported grant", url.Values{"grant_type": {"password"}}, 0, "unsupported_grant_type"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code := s.approve(authorizeQuery(client, "https://app.example/callback"), "allow").Query().Get("code")
			s.now = s.now.Add(tc.advance)
			form := with(exchange, tc.changes)
			form.Set("code", code)
			status, out := s.token(form)
			if tc.wantError != "" {
				if status != 400 || out["error"] != tc.wantError {
					t.Fatalf("token = %d %v", status, out)
				}
				return
			}
			access, _ := out["access_token"].(string)
			if status != 200 || !strings.HasPrefix(access, accessTokenPrefix) || out["token_type"] != "Bearer" || out["expires_in"] != 3600.0 {
				t.Fatalf("token = %d %v", status, out)
			}
			info, err := s.auth.Verify(context.Background(), access, nil)
			if err != nil || info.UserID != s.userID || !info.Expiration.Equal(s.now.Add(accessTTL).Truncate(time.Second)) {
				t.Fatalf("Verify = %+v, %v", info, err)
			}
			if status, out := s.token(form); status != 400 || out["error"] != "invalid_grant" {
				t.Fatalf("reused code = %d %v", status, out)
			}
		})
	}
}

func TestRefresh(t *testing.T) {
	s := newTestServer(t, nil)
	client := s.register("http://127.0.0.1/callback")
	other := s.register("http://127.0.0.1/callback")
	location := s.approve(authorizeQuery(client, "http://127.0.0.1:4000/callback"), "allow")
	_, first := s.token(url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "code": {location.Query().Get("code")},
		"redirect_uri": {"http://127.0.0.1:4000/callback"}, "code_verifier": {verifier}})
	refresh := func(clientID, token string) (int, map[string]any) {
		return s.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {token}, "resource": {testBase + "/mcp"}})
	}

	oldRefresh, _ := first["refresh_token"].(string)
	if status, out := refresh(other, oldRefresh); status != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("refresh as another client = %d %v", status, out)
	}
	status, second := refresh(client, oldRefresh)
	newRefresh, _ := second["refresh_token"].(string)
	if status != 200 || !strings.HasPrefix(newRefresh, refreshTokenPrefix) || newRefresh == oldRefresh {
		t.Fatalf("refresh = %d %v", status, second)
	}
	access, _ := second["access_token"].(string)
	row, err := s.store.TokenByHash(context.Background(), hash(access))
	if err != nil || row.UserID != s.userID || row.ClientID != client || row.Label != "Test App" {
		t.Fatalf("refreshed access token = %+v, %v", row, err)
	}
	if status, out := refresh(client, oldRefresh); status != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("reused refresh token = %d %v", status, out)
	}
	s.now = s.now.Add(refreshTTL)
	if status, out := refresh(client, newRefresh); status != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("expired refresh token = %d %v", status, out)
	}
}

func TestClientMetadataDocument(t *testing.T) {
	var fetches atomic.Int32
	mux := http.NewServeMux()
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	mux.HandleFunc("/client.json", func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"client_id": srv.URL + "/client.json", "client_name": "Doc App", "redirect_uris": []string{"https://app.example/callback"}})
	})
	mux.HandleFunc("/mismatch.json", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"client_id": srv.URL + "/client.json", "redirect_uris": []string{"https://app.example/callback"}})
	})

	s := newTestServer(t, srv.Client())
	clientID := srv.URL + "/client.json"
	code := s.approve(authorizeQuery(clientID, "https://app.example/callback"), "allow").Query().Get("code")
	status, out := s.token(url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code},
		"redirect_uri": {"https://app.example/callback"}, "code_verifier": {verifier}})
	access, _ := out["access_token"].(string)
	if row, err := s.store.TokenByHash(context.Background(), hash(access)); status != 200 || err != nil || row.Label != "Doc App" {
		t.Fatalf("token = %d %v; row %+v, %v", status, out, row, err)
	}
	if rec := s.do("GET", "/authorize?"+authorizeQuery(clientID, "https://app.example/callback").Encode(), nil, ""); rec.Code != 200 || fetches.Load() != 1 {
		t.Fatalf("cached authorize = %d after %d fetches", rec.Code, fetches.Load())
	}
	for path, want := range map[string]string{"/mismatch.json": "does not match", "/missing.json": "404"} {
		rec := s.do("GET", "/authorize?"+authorizeQuery(srv.URL+path, "https://app.example/callback").Encode(), nil, "")
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("%s authorize = %d %s", path, rec.Code, rec.Body)
		}
	}

	// The default client refuses to dial the loopback test server.
	_, err := newDocuments(publicClient(), time.Now).get(context.Background(), clientID)
	if err == nil || !strings.Contains(err.Error(), "not a public address") {
		t.Fatalf("default client fetching %s: %v", clientID, err)
	}
}

func TestDialPublic(t *testing.T) {
	for address, public := range map[string]bool{
		"8.8.8.8:443":              true,
		"[2606:4700::1111]:443":    true,
		"127.0.0.1:443":            false,
		"[::1]:443":                false,
		"[::ffff:127.0.0.1]:443":   false,
		"10.1.2.3:443":             false,
		"192.168.0.1:443":          false,
		"169.254.169.254:80":       false,
		"100.64.0.1:443":           false,
		"0.0.0.0:443":              false,
		"[fd00::1]:443":            false,
		"[fe80::1]:443":            false,
		"224.0.0.1:443":            false,
		"not-an-ip.example.com:80": false,
	} {
		if err := dialPublic("tcp", address, nil); (err == nil) != public {
			t.Errorf("dialPublic(%s) = %v, want public %v", address, err, public)
		}
	}
}

func TestRegistrationIsBounded(t *testing.T) {
	s := newTestServer(t, nil)
	stale := s.register("https://app.example/callback")
	used := s.register("https://app.example/callback")
	if err := s.store.CreateOAuthCode(context.Background(), store.OAuthCode{Hash: hash("code"), ClientID: used, UserID: s.userID, RedirectURI: "https://app.example/callback", Challenge: "c", ExpiresAt: s.now.Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	// A registration an hour later drops clients that never got a code.
	s.now = s.now.Add(unusedClientTTL + time.Minute)
	s.register("https://app.example/callback")
	if _, err := s.store.OAuthClient(context.Background(), stale); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unused client survived: %v", err)
	}
	if _, err := s.store.OAuthClient(context.Background(), used); err != nil {
		t.Errorf("client holding a code was dropped: %v", err)
	}
	status := 0
	for range registrationsPerMinute {
		status = s.do("POST", "/register", strings.NewReader(`{"redirect_uris":["https://app.example/callback"]}`), "application/json").Code
	}
	if status != http.StatusTooManyRequests {
		t.Errorf("registration past the limit = %d, want 429", status)
	}
}

func TestRemovedEmailLosesAccess(t *testing.T) {
	s := newTestServer(t, nil)
	key, err := s.auth.CreateAPIKey(context.Background(), s.userID, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.auth.Verify(context.Background(), key, nil); err != nil {
		t.Fatalf("allowed key rejected: %v", err)
	}
	s.auth.cfg.AllowedEmails = []string{"someone@example.com"}
	if _, err := s.auth.Verify(context.Background(), key, nil); !errors.Is(err, auth.ErrInvalidToken) {
		t.Errorf("key of a removed email err = %v, want ErrInvalidToken", err)
	}
	if rec := s.do("GET", "/authorize", nil, ""); rec.Code != http.StatusFound || !strings.HasPrefix(rec.Header().Get("Location"), "/auth/google") {
		t.Errorf("session of a removed email = %d %s, want a sign-in redirect", rec.Code, rec.Header().Get("Location"))
	}
	if !s.auth.allowed("SOMEONE@example.com") || s.auth.allowed("someone@exampl\u212a.com") {
		t.Error("allowed must lowercase ASCII only")
	}
}

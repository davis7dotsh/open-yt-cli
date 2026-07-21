package oauth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

func writeTokenJSON(w http.ResponseWriter, body string) {
	// x/oauth2 parses token responses by Content-Type; without this header
	// the sniffer reports text/plain and the body is misread as form data.
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, body)
}

func TestAuthorizationURL(t *testing.T) {
	verifier := oauth2.GenerateVerifier()
	target := AuthorizationURL(Config{
		ClientID:         "desktop-client",
		Scopes:           []string{"scope.one", "scope.two"},
		AuthorizationURL: "https://accounts.example/authorize",
	}, "http://127.0.0.1:1234", "state-value", verifier)
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	for key, want := range map[string]string{
		"client_id": "desktop-client", "redirect_uri": "http://127.0.0.1:1234",
		"response_type": "code", "scope": "scope.one scope.two", "state": "state-value",
		"code_challenge": oauth2.S256ChallengeFromVerifier(verifier), "code_challenge_method": "S256",
		"access_type": "offline", "prompt": "consent",
	} {
		if got := query.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestExchangeAndRefresh(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
			t.Errorf("unexpected request: %s %s", r.Method, r.Header.Get("Content-Type"))
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		switch requests.Add(1) {
		case 1:
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "code" || r.Form.Get("code_verifier") != "verifier" {
				t.Errorf("exchange form: %v", r.Form)
			}
			writeTokenJSON(w, `{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600,"scope":"one two","token_type":"Bearer"}`)
		case 2:
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh-1" {
				t.Errorf("refresh form: %v", r.Form)
			}
			writeTokenJSON(w, `{"access_token":"access-2","expires_in":1800,"token_type":"Bearer"}`)
		}
	}))
	defer server.Close()
	cfg := Config{ClientID: "id", ClientSecret: "secret", TokenURL: server.URL, HTTPClient: server.Client()}
	token, err := Exchange(context.Background(), cfg, "code", "http://127.0.0.1/callback", "verifier")
	if err != nil {
		t.Fatal(err)
	}
	// x/oauth2 stamps expiry from the real clock, so assert a window
	// rather than an exact instant.
	untilExpiry := time.Until(token.Expiry)
	if token.AccessToken != "access-1" || token.RefreshToken != "refresh-1" || len(token.Scopes) != 2 ||
		untilExpiry < 55*time.Minute || untilExpiry > 65*time.Minute {
		t.Fatalf("exchange token: %#v", token)
	}
	refreshed, err := Refresh(context.Background(), cfg, token)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken != "access-2" || refreshed.RefreshToken != "refresh-1" || len(refreshed.Scopes) != 2 {
		t.Fatalf("refresh token: %#v", refreshed)
	}
}

func TestExchangeReturnsGoogleOAuthError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_grant","error_description":"authorization code expired"}`)
	}))
	defer server.Close()
	_, err := Exchange(context.Background(), Config{ClientID: "id", ClientSecret: "secret", TokenURL: server.URL, HTTPClient: server.Client()}, "code", "redirect", "verifier")
	var oauthErr *Error
	if !errors.As(err, &oauthErr) || oauthErr.HTTPStatus != http.StatusBadRequest || oauthErr.Code != "invalid_grant" || oauthErr.Description != "authorization code expired" {
		t.Fatalf("OAuth error = %T(%v)", err, err)
	}
}

func TestExchangeErrorWithoutContentType(t *testing.T) {
	// Some proxies and older endpoints omit the JSON content type; the
	// error body must still surface as a structured *Error.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_grant","error_description":"authorization code expired"}`)
	}))
	defer server.Close()
	_, err := Exchange(context.Background(), Config{ClientID: "id", ClientSecret: "secret", TokenURL: server.URL, HTTPClient: server.Client()}, "code", "redirect", "verifier")
	var oauthErr *Error
	if !errors.As(err, &oauthErr) || oauthErr.Code != "invalid_grant" {
		t.Fatalf("OAuth error = %T(%v)", err, err)
	}
}

func TestRevoke(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Method != http.MethodPost || r.Form.Get("token") != "refresh-secret" {
			t.Errorf("unexpected revoke request: %s %v", r.Method, r.Form)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := Revoke(context.Background(), Config{RevokeURL: server.URL, HTTPClient: server.Client()}, "refresh-secret"); err != nil {
		t.Fatal(err)
	}
}

// getCallback issues the loopback callback request with the test's context so
// a stalled listener cannot outlive the test.
func getCallback(t *testing.T, callback string) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, callback, nil)
	if err != nil {
		return
	}
	if resp, err := http.DefaultClient.Do(request); err == nil {
		resp.Body.Close()
	}
}

func TestLoginLoopbackSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("code") != "callback-code" || r.Form.Get("code_verifier") == "" {
			t.Errorf("token form: %v", r.Form)
		}
		writeTokenJSON(w, `{"access_token":"access","refresh_token":"refresh","expires_in":3600,"scope":"scope","token_type":"Bearer"}`)
	}))
	defer server.Close()
	var printed strings.Builder
	cfg := Config{
		ClientID: "id", ClientSecret: "secret", Scopes: []string{"scope"},
		AuthorizationURL: "https://accounts.example/auth", TokenURL: server.URL,
		HTTPClient: server.Client(), Out: &printed, Timeout: 3 * time.Second,
	}
	cfg.OpenBrowser = func(target string) error {
		parsed, err := url.Parse(target)
		if err != nil {
			return err
		}
		if parsed.Query().Get("code_challenge") == "" || parsed.Query().Get("state") == "" {
			t.Errorf("missing PKCE/state: %s", target)
		}
		callback := parsed.Query().Get("redirect_uri") + "?code=callback-code&state=" + url.QueryEscape(parsed.Query().Get("state"))
		go getCallback(t, callback)
		return nil
	}
	token, err := Login(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "access" || !strings.Contains(printed.String(), "https://accounts.example/auth") {
		t.Fatalf("token/output: %#v %q", token, printed.String())
	}
}

func TestLoginLoopbackSurvivesStrayRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		writeTokenJSON(w, `{"access_token":"access","refresh_token":"refresh","expires_in":3600,"scope":"scope","token_type":"Bearer"}`)
	}))
	defer server.Close()
	cfg := Config{
		ClientID: "id", ClientSecret: "secret", Scopes: []string{"scope"},
		AuthorizationURL: "https://accounts.example/auth", TokenURL: server.URL,
		HTTPClient: server.Client(), Timeout: 3 * time.Second,
	}
	cfg.OpenBrowser = func(target string) error {
		parsed, err := url.Parse(target)
		if err != nil {
			return err
		}
		redirect := parsed.Query().Get("redirect_uri")
		go func() {
			// A stray local request (no/incorrect state) must not abort the
			// login before the real callback arrives.
			getCallback(t, redirect+"/favicon.ico")
			getCallback(t, redirect+"?code=evil&state=wrong")
			getCallback(t, redirect+"?code=callback-code&state="+url.QueryEscape(parsed.Query().Get("state")))
		}()
		return nil
	}
	token, err := Login(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "access" {
		t.Fatalf("token = %#v", token)
	}
}

func TestLoginLoopbackUserDenied(t *testing.T) {
	cfg := Config{ClientID: "id", ClientSecret: "secret", AuthorizationURL: "https://accounts.example/auth", Timeout: 3 * time.Second}
	cfg.OpenBrowser = func(target string) error {
		parsed, _ := url.Parse(target)
		callback := parsed.Query().Get("redirect_uri") + "?error=access_denied&error_description=nope&state=" + url.QueryEscape(parsed.Query().Get("state"))
		go getCallback(t, callback)
		return nil
	}
	_, err := Login(context.Background(), cfg)
	var oauthErr *Error
	if !errors.As(err, &oauthErr) || oauthErr.Code != "access_denied" {
		t.Fatalf("expected access_denied, got %T: %v", err, err)
	}
}

func TestTokenSourceRefreshAndOnUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeTokenJSON(w, `{"access_token":"new-access","expires_in":3600,"token_type":"Bearer"}`)
	}))
	defer server.Close()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var saved Token
	source := &TokenSource{
		Config: Config{ClientID: "id", ClientSecret: "secret", TokenURL: server.URL, HTTPClient: server.Client(), Now: func() time.Time { return now }},
		Token:  Token{AccessToken: "old-access", RefreshToken: "refresh", Expiry: now.Add(-time.Minute), Scopes: []string{"scope"}},
		OnUpdate: func(token Token) error {
			saved = token
			return nil
		},
	}
	access, err := source.AccessToken(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if access != "new-access" || saved.AccessToken != "new-access" || saved.RefreshToken != "refresh" {
		t.Fatalf("access/saved = %q %#v", access, saved)
	}
}

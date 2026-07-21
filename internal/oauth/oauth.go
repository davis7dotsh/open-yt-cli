// Package oauth wraps golang.org/x/oauth2 with Google's loopback redirect
// flow, token revocation, and a self-persisting token source.
package oauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

const (
	DefaultAuthorizationURL = "https://accounts.google.com/o/oauth2/v2/auth"
	DefaultTokenURL         = "https://oauth2.googleapis.com/token"
	DefaultRevokeURL        = "https://oauth2.googleapis.com/revoke"
	DefaultLoginTimeout     = 3 * time.Minute
)

type Token struct {
	AccessToken  string
	RefreshToken string
	Expiry       time.Time
	Scopes       []string
}

type Config struct {
	ClientID     string
	ClientSecret string
	Scopes       []string

	AuthorizationURL string
	TokenURL         string
	RevokeURL        string
	HTTPClient       *http.Client
	OpenBrowser      func(string) error
	Out              io.Writer
	Timeout          time.Duration
	// Now is used for local expiry checks; golang.org/x/oauth2 stamps
	// token expiries with the real clock.
	Now func() time.Time
}

type Error struct {
	HTTPStatus  int
	Code        string
	Description string
}

func (e *Error) Error() string {
	if e.Description != "" {
		return fmt.Sprintf("OAuth error (%s): %s", valueOr(e.Code, "unknown"), e.Description)
	}
	return fmt.Sprintf("OAuth error (%s)", valueOr(e.Code, "unknown"))
}

func Login(ctx context.Context, cfg Config) (Token, error) {
	cfg = withDefaults(cfg)
	if strings.TrimSpace(cfg.ClientID) == "" {
		return Token{}, errors.New("OAuth client ID cannot be empty")
	}
	if strings.TrimSpace(cfg.ClientSecret) == "" {
		return Token{}, errors.New("OAuth client secret cannot be empty")
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return Token{}, fmt.Errorf("start OAuth callback listener: %w", err)
	}
	defer listener.Close()

	state, err := randomString(32)
	if err != nil {
		return Token{}, err
	}
	verifier := oauth2.GenerateVerifier()
	redirectURI := "http://" + listener.Addr().String()
	authorizationURL := AuthorizationURL(cfg, redirectURI, state, verifier)

	type callbackResult struct {
		code string
		err  error
	}
	result := make(chan callbackResult, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("state") != state {
			// Reject the request but keep the login alive: any unrelated
			// local request (favicon probe, port scanner) must not be able
			// to abort the flow before Google's real redirect arrives.
			http.Error(w, "OAuth state did not match. You can close this window.", http.StatusBadRequest)
			return
		}
		if code := query.Get("error"); code != "" {
			description := query.Get("error_description")
			http.Error(w, "Authorization was not granted. You can close this window.", http.StatusBadRequest)
			select {
			case result <- callbackResult{err: &Error{Code: code, Description: description}}:
			default:
			}
			return
		}
		code := strings.TrimSpace(query.Get("code"))
		if code == "" {
			http.Error(w, "The OAuth callback did not include a code. You can close this window.", http.StatusBadRequest)
			select {
			case result <- callbackResult{err: errors.New("OAuth callback did not include an authorization code")}:
			default:
			}
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>oytc authorized</title><p>Authorization complete. You can close this window and return to oytc.</p>")
		select {
		case result <- callbackResult{code: code}:
		default:
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	serveDone := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveDone <- err
	}()

	fmt.Fprintf(cfg.Out, "Open this URL to authorize oytc:\n%s\n", authorizationURL)
	if err := cfg.OpenBrowser(authorizationURL); err != nil {
		fmt.Fprintf(cfg.Out, "Could not open a browser automatically: %v\n", err)
	}

	loginCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	var callback callbackResult
	select {
	case callback = <-result:
	case err := <-serveDone:
		if err == nil {
			err = errors.New("OAuth callback server stopped before authorization completed")
		}
		return Token{}, fmt.Errorf("serve OAuth callback: %w", err)
	case <-loginCtx.Done():
		if errors.Is(loginCtx.Err(), context.DeadlineExceeded) {
			return Token{}, errors.New("timed out waiting for OAuth authorization")
		}
		return Token{}, loginCtx.Err()
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
	_ = server.Shutdown(shutdownCtx)
	shutdownCancel()
	if callback.err != nil {
		return Token{}, callback.err
	}
	return Exchange(loginCtx, cfg, callback.code, redirectURI, verifier)
}

// AuthorizationURL builds the consent URL; verifier is the PKCE code verifier
// whose S256 challenge is embedded.
func AuthorizationURL(cfg Config, redirectURI, state, verifier string) string {
	cfg = withDefaults(cfg)
	library := cfg.library()
	library.RedirectURL = redirectURI
	return library.AuthCodeURL(state,
		oauth2.AccessTypeOffline,
		oauth2.S256ChallengeOption(verifier),
		// Force the consent screen so Google always returns a refresh
		// token, not only on the first authorization.
		oauth2.SetAuthURLParam("prompt", "consent"),
	)
}

func Exchange(ctx context.Context, cfg Config, code, redirectURI, verifier string) (Token, error) {
	cfg = withDefaults(cfg)
	library := cfg.library()
	library.RedirectURL = redirectURI
	token, err := library.Exchange(cfg.context(ctx), code, oauth2.VerifierOption(verifier))
	if err != nil {
		return Token{}, translateError(err, "request OAuth token")
	}
	return fromLibrary(token, cfg, Token{}), nil
}

func Refresh(ctx context.Context, cfg Config, current Token) (Token, error) {
	if strings.TrimSpace(current.RefreshToken) == "" {
		return Token{}, errors.New("OAuth refresh token is missing; re-run 'oytc login --oauth'")
	}
	cfg = withDefaults(cfg)
	// A seed token with no access token forces TokenSource straight to the
	// refresh_token grant.
	seed := &oauth2.Token{RefreshToken: current.RefreshToken}
	token, err := cfg.library().TokenSource(cfg.context(ctx), seed).Token()
	if err != nil {
		return Token{}, translateError(err, "refresh OAuth token")
	}
	return fromLibrary(token, cfg, current), nil
}

func Revoke(ctx context.Context, cfg Config, token string) error {
	cfg = withDefaults(cfg)
	if strings.TrimSpace(token) == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.RevokeURL, strings.NewReader(url.Values{"token": {token}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("revoke OAuth token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseError(resp.StatusCode, body)
	}
	return nil
}

type TokenSource struct {
	Config   Config
	Token    Token
	OnUpdate func(Token) error

	mu sync.Mutex
}

func (s *TokenSource) AccessToken(ctx context.Context, forceRefresh bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := withDefaults(s.Config)
	if !forceRefresh && strings.TrimSpace(s.Token.AccessToken) != "" && s.Token.Expiry.After(cfg.Now().Add(time.Minute)) {
		return s.Token.AccessToken, nil
	}
	updated, err := Refresh(ctx, cfg, s.Token)
	if err != nil {
		var oauthErr *Error
		if errors.As(err, &oauthErr) && (oauthErr.Code == "invalid_grant" || oauthErr.Code == "invalid_client") {
			return "", fmt.Errorf("OAuth authorization is expired or revoked; re-run 'oytc login --oauth': %w", err)
		}
		return "", err
	}
	if s.OnUpdate != nil {
		if err := s.OnUpdate(updated); err != nil {
			return "", fmt.Errorf("persist refreshed OAuth token: %w", err)
		}
	}
	s.Token = updated
	return updated.AccessToken, nil
}

func (c Config) library() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     c.ClientID,
		ClientSecret: c.ClientSecret,
		Scopes:       c.Scopes,
		Endpoint: oauth2.Endpoint{
			AuthURL:  c.AuthorizationURL,
			TokenURL: c.TokenURL,
			// Google accepts credentials in the POST body; pinning the
			// style avoids the library's two-request auto-detection.
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}
}

// context injects cfg.HTTPClient into the oauth2 library, which only accepts
// a custom client via context.
func (c Config) context(ctx context.Context) context.Context {
	return context.WithValue(ctx, oauth2.HTTPClient, c.HTTPClient)
}

// fromLibrary converts an oauth2 token, inheriting the refresh token and
// scopes from the previous token when a response omits them.
func fromLibrary(token *oauth2.Token, cfg Config, current Token) Token {
	refreshToken := token.RefreshToken
	if refreshToken == "" {
		refreshToken = current.RefreshToken
	}
	granted, _ := token.Extra("scope").(string)
	scopes := strings.Fields(granted)
	if len(scopes) == 0 {
		if len(current.Scopes) > 0 {
			scopes = append([]string(nil), current.Scopes...)
		} else {
			scopes = append([]string(nil), cfg.Scopes...)
		}
	}
	return Token{
		AccessToken:  token.AccessToken,
		RefreshToken: refreshToken,
		Expiry:       token.Expiry,
		Scopes:       scopes,
	}
}

// translateError maps the library's *oauth2.RetrieveError onto *Error so the
// CLI's exit-code and re-login-hint logic keeps working.
func translateError(err error, action string) error {
	var retrieve *oauth2.RetrieveError
	if !errors.As(err, &retrieve) {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return fmt.Errorf("%s: %w", action, urlErr.Err)
		}
		return err
	}
	status := 0
	if retrieve.Response != nil {
		status = retrieve.Response.StatusCode
	}
	if retrieve.ErrorCode != "" {
		return &Error{HTTPStatus: status, Code: retrieve.ErrorCode, Description: retrieve.ErrorDescription}
	}
	// The library only parses RFC 6749 fields for JSON/form content types;
	// fall back to parsing the body directly.
	return parseError(status, retrieve.Body)
}

func parseError(status int, body []byte) error {
	var response struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	_ = json.Unmarshal(body, &response)
	if response.Error == "" {
		response.Error = http.StatusText(status)
	}
	if response.ErrorDescription == "" {
		response.ErrorDescription = strings.TrimSpace(string(body))
	}
	return &Error{HTTPStatus: status, Code: response.Error, Description: response.ErrorDescription}
}

func withDefaults(cfg Config) Config {
	if cfg.AuthorizationURL == "" {
		cfg.AuthorizationURL = DefaultAuthorizationURL
	}
	if cfg.TokenURL == "" {
		cfg.TokenURL = DefaultTokenURL
	}
	if cfg.RevokeURL == "" {
		cfg.RevokeURL = DefaultRevokeURL
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	}
	if cfg.OpenBrowser == nil {
		cfg.OpenBrowser = OpenBrowser
	}
	if cfg.Out == nil {
		cfg.Out = io.Discard
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultLoginTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return cfg
}

func OpenBrowser(target string) error {
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command, args = "open", []string{target}
	case "windows":
		command, args = "rundll32", []string{"url.dll,FileProtocolHandler", target}
	default:
		command, args = "xdg-open", []string{target}
	}
	return exec.Command(command, args...).Start()
}

func randomString(bytes int) (string, error) {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate OAuth random value: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func ParseExpiry(value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, nil
	}
	expiry, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse OAuth token expiry: %w", err)
	}
	return expiry, nil
}

func FormatExpiry(expiry time.Time) string {
	if expiry.IsZero() {
		return ""
	}
	return expiry.UTC().Format(time.RFC3339)
}

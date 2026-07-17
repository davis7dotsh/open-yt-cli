// Package oauth implements Google's OAuth 2.0 loopback flow and token refresh
// using only the Go standard library.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	Now              func() time.Time
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
	verifier, err := randomString(64)
	if err != nil {
		return Token{}, err
	}
	challengeSum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeSum[:])
	redirectURI := "http://" + listener.Addr().String()
	authorizationURL, err := AuthorizationURL(cfg, redirectURI, state, challenge)
	if err != nil {
		return Token{}, err
	}

	type callbackResult struct {
		code string
		err  error
	}
	result := make(chan callbackResult, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("state") != state {
			http.Error(w, "OAuth state did not match. You can close this window.", http.StatusBadRequest)
			select {
			case result <- callbackResult{err: errors.New("OAuth callback state did not match")}:
			default:
			}
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

func AuthorizationURL(cfg Config, redirectURI, state, challenge string) (string, error) {
	cfg = withDefaults(cfg)
	target, err := url.Parse(cfg.AuthorizationURL)
	if err != nil {
		return "", fmt.Errorf("parse OAuth authorization endpoint: %w", err)
	}
	query := target.Query()
	query.Set("client_id", cfg.ClientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("response_type", "code")
	query.Set("scope", strings.Join(cfg.Scopes, " "))
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("access_type", "offline")
	query.Set("prompt", "consent")
	target.RawQuery = query.Encode()
	return target.String(), nil
}

func Exchange(ctx context.Context, cfg Config, code, redirectURI, verifier string) (Token, error) {
	values := url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"code":          {code},
		"code_verifier": {verifier},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {redirectURI},
	}
	return requestToken(ctx, cfg, values, Token{})
}

func Refresh(ctx context.Context, cfg Config, current Token) (Token, error) {
	if strings.TrimSpace(current.RefreshToken) == "" {
		return Token{}, errors.New("OAuth refresh token is missing; re-run 'oytc login --oauth'")
	}
	values := url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"grant_type":    {"refresh_token"},
		"refresh_token": {current.RefreshToken},
	}
	return requestToken(ctx, cfg, values, current)
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

func requestToken(ctx context.Context, cfg Config, values url.Values, current Token) (Token, error) {
	cfg = withDefaults(cfg)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.TokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("request OAuth token: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return Token{}, fmt.Errorf("read OAuth token response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Token{}, parseError(resp.StatusCode, body)
	}
	var response struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
		TokenType    string `json:"token_type"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return Token{}, fmt.Errorf("decode OAuth token response: %w", err)
	}
	if strings.TrimSpace(response.AccessToken) == "" {
		return Token{}, errors.New("OAuth token response did not include an access token")
	}
	refreshToken := response.RefreshToken
	if refreshToken == "" {
		refreshToken = current.RefreshToken
	}
	scopes := strings.Fields(response.Scope)
	if len(scopes) == 0 {
		if len(current.Scopes) > 0 {
			scopes = append([]string(nil), current.Scopes...)
		} else {
			scopes = append([]string(nil), cfg.Scopes...)
		}
	}
	return Token{
		AccessToken:  response.AccessToken,
		RefreshToken: refreshToken,
		Expiry:       cfg.Now().Add(time.Duration(response.ExpiresIn) * time.Second),
		Scopes:       scopes,
	}, nil
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

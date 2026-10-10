// Package mcpauth authenticates oytcd's users: Google sign-in and browser
// sessions for the console, and the bearer tokens (console API keys and MCP
// OAuth access tokens) that protect /mcp. It knows nothing about YouTube.
package mcpauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"golang.org/x/oauth2"

	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/seal"
	"open-yt-cli/internal/store"
)

const (
	DefaultUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"

	flowTTL      = 10 * time.Minute
	sessionTTL   = 30 * 24 * time.Hour
	apiKeyPrefix = "oytc_k_"
)

type Config struct {
	// BaseURL is the public origin, e.g. https://oytc.davis7.sh. An http
	// origin (local dev) drops the Secure flag and __Host- cookie prefix.
	BaseURL string
	// Google is the OAuth client and its endpoints; Scopes is ignored.
	Google        oauth.Config
	UserInfoURL   string
	AllowedEmails []string
	Now           func() time.Time
}

type Auth struct {
	cfg   Config
	store *store.Store
	box   *seal.Box
}

func New(cfg Config, st *store.Store, box *seal.Box) *Auth {
	if cfg.UserInfoURL == "" {
		cfg.UserInfoURL = DefaultUserInfoURL
	}
	if cfg.Google.HTTPClient == nil {
		cfg.Google.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	cfg.Google.Now = cfg.Now
	return &Auth{cfg: cfg, store: st, box: box}
}

func (a *Auth) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/google", a.signIn)
	mux.HandleFunc("GET /auth/google/callback", a.signInCallback)
	mux.Handle("POST /auth/logout", http.NewCrossOriginProtection().Handler(http.HandlerFunc(a.logout)))
}

// LoginURL is where to send a browser to sign in and come back to returnTo,
// a local path with its query.
func LoginURL(returnTo string) string {
	return "/auth/google?" + url.Values{"return_to": {returnTo}}.Encode()
}

type userKey struct{}

// CurrentUser returns the signed-in user of a browser request.
func (a *Auth) CurrentUser(r *http.Request) (userID string, ok bool) {
	if userID, ok := r.Context().Value(userKey{}).(string); ok {
		return userID, true
	}
	cookie, err := r.Cookie(a.cookieName("session"))
	if err != nil {
		return "", false
	}
	userID, err = a.store.SessionUser(r.Context(), hash(cookie.Value), a.cfg.Now().Unix())
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			slog.ErrorContext(r.Context(), "look up session", "err", err)
		}
		return "", false
	}
	return userID, true
}

// RequireSession sends signed-out GETs to sign in and back, and rejects
// other signed-out requests with 401.
func (a *Auth) RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, ok := a.CurrentUser(r)
		if !ok {
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				http.Redirect(w, r, LoginURL(r.URL.RequestURI()), http.StatusFound)
				return
			}
			http.Error(w, "Sign in required.", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, userID)))
	})
}

func (a *Auth) signIn(w http.ResponseWriter, r *http.Request) {
	returnTo := r.URL.Query().Get("return_to")
	if !localPath(returnTo) {
		returnTo = "/console"
	}
	flow := a.StartFlow(w, "oauth", returnTo)
	cfg := a.cfg.Google
	cfg.Scopes = []string{"openid", "email"}
	target := oauth.AuthorizationURL(cfg, a.cfg.BaseURL+"/auth/google/callback", flow.State, flow.Verifier,
		oauth2.SetAuthURLParam("prompt", "select_account"), oauth2.AccessTypeOnline)
	http.Redirect(w, r, target, http.StatusFound)
}

func (a *Auth) signInCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	flow, code, err := a.FinishFlow(w, r, "oauth")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cfg := a.cfg.Google
	cfg.Scopes = []string{"openid", "email"}
	token, err := oauth.Exchange(ctx, cfg, code, a.cfg.BaseURL+"/auth/google/callback", flow.Verifier)
	if err != nil {
		slog.WarnContext(ctx, "sign-in token exchange failed", "err", err)
		http.Error(w, "Google sign-in failed. Please try again.", http.StatusBadGateway)
		return
	}
	info, err := a.userInfo(ctx, token.AccessToken)
	if err != nil {
		slog.WarnContext(ctx, "sign-in userinfo failed", "err", err)
		http.Error(w, "Google sign-in failed. Please try again.", http.StatusBadGateway)
		return
	}
	if !info.EmailVerified || !slices.ContainsFunc(a.cfg.AllowedEmails, func(allowed string) bool { return strings.EqualFold(allowed, info.Email) }) {
		http.Error(w, "This Google account is not allowed to use oytc.", http.StatusForbidden)
		return
	}
	user, err := a.store.UpsertUser(ctx, info.Sub, info.Email, a.cfg.Now().Unix())
	if err != nil {
		slog.ErrorContext(ctx, "save user", "err", err)
		http.Error(w, "Sign-in failed.", http.StatusInternalServerError)
		return
	}
	session := randomString(32)
	if err := a.store.CreateSession(ctx, hash(session), user.ID, a.cfg.Now().Add(sessionTTL).Unix()); err != nil {
		slog.ErrorContext(ctx, "create session", "err", err)
		http.Error(w, "Sign-in failed.", http.StatusInternalServerError)
		return
	}
	a.setCookie(w, "session", session, sessionTTL)
	http.Redirect(w, r, flow.ReturnTo, http.StatusFound)
}

func (a *Auth) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(a.cookieName("session")); err == nil {
		if err := a.store.DeleteSession(r.Context(), hash(cookie.Value)); err != nil {
			slog.ErrorContext(r.Context(), "delete session", "err", err)
		}
	}
	a.setCookie(w, "session", "", -1)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

type userInfo struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
}

func (a *Auth) userInfo(ctx context.Context, accessToken string) (userInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.UserInfoURL, nil)
	if err != nil {
		return userInfo{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := a.cfg.Google.HTTPClient.Do(req)
	if err != nil {
		return userInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return userInfo{}, fmt.Errorf("userinfo returned %s", resp.Status)
	}
	var info userInfo
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&info); err != nil {
		return userInfo{}, fmt.Errorf("decode userinfo: %w", err)
	}
	if info.Sub == "" || info.Email == "" {
		return userInfo{}, errors.New("userinfo is missing sub or email")
	}
	return info, nil
}

// --- Google authorization flows ---

// Flow is one in-flight Google authorization, kept in a sealed cookie
// between the redirect to Google and its callback.
type Flow struct {
	State    string `json:"state"`
	Verifier string `json:"verifier"`
	ReturnTo string `json:"return_to,omitempty"`
	Expires  int64  `json:"expires"`
}

var (
	ErrFlowExpired = errors.New("The Google authorization expired or did not match. Please try again.")
	ErrFlowDenied  = errors.New("Google access was not granted.")
)

// StartFlow saves a fresh flow in the cookie name; pass its State and
// Verifier (PKCE) to oauth.AuthorizationURL.
func (a *Auth) StartFlow(w http.ResponseWriter, name, returnTo string) Flow {
	flow := Flow{State: randomString(32), Verifier: randomString(32), ReturnTo: returnTo, Expires: a.cfg.Now().Add(flowTTL).Unix()}
	data, _ := json.Marshal(flow)
	a.setCookie(w, name, base64.RawURLEncoding.EncodeToString(a.box.Seal(data, []byte("flow:"+name))), flowTTL)
	return flow
}

// FinishFlow checks a Google callback against the flow in the cookie name,
// clears the cookie, and returns the flow and its authorization code.
func (a *Auth) FinishFlow(w http.ResponseWriter, r *http.Request, name string) (Flow, string, error) {
	cookie, err := r.Cookie(a.cookieName(name))
	if err != nil {
		return Flow{}, "", ErrFlowExpired
	}
	a.setCookie(w, name, "", -1)
	sealed, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		return Flow{}, "", ErrFlowExpired
	}
	data, err := a.box.Open(sealed, []byte("flow:"+name))
	if err != nil {
		return Flow{}, "", ErrFlowExpired
	}
	var flow Flow
	if err := json.Unmarshal(data, &flow); err != nil || a.cfg.Now().Unix() > flow.Expires {
		return Flow{}, "", ErrFlowExpired
	}
	query := r.URL.Query()
	if subtle.ConstantTimeCompare([]byte(query.Get("state")), []byte(flow.State)) != 1 {
		return Flow{}, "", ErrFlowExpired
	}
	if query.Get("error") != "" {
		return Flow{}, "", ErrFlowDenied
	}
	code := query.Get("code")
	if code == "" {
		return Flow{}, "", ErrFlowDenied
	}
	return flow, code, nil
}

// --- API keys and bearer tokens ---

// CreateAPIKey mints a console API key. The key is returned only here; the
// store keeps its hash.
func (a *Auth) CreateAPIKey(ctx context.Context, userID, label string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		label = "API key"
	}
	if runes := []rune(label); len(runes) > 64 {
		label = string(runes[:64])
	}
	key := apiKeyPrefix + randomString(32)
	err := a.store.CreateToken(ctx, store.Token{
		Hash: hash(key), UserID: userID, Kind: store.KindAPIKey, Label: label, Prefix: key[:12], CreatedAt: a.cfg.Now().Unix(),
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

// Verify is the auth.TokenVerifier for /mcp. Any unexpired row in tokens
// (console API key or MCP OAuth access token) authenticates its user.
func (a *Auth) Verify(ctx context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
	row, err := a.store.TokenByHash(ctx, hash(token))
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("%w: unknown token", auth.ErrInvalidToken)
	}
	if err != nil {
		slog.ErrorContext(ctx, "look up token", "err", err)
		return nil, errors.New("token lookup failed")
	}
	now := a.cfg.Now().Unix()
	if row.ExpiresAt != 0 && row.ExpiresAt <= now {
		return nil, fmt.Errorf("%w: token expired", auth.ErrInvalidToken)
	}
	// Best effort, and at most once a minute so each MCP call is not a write.
	if now-row.LastUsedAt >= 60 {
		if err := a.store.TouchToken(ctx, row.Hash, now); err != nil {
			slog.WarnContext(ctx, "update token last use", "err", err)
		}
	}
	info := &auth.TokenInfo{UserID: row.UserID}
	if row.ExpiresAt != 0 {
		info.Expiration = time.Unix(row.ExpiresAt, 0)
	}
	return info, nil
}

// --- helpers ---

func (a *Auth) secure() bool { return strings.HasPrefix(a.cfg.BaseURL, "https://") }

func (a *Auth) cookieName(name string) string {
	if a.secure() {
		return "__Host-oytc_" + name
	}
	return "oytc_" + name
}

// setCookie sets an HttpOnly cookie; a negative maxAge deletes it.
func (a *Auth) setCookie(w http.ResponseWriter, name, value string, maxAge time.Duration) {
	seconds := int(maxAge.Seconds())
	if maxAge < 0 {
		seconds = -1
	}
	http.SetCookie(w, &http.Cookie{
		Name: a.cookieName(name), Value: value, Path: "/", MaxAge: seconds,
		HttpOnly: true, Secure: a.secure(), SameSite: http.SameSiteLaxMode,
	})
}

// localPath reports whether p is a path on this site. Browsers treat "//",
// "/\", and stripped control characters as the start of another host.
func localPath(p string) bool {
	return strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") &&
		!strings.ContainsFunc(p, func(r rune) bool { return r == '\\' || r < 0x20 || r == 0x7f })
}

func randomString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hash(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

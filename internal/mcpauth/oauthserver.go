package mcpauth

// The MCP OAuth authorization server. This server is both the protected
// resource (the MCP endpoint, Config.Resource) and its authorization server
// (issuer BaseURL). Users consent after signing in with Google; clients get
// this server's own opaque tokens, never Google's. Clients are public: they
// authenticate with PKCE alone and identify themselves by dynamic client
// registration or a client ID metadata document.

import (
	"cmp"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"open-yt-cli/internal/store"
	"open-yt-cli/internal/webui"
)

const (
	accessTokenPrefix  = "oytc_a_"
	refreshTokenPrefix = "oytc_r_"

	consentTTL = 10 * time.Minute
	codeTTL    = 5 * time.Minute
	accessTTL  = time.Hour
	refreshTTL = 30 * 24 * time.Hour

	maxRedirectURIs   = 10
	maxRedirectURILen = 512
	// Registration is unauthenticated, so it is rate limited and clients
	// that never complete an authorization are dropped after unusedClientTTL.
	registrationsPerMinute = 30
	unusedClientTTL        = time.Hour
)

// ResourceMetadataURL is where the protected resource metadata (RFC 9728)
// for Config.Resource is served; 401s from the resource point to it.
func (a *Auth) ResourceMetadataURL() string {
	return a.cfg.BaseURL + "/.well-known/oauth-protected-resource" + a.resourcePath()
}

func (a *Auth) resourcePath() string {
	u, err := url.Parse(a.cfg.Resource)
	if err != nil {
		return ""
	}
	return u.Path
}

// serverMetadata is the authorization server metadata (RFC 8414).
func (a *Auth) serverMetadata(w http.ResponseWriter, _ *http.Request) {
	base := a.cfg.BaseURL
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         base,
		"authorization_endpoint":                         base + "/authorize",
		"token_endpoint":                                 base + "/token",
		"registration_endpoint":                          base + "/register",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"client_id_metadata_document_supported":          true,
		"authorization_response_iss_parameter_supported": true,
	})
}

// registerClient is dynamic client registration (RFC 7591). Only the
// redirect URIs and name are kept: every client is public and gets the same
// grant types.
func (a *Auth) registerClient(w http.ResponseWriter, r *http.Request) {
	var metadata struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if !a.registrations.allow(a.cfg.Now(), registrationsPerMinute) {
		writeJSON(w, http.StatusTooManyRequests, &oauthError{"temporarily_unavailable", "Too many registrations. Try again in a minute."})
		return
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&metadata); err != nil {
		writeJSON(w, http.StatusBadRequest, &oauthError{"invalid_client_metadata", "The body must be a JSON client metadata object."})
		return
	}
	if err := checkRedirectURIs(metadata.RedirectURIs); err != nil {
		writeJSON(w, http.StatusBadRequest, &oauthError{"invalid_redirect_uri", err.Error()})
		return
	}
	redirect, _ := url.Parse(metadata.RedirectURIs[0])
	now := a.cfg.Now()
	client := store.OAuthClient{
		ID: randomString(16), Name: label(metadata.ClientName, cmp.Or(redirect.Hostname(), redirect.Scheme)), RedirectURIs: metadata.RedirectURIs, CreatedAt: now.Unix(),
	}
	if _, err := a.store.DeleteUnusedOAuthClients(r.Context(), now.Add(-unusedClientTTL).Unix()); err != nil {
		slog.WarnContext(r.Context(), "drop unused OAuth clients", "err", err)
	}
	if err := a.store.SaveOAuthClient(r.Context(), client); err != nil {
		slog.ErrorContext(r.Context(), "register OAuth client", "err", err)
		writeJSON(w, http.StatusInternalServerError, &oauthError{"server_error", "Registration failed."})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  client.ID,
		"client_id_issued_at":        client.CreatedAt,
		"client_name":                client.Name,
		"redirect_uris":              client.RedirectURIs,
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
	})
}

// authRequest is an authorization request that passed validation. It
// travels sealed in the consent form, bound to the signed-in user.
type authRequest struct {
	ClientID    string `json:"client_id"`
	RedirectURI string `json:"redirect_uri"`
	State       string `json:"state,omitempty"`
	Challenge   string `json:"challenge"`
	UserID      string `json:"user_id"`
	Expires     int64  `json:"expires"`
}

var errRequestExpired = errors.New("This authorization request expired. Start again from the app.")

var s256Challenge = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type consentPage struct {
	Client, Host, Request string
}

// authorize asks the signed-in user to approve an authorization request.
// Invalid requests get an error page rather than a redirect, so /authorize
// cannot bounce a browser to a registered URI without the user's consent
// (RFC 9700 §4.11.2).
func (a *Auth) authorize(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	client, err := a.verifyClient(r.Context(), query.Get("client_id"), query.Get("redirect_uri"))
	if err != nil {
		render(w, http.StatusBadRequest, "authorize_error", err.Error())
		return
	}
	userID, _ := a.CurrentUser(r)
	req := authRequest{
		ClientID: client.ID, RedirectURI: query.Get("redirect_uri"), State: query.Get("state"), Challenge: query.Get("code_challenge"),
		UserID: userID, Expires: a.cfg.Now().Add(consentTTL).Unix(),
	}
	var problem *oauthError
	switch {
	case query.Get("response_type") != "code":
		problem = &oauthError{"unsupported_response_type", "response_type must be code."}
	case query.Get("code_challenge_method") != "S256" || !s256Challenge.MatchString(req.Challenge):
		problem = &oauthError{"invalid_request", "PKCE is required: send a code_challenge with code_challenge_method S256."}
	case a.wrongResource(query["resource"]):
		problem = &oauthError{"invalid_target", "resource must be " + a.cfg.Resource + "."}
	}
	if problem != nil {
		render(w, http.StatusBadRequest, "authorize_error", "The app sent an invalid request: "+problem.Description)
		return
	}
	redirect, _ := url.Parse(req.RedirectURI)
	render(w, http.StatusOK, "consent", consentPage{Client: client.Name, Host: redirectHost(redirect), Request: a.sealJSON(req, "consent")})
}

// consent applies the user's decision on the consent page: an authorization
// code, or access_denied.
func (a *Auth) consent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, _ := a.CurrentUser(r)
	var req authRequest
	if err := a.openJSON(r.PostFormValue("request"), "consent", &req); err != nil || req.UserID != userID || a.cfg.Now().Unix() > req.Expires {
		render(w, http.StatusBadRequest, "authorize_error", errRequestExpired.Error())
		return
	}
	client, err := a.verifyClient(ctx, req.ClientID, req.RedirectURI)
	if err != nil {
		render(w, http.StatusBadRequest, "authorize_error", err.Error())
		return
	}
	if r.PostFormValue("decision") != "allow" {
		a.redirectBack(w, r, req, url.Values{"error": {"access_denied"}})
		return
	}
	now := a.cfg.Now()
	if metadataDocument(client.ID) {
		// Keep the document's client so the token endpoint and console can
		// name it without fetching the document again.
		client.CreatedAt = now.Unix()
		err = a.store.SaveOAuthClient(ctx, client)
	}
	code := randomString(32)
	if err == nil {
		err = a.store.CreateOAuthCode(ctx, store.OAuthCode{
			Hash: hash(code), ClientID: client.ID, UserID: userID, RedirectURI: req.RedirectURI, Challenge: req.Challenge, ExpiresAt: now.Add(codeTTL).Unix(),
		})
	}
	if err != nil {
		slog.ErrorContext(ctx, "create authorization code", "err", err)
		a.redirectBack(w, r, req, url.Values{"error": {"server_error"}})
		return
	}
	a.redirectBack(w, r, req, url.Values{"code": {code}})
}

// verifyClient finds a registered client, or loads the metadata document a
// URL client_id names, and checks redirectURI against it. Its errors are
// for the user: a request failing here must never be redirected.
func (a *Auth) verifyClient(ctx context.Context, clientID, redirectURI string) (store.OAuthClient, error) {
	var client store.OAuthClient
	var err error
	if metadataDocument(clientID) {
		client, err = a.documents.get(ctx, clientID)
		if err != nil {
			return store.OAuthClient{}, fmt.Errorf("The app's client metadata document could not be used: %v.", err)
		}
	} else {
		client, err = a.store.OAuthClient(ctx, clientID)
		if errors.Is(err, store.ErrNotFound) {
			return store.OAuthClient{}, errors.New("This app is not registered. Remove it and add it again.")
		}
		if err != nil {
			slog.ErrorContext(ctx, "look up OAuth client", "err", err)
			return store.OAuthClient{}, errors.New("Something went wrong. Please try again.")
		}
	}
	if !redirectAllowed(client.RedirectURIs, redirectURI) {
		return store.OAuthClient{}, errors.New("The app's redirect_uri is not registered for it.")
	}
	return client, nil
}

// redirectBack sends the browser to the client's verified redirect URI with
// params, the request's state, and the issuer (RFC 9207).
func (a *Auth) redirectBack(w http.ResponseWriter, r *http.Request, req authRequest, params url.Values) {
	target, _ := url.Parse(req.RedirectURI)
	query := target.Query()
	maps.Copy(query, params)
	if req.State != "" {
		query.Set("state", req.State)
	}
	query.Set("iss", a.cfg.BaseURL)
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), http.StatusSeeOther)
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
}

// token is the token endpoint. Refresh tokens rotate: each works once.
func (a *Auth) token(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	response, err := a.grant(r)
	var problem *oauthError
	switch {
	case errors.As(err, &problem):
		writeJSON(w, http.StatusBadRequest, problem)
	case err != nil:
		slog.ErrorContext(r.Context(), "token grant", "err", err)
		writeJSON(w, http.StatusInternalServerError, &oauthError{"server_error", "Something went wrong."})
	default:
		writeJSON(w, http.StatusOK, response)
	}
}

func (a *Auth) grant(r *http.Request) (tokenResponse, error) {
	ctx := r.Context()
	if err := r.ParseForm(); err != nil {
		return tokenResponse{}, &oauthError{"invalid_request", "The body must be form-encoded."}
	}
	form := r.PostForm
	// Public clients send client_id in the form, or as the HTTP Basic user
	// with an empty password.
	clientID := form.Get("client_id")
	if clientID == "" {
		clientID, _, _ = r.BasicAuth()
	}
	if clientID == "" {
		return tokenResponse{}, &oauthError{"invalid_client", "client_id is required."}
	}
	if a.wrongResource(form["resource"]) {
		return tokenResponse{}, &oauthError{"invalid_target", "resource must be " + a.cfg.Resource + "."}
	}
	now := a.cfg.Now().Unix()
	switch form.Get("grant_type") {
	case "authorization_code":
		code, err := a.store.RedeemOAuthCode(ctx, hash(form.Get("code")), now)
		if errors.Is(err, store.ErrNotFound) {
			return tokenResponse{}, &oauthError{"invalid_grant", "The authorization code is invalid, expired, or already used."}
		}
		if err != nil {
			return tokenResponse{}, err
		}
		if code.ClientID != clientID || code.RedirectURI != form.Get("redirect_uri") || !pkceMatches(form.Get("code_verifier"), code.Challenge) {
			return tokenResponse{}, &oauthError{"invalid_grant", "client_id, redirect_uri, or code_verifier does not match the authorization request."}
		}
		response, access, refresh := a.newTokens(ctx, clientID, code.UserID)
		return response, a.store.CreateOAuthGrant(ctx, access, refresh)
	case "refresh_token":
		response, access, refresh := a.newTokens(ctx, clientID, "")
		err := a.store.RotateOAuthGrant(ctx, hash(form.Get("refresh_token")), now, access, refresh)
		if errors.Is(err, store.ErrNotFound) {
			return tokenResponse{}, &oauthError{"invalid_grant", "The refresh token is invalid, expired, or already used."}
		}
		return response, err
	case "":
		return tokenResponse{}, &oauthError{"invalid_request", "grant_type is required."}
	}
	return tokenResponse{}, &oauthError{"unsupported_grant_type", "grant_type must be authorization_code or refresh_token."}
}

// newTokens mints an access token and a refresh token for a user of a
// client, returning the token response and the rows to store.
func (a *Auth) newTokens(ctx context.Context, clientID, userID string) (tokenResponse, store.Token, store.OAuthRefresh) {
	name := clientID
	if client, err := a.store.OAuthClient(ctx, clientID); err == nil {
		name = client.Name
	}
	now := a.cfg.Now()
	response := tokenResponse{
		AccessToken: accessTokenPrefix + randomString(32), TokenType: "Bearer", ExpiresIn: int64(accessTTL.Seconds()),
		RefreshToken: refreshTokenPrefix + randomString(32),
	}
	access := store.Token{
		Hash: hash(response.AccessToken), UserID: userID, Kind: store.KindAccess, Label: label(name, clientID), Prefix: response.AccessToken[:12],
		ClientID: clientID, ExpiresAt: now.Add(accessTTL).Unix(), CreatedAt: now.Unix(),
	}
	refresh := store.OAuthRefresh{Hash: hash(response.RefreshToken), ClientID: clientID, UserID: userID, ExpiresAt: now.Add(refreshTTL).Unix()}
	return response, access, refresh
}

// wrongResource reports whether a request names a resource (RFC 8707) other
// than ours. Older clients name none.
func (a *Auth) wrongResource(resources []string) bool {
	return slices.ContainsFunc(resources, func(resource string) bool { return resource != a.cfg.Resource })
}

// pkceMatches checks a PKCE code verifier against its S256 challenge.
func pkceMatches(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	return verifier != "" && subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// metadataDocument reports whether a client_id is the URL of a client ID
// metadata document rather than a registered client's ID.
func metadataDocument(clientID string) bool { return strings.HasPrefix(clientID, "https://") }

// checkRedirectURIs accepts https URIs, http on loopback, and native apps'
// private-use schemes such as cursor:// (RFC 8252 §7.1), which must then
// match exactly.
func checkRedirectURIs(uris []string) error {
	if len(uris) == 0 {
		return errors.New("redirect_uris is required")
	}
	if len(uris) > maxRedirectURIs {
		return fmt.Errorf("at most %d redirect_uris are allowed", maxRedirectURIs)
	}
	for _, uri := range uris {
		u, err := url.Parse(uri)
		switch {
		case len(uri) > maxRedirectURILen:
			return fmt.Errorf("redirect URIs must be at most %d bytes", maxRedirectURILen)
		case err != nil || !u.IsAbs():
			return fmt.Errorf("redirect URI %q is not an absolute URL", uri)
		case strings.Contains(uri, "#") || u.User != nil:
			return fmt.Errorf("redirect URI %q must not have a fragment or user info", uri)
		case u.Scheme == "https" || (u.Scheme == "http" && loopback(u.Hostname())):
			if u.Host == "" {
				return fmt.Errorf("redirect URI %q has no host", uri)
			}
		case u.Scheme == "http" || unsafeSchemes[u.Scheme]:
			return fmt.Errorf("redirect URI %q must use https, http on 127.0.0.1, [::1], or localhost, or an app's own scheme", uri)
		}
	}
	return nil
}

// unsafeSchemes are never an app's private-use redirect scheme.
var unsafeSchemes = map[string]bool{
	"about": true, "blob": true, "data": true, "file": true, "ftp": true, "javascript": true,
	"mailto": true, "sms": true, "tel": true, "vbscript": true, "ws": true, "wss": true,
}

// redirectHost names where a redirect URI sends the browser, for the
// consent page: its host, or the scheme of a native app's URI.
func redirectHost(u *url.URL) string {
	if u.Host != "" {
		return u.Host
	}
	return u.Scheme + ":"
}

// redirectAllowed reports whether uri is one of the registered redirect
// URIs. Loopback http URIs match on any port: native apps listen on
// ephemeral ones (RFC 8252 §7.3).
func redirectAllowed(registered []string, uri string) bool {
	u, err := url.Parse(uri)
	if err != nil {
		return false
	}
	return slices.ContainsFunc(registered, func(candidate string) bool {
		if candidate == uri {
			return true
		}
		c, err := url.Parse(candidate)
		return err == nil && c.Scheme == "http" && u.Scheme == "http" && loopback(u.Hostname()) && c.Hostname() == u.Hostname() &&
			c.Path == u.Path && c.RawQuery == u.RawQuery && u.User == nil && !strings.Contains(uri, "#")
	})
}

func loopback(host string) bool { return host == "127.0.0.1" || host == "::1" || host == "localhost" }

// oauthError is an OAuth error response (RFC 6749 §5.2, RFC 7591 §3.2.2).
type oauthError struct {
	Code        string `json:"error"`
	Description string `json:"error_description,omitempty"`
}

func (e *oauthError) Error() string { return e.Code + ": " + e.Description }

// public lets browser-based MCP clients call a metadata, registration, or
// token endpoint from any origin. None of them use cookies.
func public(method string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The server sets no global read timeout (MCP calls are long), so
		// bound these small public bodies here.
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Second))
		w.Header().Set("Access-Control-Allow-Origin", "*")
		switch r.Method {
		case method:
			h(w, r)
		case http.MethodOptions:
			w.Header().Set("Access-Control-Allow-Methods", method+", OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Allow", method+", OPTIONS")
			http.Error(w, "Method not allowed.", http.StatusMethodNotAllowed)
		}
	}
}

// window is a fixed one-minute rate limit window.
type window struct {
	mu    sync.Mutex
	start time.Time
	count int
}

func (l *window) allow(now time.Time, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.start) >= time.Minute {
		l.start, l.count = now, 0
	}
	l.count++
	return l.count <= max
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

//go:embed pages/*.html
var pageFiles embed.FS

var pages = webui.Parse(pageFiles, nil, "pages/*.html")

func render(w http.ResponseWriter, status int, name string, data any) {
	webui.Render(w, pages, status, name, data)
}

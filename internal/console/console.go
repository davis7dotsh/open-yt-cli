// Package console is oytcd's YouTube side: channel connections and their
// Google tokens, the per-user MCP tool resolver, the web console, and the
// daily upkeep job.
package console

import (
	"embed"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"open-yt-cli/internal/mcpauth"
	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/seal"
	"open-yt-cli/internal/store"
	"open-yt-cli/internal/webui"
)

type Config struct {
	BaseURL string
	// Google is the OAuth client and its endpoints; Scopes is ignored.
	Google        oauth.Config
	YouTubeAPIKey string
	// Test overrides; empty means Google's production endpoints.
	YouTubeBaseURL   string
	AnalyticsBaseURL string
	HTTPClient       *http.Client
	Now              func() time.Time
}

type Console struct {
	cfg   Config
	store *store.Store
	box   *seal.Box
	auth  *mcpauth.Auth

	mu      sync.Mutex
	sources map[string]*oauth.TokenSource // by userID + "/" + channelID
}

func New(cfg Config, st *store.Store, box *seal.Box, a *mcpauth.Auth) *Console {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	cfg.Google.Now = cfg.Now
	cfg.Google.Scopes = []string{youtubeScope, analyticsScope}
	return &Console{cfg: cfg, store: st, box: box, auth: a, sources: map[string]*oauth.TokenSource{}}
}

func (c *Console) Register(mux *http.ServeMux) {
	protect := http.NewCrossOriginProtection()
	signedIn := func(h http.HandlerFunc) http.Handler { return c.auth.RequireSession(h) }
	post := func(h http.HandlerFunc) http.Handler { return protect.Handler(signedIn(h)) }

	mux.HandleFunc("GET /{$}", c.landing)
	mux.HandleFunc("GET /privacy", func(w http.ResponseWriter, r *http.Request) { render(w, http.StatusOK, "privacy", nil) })
	mux.Handle("GET /console", signedIn(func(w http.ResponseWriter, r *http.Request) { c.renderConsole(w, r, http.StatusOK, consolePage{}) }))
	mux.Handle("POST /channels/connect", post(c.connect))
	mux.Handle("GET /channels/callback", signedIn(c.connectCallback))
	mux.Handle("POST /channels/{id}/default", post(c.makeDefault))
	mux.Handle("POST /channels/{id}/disconnect", post(c.disconnect))
	mux.Handle("POST /keys", post(c.createKey))
	mux.Handle("POST /keys/{prefix}/revoke", post(c.revokeKey))
}

func (c *Console) landing(w http.ResponseWriter, r *http.Request) {
	if _, ok := c.auth.CurrentUser(r); ok {
		http.Redirect(w, r, "/console", http.StatusFound)
		return
	}
	render(w, http.StatusOK, "landing", nil)
}

type consolePage struct {
	Email     string
	DefaultID string
	Channels  []store.Channel
	Keys      []store.Token
	MCPURL    string
	// NewKey is a just-created API key, shown this once.
	NewKey string
	Error  string
}

func (c *Console) renderConsole(w http.ResponseWriter, r *http.Request, status int, page consolePage) {
	ctx := r.Context()
	userID := c.userID(r)
	user, err := c.store.User(ctx, userID)
	if err == nil {
		page.Channels, err = c.store.Channels(ctx, userID)
	}
	if err == nil {
		page.Keys, err = c.store.APIKeys(ctx, userID)
	}
	if err != nil {
		serverError(w, r, "load console", err)
		return
	}
	page.Email, page.DefaultID, page.MCPURL = user.Email, user.DefaultChannelID, c.cfg.BaseURL+"/mcp"
	render(w, status, "console", page)
}

func (c *Console) createKey(w http.ResponseWriter, r *http.Request) {
	key, err := c.auth.CreateAPIKey(r.Context(), c.userID(r), r.PostFormValue("name"))
	if err != nil {
		serverError(w, r, "create API key", err)
		return
	}
	c.renderConsole(w, r, http.StatusOK, consolePage{NewKey: key})
}

func (c *Console) revokeKey(w http.ResponseWriter, r *http.Request) {
	err := c.store.DeleteAPIKey(r.Context(), c.userID(r), r.PathValue("prefix"))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		serverError(w, r, "revoke API key", err)
		return
	}
	http.Redirect(w, r, "/console", http.StatusSeeOther)
}

func (c *Console) userID(r *http.Request) string {
	userID, _ := c.auth.CurrentUser(r)
	return userID
}

//go:embed pages/*.html
var pageFiles embed.FS

var pages = webui.Parse(pageFiles, template.FuncMap{
	"date": func(unix int64) string { return time.Unix(unix, 0).UTC().Format("Jan 2, 2006") },
}, "pages/*.html")

func render(w http.ResponseWriter, status int, name string, data any) {
	webui.Render(w, pages, status, name, data)
}

func serverError(w http.ResponseWriter, r *http.Request, action string, err error) {
	slog.ErrorContext(r.Context(), action, "err", err)
	http.Error(w, "Something went wrong.", http.StatusInternalServerError)
}

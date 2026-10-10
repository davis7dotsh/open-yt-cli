// Command oytcd is the hosted oytc server: a web console for connecting
// YouTube channels and minting API keys, and a bearer-protected MCP endpoint
// that exposes oytc's read-only tools for the connected channels.
package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"open-yt-cli/internal/console"
	"open-yt-cli/internal/mcpauth"
	"open-yt-cli/internal/mcptools"
	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/seal"
	"open-yt-cli/internal/store"
	"open-yt-cli/internal/version"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "oytcd: %v\n", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg); err != nil {
		slog.Error("oytcd stopped", "err", err)
		os.Exit(1)
	}
}

type config struct {
	BaseURL            string
	DBPath             string
	SecretKey          []byte
	GoogleClientID     string
	GoogleClientSecret string
	YouTubeAPIKey      string
	AllowedEmails      []string
	Port               string

	// Test overrides; zero values mean Google's production endpoints, a
	// default HTTP client, and the real clock.
	GoogleAuthURL     string
	GoogleTokenURL    string
	GoogleRevokeURL   string
	GoogleUserInfoURL string
	YouTubeBaseURL    string
	AnalyticsBaseURL  string
	HTTPClient        *http.Client
	Now               func() time.Time
}

func loadConfig(getenv func(string) string) (config, error) {
	cfg := config{
		BaseURL:            strings.TrimRight(strings.TrimSpace(getenv("OYTCD_BASE_URL")), "/"),
		DBPath:             valueOr(getenv("OYTCD_DB_PATH"), "/data/oytcd.db"),
		GoogleClientID:     strings.TrimSpace(getenv("OYTCD_GOOGLE_CLIENT_ID")),
		GoogleClientSecret: strings.TrimSpace(getenv("OYTCD_GOOGLE_CLIENT_SECRET")),
		YouTubeAPIKey:      strings.TrimSpace(getenv("OYTCD_YOUTUBE_API_KEY")),
		Port:               valueOr(getenv("PORT"), "8080"),
	}
	for _, email := range strings.Split(getenv("OYTCD_ALLOWED_EMAILS"), ",") {
		if email = strings.ToLower(strings.TrimSpace(email)); email != "" {
			cfg.AllowedEmails = append(cfg.AllowedEmails, email)
		}
	}
	var problems []string
	for _, required := range []struct{ name, value string }{
		{"OYTCD_BASE_URL", cfg.BaseURL},
		{"OYTCD_SECRET_KEY", getenv("OYTCD_SECRET_KEY")},
		{"OYTCD_GOOGLE_CLIENT_ID", cfg.GoogleClientID},
		{"OYTCD_GOOGLE_CLIENT_SECRET", cfg.GoogleClientSecret},
		{"OYTCD_YOUTUBE_API_KEY", cfg.YouTubeAPIKey},
		{"OYTCD_ALLOWED_EMAILS", strings.Join(cfg.AllowedEmails, ",")},
	} {
		if strings.TrimSpace(required.value) == "" {
			problems = append(problems, required.name+" is required")
		}
	}
	if cfg.BaseURL != "" {
		if u, err := url.Parse(cfg.BaseURL); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.Path != "" || u.RawQuery != "" {
			problems = append(problems, "OYTCD_BASE_URL must be an origin like https://oytc.davis7.sh")
		}
	}
	if secret := strings.TrimSpace(getenv("OYTCD_SECRET_KEY")); secret != "" {
		key, err := base64.StdEncoding.DecodeString(secret)
		if err != nil || len(key) != 32 {
			problems = append(problems, "OYTCD_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)")
		}
		cfg.SecretKey = key
	}
	if len(problems) > 0 {
		return config{}, errors.New("invalid configuration:\n  " + strings.Join(problems, "\n  "))
	}
	return cfg, nil
}

func run(ctx context.Context, cfg config) error {
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database %s: %w", cfg.DBPath, err)
	}
	defer st.Close()
	handler, con, err := newHandler(cfg, st)
	if err != nil {
		return err
	}
	go con.RunUpkeep(ctx)

	server := &http.Server{Addr: ":" + cfg.Port, Handler: logRequests(handler), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	served := make(chan error, 1)
	go func() { served <- server.ListenAndServe() }()
	slog.Info("listening", "addr", server.Addr, "base_url", cfg.BaseURL, "version", version.Get().Version)
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

// newHandler wires every route: sign-in (mcpauth), the console (console),
// /mcp, and /healthz.
func newHandler(cfg config, st *store.Store) (http.Handler, *console.Console, error) {
	box, err := seal.New(cfg.SecretKey)
	if err != nil {
		return nil, nil, err
	}
	google := oauth.Config{
		ClientID: cfg.GoogleClientID, ClientSecret: cfg.GoogleClientSecret,
		AuthorizationURL: cfg.GoogleAuthURL, TokenURL: cfg.GoogleTokenURL, RevokeURL: cfg.GoogleRevokeURL,
		HTTPClient: cfg.HTTPClient,
	}
	authn := mcpauth.New(mcpauth.Config{
		BaseURL: cfg.BaseURL, Google: google, UserInfoURL: cfg.GoogleUserInfoURL, AllowedEmails: cfg.AllowedEmails, Now: cfg.Now,
	}, st, box)
	con := console.New(console.Config{
		BaseURL: cfg.BaseURL, Google: google, YouTubeAPIKey: cfg.YouTubeAPIKey,
		YouTubeBaseURL: cfg.YouTubeBaseURL, AnalyticsBaseURL: cfg.AnalyticsBaseURL, HTTPClient: cfg.HTTPClient, Now: cfg.Now,
	}, st, box, authn)

	mux := http.NewServeMux()
	authn.Register(mux)
	con.Register(mux)

	serverVersion := version.Get().Version
	cache := mcp.NewSchemaCache()
	mcpHandler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		userID := auth.TokenInfoFromContext(r.Context()).UserID
		return mcptools.NewServer(con.Resolver(userID), mcptools.Options{Version: serverVersion, SchemaCache: cache})
	}, &mcp.StreamableHTTPOptions{Stateless: true})
	bearer := auth.RequireBearerToken(authn.Verify, &auth.RequireBearerTokenOptions{
		// API keys never expire; OAuth access tokens carry an Expiration.
		AllowMissingExpiration: true,
		// ResourceMetadataURL goes here once the MCP OAuth server serves
		// /.well-known/oauth-protected-resource, so 401s point clients at it.
	})
	mux.Handle("/mcp", bearer(mcpHandler))

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := st.Ping(r.Context()); err != nil {
			slog.ErrorContext(r.Context(), "health check", "err", err)
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, "ok")
	})
	return mux, con, nil
}

// logRequests logs one line per request. Only the path is logged: OAuth
// callback query strings carry authorization codes.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", recorder.status, "duration_ms", time.Since(start).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap lets http.ResponseController reach Flush for MCP's SSE responses.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func valueOr(value, fallback string) string {
	if value = strings.TrimSpace(value); value == "" {
		return fallback
	}
	return value
}

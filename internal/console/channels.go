package console

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/mcptools"
	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/store"
	"open-yt-cli/internal/youtube"
)

const (
	youtubeScope   = "https://www.googleapis.com/auth/youtube.readonly"
	analyticsScope = "https://www.googleapis.com/auth/yt-analytics.readonly"
)

func (c *Console) connect(w http.ResponseWriter, r *http.Request) {
	flow := c.auth.StartFlow(w, "connect", "")
	target := oauth.AuthorizationURL(c.cfg.Google, c.cfg.BaseURL+"/channels/callback", flow.State, flow.Verifier,
		oauth2.SetAuthURLParam("prompt", "consent select_account"))
	http.Redirect(w, r, target, http.StatusSeeOther)
}

func (c *Console) connectCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := c.userID(r)
	fail := func(status int, message string) { c.renderConsole(w, r, status, consolePage{Error: message}) }
	flow, code, err := c.auth.FinishFlow(w, r, "connect")
	if err != nil {
		fail(http.StatusBadRequest, err.Error())
		return
	}
	token, err := oauth.Exchange(ctx, c.cfg.Google, code, c.cfg.BaseURL+"/channels/callback", flow.Verifier)
	if err != nil {
		slog.WarnContext(ctx, "channel token exchange failed", "err", err)
		fail(http.StatusBadGateway, "Google did not accept the authorization. Please try again.")
		return
	}
	// Google lets users untick individual scopes on the consent screen.
	if !slices.Contains(token.Scopes, youtubeScope) || !slices.Contains(token.Scopes, analyticsScope) {
		fail(http.StatusBadRequest, "Tick both YouTube permissions on Google's consent screen, then connect again.")
		return
	}
	if token.RefreshToken == "" {
		fail(http.StatusBadRequest, "Google did not return a refresh token. Please connect again.")
		return
	}
	client := c.dataClient()
	client.TokenSource = func(context.Context, bool) (string, error) { return token.AccessToken, nil }
	mine, err := client.Get(ctx, "channels", url.Values{"part": {"snippet"}, "mine": {"true"}})
	if err != nil {
		slog.WarnContext(ctx, "look up connected channel", "err", err)
		fail(http.StatusBadGateway, "Could not read the YouTube channel. Please try again.")
		return
	}
	if len(mine.Items) == 0 {
		fail(http.StatusBadRequest, "This Google account has no YouTube channel.")
		return
	}
	channelID, _ := mine.Items[0]["id"].(string)
	snippet, _ := mine.Items[0]["snippet"].(map[string]any)
	title, _ := snippet["title"].(string)
	handle, _ := snippet["customUrl"].(string)
	if channelID == "" {
		fail(http.StatusBadGateway, "Could not read the YouTube channel. Please try again.")
		return
	}
	now := c.cfg.Now().Unix()
	// Reconnecting replaces the stored token without revoking the old one:
	// Google's revoke ends the whole grant, including the new token.
	err = c.store.UpsertChannel(ctx, store.Channel{
		UserID: userID, ChannelID: channelID, Title: title, Handle: handle, Scopes: strings.Join(token.Scopes, " "),
		RefreshToken: c.box.Seal([]byte(token.RefreshToken), refreshPurpose(userID, channelID)), CheckedAt: now, CreatedAt: now,
	})
	if err != nil {
		serverError(w, r, "save channel", err)
		return
	}
	c.forget(userID, channelID)
	http.Redirect(w, r, "/console", http.StatusSeeOther)
}

func (c *Console) makeDefault(w http.ResponseWriter, r *http.Request) {
	err := c.store.SetDefaultChannel(r.Context(), c.userID(r), r.PathValue("id"))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		serverError(w, r, "set default channel", err)
		return
	}
	http.Redirect(w, r, "/console", http.StatusSeeOther)
}

func (c *Console) disconnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID, channelID := c.userID(r), r.PathValue("id")
	channels, err := c.store.Channels(ctx, userID)
	if err != nil {
		serverError(w, r, "load channels", err)
		return
	}
	index := slices.IndexFunc(channels, func(ch store.Channel) bool { return ch.ChannelID == channelID })
	if index < 0 {
		http.Redirect(w, r, "/console", http.StatusSeeOther)
		return
	}
	if refresh, err := c.box.Open(channels[index].RefreshToken, refreshPurpose(userID, channelID)); err == nil {
		if err := oauth.Revoke(ctx, c.cfg.Google, string(refresh)); err != nil {
			slog.WarnContext(ctx, "revoke Google token", "channel", channelID, "err", err)
		}
	}
	if err := c.store.DeleteChannel(ctx, userID, channelID); err != nil && !errors.Is(err, store.ErrNotFound) {
		serverError(w, r, "delete channel", err)
		return
	}
	c.forget(userID, channelID)
	http.Redirect(w, r, "/console", http.StatusSeeOther)
}

// Resolver builds the MCP tool clients for one user.
func (c *Console) Resolver(userID string) mcptools.Resolver {
	return mcptools.Resolver{
		Data: func(context.Context) (*youtube.Client, error) { return c.dataClient(), nil },
		Analytics: func(ctx context.Context, channel string) (*analytics.Client, error) {
			ch, err := c.channel(ctx, userID, channel)
			if err != nil {
				return nil, err
			}
			client := analytics.NewClient(c.accessToken(ch), 20*time.Second)
			if c.cfg.AnalyticsBaseURL != "" {
				client.SetBaseURL(c.cfg.AnalyticsBaseURL)
			}
			if c.cfg.HTTPClient != nil {
				client.SetHTTPClient(c.cfg.HTTPClient)
			}
			return client, nil
		},
		Channels: func(ctx context.Context) ([]mcptools.Channel, error) {
			user, err := c.store.User(ctx, userID)
			if err != nil {
				return nil, err
			}
			channels, err := c.store.Channels(ctx, userID)
			if err != nil {
				return nil, err
			}
			out := make([]mcptools.Channel, 0, len(channels))
			for _, ch := range channels {
				out = append(out, mcptools.Channel{ID: ch.ChannelID, Title: ch.Title, Handle: ch.Handle, Default: ch.ChannelID == user.DefaultChannelID, Status: ch.Status})
			}
			return out, nil
		},
	}
}

func (c *Console) dataClient() *youtube.Client {
	client := youtube.NewClient(c.cfg.YouTubeAPIKey, 20*time.Second)
	if c.cfg.YouTubeBaseURL != "" {
		client.BaseURL = c.cfg.YouTubeBaseURL
	}
	if c.cfg.HTTPClient != nil {
		client.HTTPClient = c.cfg.HTTPClient
	}
	return client
}

// channel finds a connected channel by ID or handle (with or without "@");
// an empty ref means the user's default channel.
func (c *Console) channel(ctx context.Context, userID, ref string) (store.Channel, error) {
	if ref == "" {
		user, err := c.store.User(ctx, userID)
		if err != nil {
			return store.Channel{}, err
		}
		if user.DefaultChannelID == "" {
			return store.Channel{}, fmt.Errorf("no YouTube channel is connected; connect one at %s/console", c.cfg.BaseURL)
		}
		ref = user.DefaultChannelID
	}
	channels, err := c.store.Channels(ctx, userID)
	if err != nil {
		return store.Channel{}, err
	}
	handle := strings.TrimPrefix(ref, "@")
	for _, ch := range channels {
		if ch.ChannelID == ref || (ch.Handle != "" && strings.EqualFold(strings.TrimPrefix(ch.Handle, "@"), handle)) {
			if ch.Status == store.StatusRevoked {
				return store.Channel{}, &revokedError{title: ch.Title, baseURL: c.cfg.BaseURL}
			}
			return ch, nil
		}
	}
	return store.Channel{}, fmt.Errorf("channel %s is not connected; connect it at %s/console", ref, c.cfg.BaseURL)
}

// revokedError replaces the oauth package's message, which points at CLI
// commands, while still matching oauth.ErrGrantRevoked.
type revokedError struct{ title, baseURL string }

func (e *revokedError) Error() string {
	return fmt.Sprintf("Google access for %s was revoked; reconnect it at %s/console", e.title, e.baseURL)
}

func (e *revokedError) Unwrap() error { return oauth.ErrGrantRevoked }

// accessToken mints Google access tokens for a channel from its cached token
// source. A revoked grant marks the channel revoked.
func (c *Console) accessToken(ch store.Channel) youtube.TokenSource {
	return func(ctx context.Context, force bool) (string, error) {
		source, err := c.source(ch)
		if err != nil {
			return "", err
		}
		token, err := source.AccessToken(ctx, force)
		if errors.Is(err, oauth.ErrGrantRevoked) {
			c.forget(ch.UserID, ch.ChannelID)
			err := c.store.SetChannelStatus(context.WithoutCancel(ctx), ch.UserID, ch.ChannelID, store.StatusRevoked, c.cfg.Now().Unix())
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				slog.ErrorContext(ctx, "mark channel revoked", "channel", ch.ChannelID, "err", err)
			}
			return "", &revokedError{title: ch.Title, baseURL: c.cfg.BaseURL}
		}
		if oauthErr := (*oauth.Error)(nil); errors.As(err, &oauthErr) && oauthErr.Code == "invalid_client" {
			slog.ErrorContext(ctx, "Google rejected the OAuth client; check OYTCD_GOOGLE_CLIENT_ID and OYTCD_GOOGLE_CLIENT_SECRET", "err", err)
			return "", errors.New("the server's Google OAuth client was rejected; its owner needs to fix the server configuration")
		}
		return token, err
	}
}

func (c *Console) source(ch store.Channel) (*oauth.TokenSource, error) {
	key := ch.UserID + "/" + ch.ChannelID
	c.mu.Lock()
	defer c.mu.Unlock()
	if source, ok := c.sources[key]; ok {
		return source, nil
	}
	purpose := refreshPurpose(ch.UserID, ch.ChannelID)
	refresh, err := c.box.Open(ch.RefreshToken, purpose)
	if err != nil {
		return nil, fmt.Errorf("unseal Google token for %s: %w", ch.Title, err)
	}
	// OnUpdate runs under the token source's lock, so current needs no
	// lock of its own.
	current := string(refresh)
	source := &oauth.TokenSource{
		Config: c.cfg.Google,
		Token:  oauth.Token{RefreshToken: current},
		OnUpdate: func(token oauth.Token) error {
			if token.RefreshToken == current {
				return nil
			}
			if err := c.store.SetRefreshToken(context.Background(), ch.UserID, ch.ChannelID, c.box.Seal([]byte(token.RefreshToken), purpose)); err != nil {
				return err
			}
			current = token.RefreshToken
			return nil
		},
	}
	c.sources[key] = source
	return source, nil
}

// forget drops a cached token source after its channel changed.
func (c *Console) forget(userID, channelID string) {
	c.mu.Lock()
	delete(c.sources, userID+"/"+channelID)
	c.mu.Unlock()
}

// refreshPurpose binds a sealed refresh token to its row.
func refreshPurpose(userID, channelID string) []byte {
	return []byte("refresh:" + userID + "/" + channelID)
}

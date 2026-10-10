package console

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/store"
)

// revokedRetention is how long a revoked channel stays listed (so the user
// sees why it stopped working) before upkeep deletes it.
const revokedRetention = 30 * 24 * time.Hour

// RunUpkeep runs Upkeep a minute after start and then daily until ctx ends.
func (c *Console) RunUpkeep(ctx context.Context) {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		c.Upkeep(ctx)
		timer.Reset(24 * time.Hour)
	}
}

// Upkeep refreshes every healthy channel's Google grant so revocations
// surface in the console, deletes long-revoked channels, and purges expired
// sessions and tokens.
func (c *Console) Upkeep(ctx context.Context) {
	now := c.cfg.Now()
	channels, err := c.store.ChannelsWithStatus(ctx, store.StatusOK)
	if err != nil {
		slog.ErrorContext(ctx, "upkeep: list channels", "err", err)
	}
	var checked, revoked, failed int
	for _, ch := range channels {
		_, err := c.accessToken(ch)(ctx, true)
		switch {
		case err == nil:
			checked++
			if err := c.store.SetChannelStatus(ctx, ch.UserID, ch.ChannelID, store.StatusOK, now.Unix()); err != nil && !errors.Is(err, store.ErrNotFound) {
				slog.ErrorContext(ctx, "upkeep: record check", "channel", ch.ChannelID, "err", err)
			}
		case errors.Is(err, oauth.ErrGrantRevoked):
			revoked++
		default:
			failed++
			slog.WarnContext(ctx, "upkeep: refresh failed", "channel", ch.ChannelID, "err", err)
		}
	}
	deleted, err := c.store.DeleteRevokedChannels(ctx, now.Add(-revokedRetention).Unix())
	if err != nil {
		slog.ErrorContext(ctx, "upkeep: delete revoked channels", "err", err)
	}
	purged, err := c.store.Purge(ctx, now.Unix())
	if err != nil {
		slog.ErrorContext(ctx, "upkeep: purge", "err", err)
	}
	slog.InfoContext(ctx, "upkeep",
		"checked", checked, "revoked", revoked, "failed", failed, "deleted_channels", deleted,
		"expired_sessions", purged.Sessions, "expired_access_tokens", purged.AccessTokens,
		"expired_oauth_codes", purged.OAuthCodes, "expired_oauth_refresh", purged.OAuthRefresh, "unused_oauth_clients", purged.OAuthClients)
}

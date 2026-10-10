package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestStore(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "oytcd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	user, err := s.UpsertUser(ctx, "sub-1", "ben@example.com", 100)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.UpsertUser(ctx, "sub-1", "new@example.com", 200)
	if err != nil || again.ID != user.ID || again.Email != "new@example.com" || again.CreatedAt != 100 {
		t.Fatalf("second upsert = %+v, %v (first %+v)", again, err, user)
	}

	if err := s.CreateSession(ctx, []byte("session"), user.ID, 1000); err != nil {
		t.Fatal(err)
	}
	if got, err := s.SessionUser(ctx, []byte("session"), 999); err != nil || got != user.ID {
		t.Fatalf("SessionUser = %q, %v", got, err)
	}
	if _, err := s.SessionUser(ctx, []byte("session"), 1000); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired session err = %v", err)
	}

	key := Token{Hash: []byte("key"), UserID: user.ID, Kind: KindAPIKey, Label: "laptop", Prefix: "oytc_k_abcde", CreatedAt: 100}
	if err := s.CreateToken(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateToken(ctx, Token{Hash: []byte("access"), UserID: user.ID, Kind: KindAccess, Label: "Claude", Prefix: "oytc_at_abcd", ClientID: "client", ExpiresAt: 500, CreatedAt: 100}); err != nil {
		t.Fatal(err)
	}
	if err := s.TouchToken(ctx, []byte("key"), 150); err != nil {
		t.Fatal(err)
	}
	got, err := s.TokenByHash(ctx, []byte("key"))
	if err != nil || got.Label != "laptop" || got.LastUsedAt != 150 || got.ExpiresAt != 0 || got.ClientID != "" {
		t.Fatalf("TokenByHash = %+v, %v", got, err)
	}
	if keys, err := s.APIKeys(ctx, user.ID); err != nil || len(keys) != 1 || keys[0].Prefix != "oytc_k_abcde" {
		t.Fatalf("APIKeys = %+v, %v", keys, err)
	}

	for _, id := range []string{"UC1", "UC2"} {
		if err := s.UpsertChannel(ctx, Channel{UserID: user.ID, ChannelID: id, Title: id, Scopes: "s", RefreshToken: []byte("sealed"), CreatedAt: 100}); err != nil {
			t.Fatal(err)
		}
	}
	if u, _ := s.User(ctx, user.ID); u.DefaultChannelID != "UC1" {
		t.Fatalf("default = %q, want first channel", u.DefaultChannelID)
	}
	if err := s.SetDefaultChannel(ctx, user.ID, "UC9"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("default to unknown channel err = %v", err)
	}
	if err := s.SetChannelStatus(ctx, user.ID, "UC2", StatusRevoked, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.SetDefaultChannel(ctx, user.ID, "UC2"); err != nil {
		t.Fatal(err)
	}
	if n, err := s.DeleteRevokedChannels(ctx, 11); err != nil || n != 1 {
		t.Fatalf("DeleteRevokedChannels = %d, %v", n, err)
	}
	if u, _ := s.User(ctx, user.ID); u.DefaultChannelID != "UC1" {
		t.Fatalf("default after delete = %q, want UC1", u.DefaultChannelID)
	}
	if err := s.DeleteChannel(ctx, user.ID, "UC1"); err != nil {
		t.Fatal(err)
	}
	if u, _ := s.User(ctx, user.ID); u.DefaultChannelID != "" {
		t.Fatalf("default after last delete = %q, want empty", u.DefaultChannelID)
	}

	purged, err := s.Purge(ctx, 1000)
	if err != nil || purged.Sessions != 1 || purged.AccessTokens != 1 {
		t.Fatalf("Purge = %+v, %v", purged, err)
	}
	if _, err := s.TokenByHash(ctx, []byte("key")); err != nil {
		t.Fatalf("Purge removed a non-expiring API key: %v", err)
	}

	// Reopening an existing database must not reapply anything destructive,
	// and deleting a user cascades to everything they own.
	s.Close()
	if s, err = Open(path); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertChannel(ctx, Channel{UserID: user.ID, ChannelID: "UC3", Title: "t", Scopes: "s", RefreshToken: []byte("x"), CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, []byte("session-2"), user.ID, 5000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("DELETE FROM users WHERE id = ?", user.ID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sessions", "tokens", "channels"} {
		var n int
		if err := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s rows after user delete = %d, %v", table, n, err)
		}
	}
}

func TestOAuth(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "oytcd.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	user, err := s.UpsertUser(ctx, "sub-1", "ben@example.com", 100)
	if err != nil {
		t.Fatal(err)
	}

	client := OAuthClient{ID: "client", Name: "Claude", RedirectURIs: []string{"https://claude.ai/callback"}, CreatedAt: 100}
	if err := s.SaveOAuthClient(ctx, client); err != nil {
		t.Fatal(err)
	}
	client.Name, client.CreatedAt = "Claude 2", 200
	if err := s.SaveOAuthClient(ctx, client); err != nil {
		t.Fatal(err)
	}
	if got, err := s.OAuthClient(ctx, "client"); err != nil || got.Name != "Claude 2" || got.CreatedAt != 100 || len(got.RedirectURIs) != 1 {
		t.Fatalf("OAuthClient = %+v, %v", got, err)
	}

	code := OAuthCode{Hash: []byte("code"), ClientID: "client", UserID: user.ID, RedirectURI: "https://claude.ai/callback", Challenge: "c", ExpiresAt: 500}
	if err := s.CreateOAuthCode(ctx, code); err != nil {
		t.Fatal(err)
	}
	if got, err := s.RedeemOAuthCode(ctx, []byte("code"), 499); err != nil || got.UserID != user.ID || got.Challenge != "c" {
		t.Fatalf("RedeemOAuthCode = %+v, %v", got, err)
	}
	if _, err := s.RedeemOAuthCode(ctx, []byte("code"), 499); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second redeem err = %v", err)
	}
	code.Hash = []byte("expired")
	if err := s.CreateOAuthCode(ctx, code); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RedeemOAuthCode(ctx, []byte("expired"), 500); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired redeem err = %v", err)
	}

	access := func(hash string) Token {
		return Token{Hash: []byte(hash), Kind: KindAccess, Label: "Claude", Prefix: hash, ClientID: "client", ExpiresAt: 1000, CreatedAt: 300}
	}
	first := access("access-1")
	first.UserID = user.ID
	if err := s.CreateOAuthGrant(ctx, first, OAuthRefresh{Hash: []byte("refresh-1"), ClientID: "client", UserID: user.ID, ExpiresAt: 2000}); err != nil {
		t.Fatal(err)
	}
	if err := s.RotateOAuthGrant(ctx, []byte("refresh-1"), 300, access("x"), OAuthRefresh{Hash: []byte("x"), ClientID: "other", ExpiresAt: 2000}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rotate as another client err = %v", err)
	}
	if err := s.RotateOAuthGrant(ctx, []byte("refresh-1"), 300, access("access-2"), OAuthRefresh{Hash: []byte("refresh-2"), ClientID: "client", ExpiresAt: 2000}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.TokenByHash(ctx, []byte("access-2")); err != nil || got.UserID != user.ID {
		t.Fatalf("rotated access token = %+v, %v", got, err)
	}
	if err := s.RotateOAuthGrant(ctx, []byte("refresh-1"), 300, access("access-3"), OAuthRefresh{Hash: []byte("refresh-3"), ClientID: "client", ExpiresAt: 2000}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reused refresh token err = %v", err)
	}

	if apps, err := s.OAuthApps(ctx, user.ID, 300); err != nil || len(apps) != 1 || apps[0].Name != "Claude 2" || apps[0].LastUsedAt != 300 {
		t.Fatalf("OAuthApps = %+v, %v", apps, err)
	}
	if err := s.DeleteOAuthGrant(ctx, user.ID, "client"); err != nil {
		t.Fatal(err)
	}
	if apps, err := s.OAuthApps(ctx, user.ID, 300); err != nil || len(apps) != 0 {
		t.Fatalf("OAuthApps after revoke = %+v, %v", apps, err)
	}
	if _, err := s.TokenByHash(ctx, []byte("access-2")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("access token after revoke err = %v", err)
	}
}

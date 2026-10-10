// Package store is oytcd's SQLite persistence: hand-written queries over the
// embedded schema. Timestamps are unix seconds; zero means NULL.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

// schemaVersion is stored in PRAGMA user_version; bump it with a migration.
const schemaVersion = 1

var ErrNotFound = errors.New("not found")

const (
	KindAPIKey = "api_key"
	KindAccess = "access"

	StatusOK      = "ok"
	StatusRevoked = "revoked"
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	// Pragmas apply per connection; immediate transactions take the write
	// lock up front so concurrent writers wait on busy_timeout instead of
	// failing mid-transaction.
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	if version >= schemaVersion {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error {
	return s.db.QueryRowContext(ctx, "SELECT 1").Scan(new(int))
}

// --- users ---

type User struct {
	ID               string
	GoogleSub        string
	Email            string
	DefaultChannelID string
	CreatedAt        int64
}

const userColumns = "id, google_sub, email, default_channel_id, created_at"

func scanUser(row *sql.Row) (User, error) {
	var u User
	var defaultChannel sql.NullString
	err := row.Scan(&u.ID, &u.GoogleSub, &u.Email, &defaultChannel, &u.CreatedAt)
	u.DefaultChannelID = defaultChannel.String
	return u, notFound(err)
}

// UpsertUser finds the user for a Google account, creating it on first
// sign-in and refreshing its email otherwise.
func (s *Store) UpsertUser(ctx context.Context, googleSub, email string, now int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email
		RETURNING `+userColumns, rand.Text(), googleSub, email, now))
}

func (s *Store) User(ctx context.Context, id string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, "SELECT "+userColumns+" FROM users WHERE id = ?", id))
}

// SetDefaultChannel fails with ErrNotFound unless the user has the channel.
func (s *Store) SetDefaultChannel(ctx context.Context, userID, channelID string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE users SET default_channel_id = ?
		WHERE id = ? AND EXISTS (SELECT 1 FROM channels WHERE user_id = ? AND channel_id = ?)`, channelID, userID, userID, channelID)
	return affected(result, err)
}

// --- sessions ---

func (s *Store) CreateSession(ctx context.Context, hash []byte, userID string, expiresAt int64) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, ?)", hash, userID, expiresAt)
	return err
}

// SessionUser returns the user of an unexpired session.
func (s *Store) SessionUser(ctx context.Context, hash []byte, now int64) (string, error) {
	var userID string
	err := s.db.QueryRowContext(ctx, "SELECT user_id FROM sessions WHERE hash = ? AND expires_at > ?", hash, now).Scan(&userID)
	return userID, notFound(err)
}

func (s *Store) DeleteSession(ctx context.Context, hash []byte) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE hash = ?", hash)
	return err
}

// --- tokens (console API keys and MCP OAuth access tokens) ---

type Token struct {
	Hash       []byte
	UserID     string
	Kind       string
	Label      string
	Prefix     string
	ClientID   string
	ExpiresAt  int64
	LastUsedAt int64
	CreatedAt  int64
}

const tokenColumns = "hash, user_id, kind, label, prefix, client_id, expires_at, last_used_at, created_at"

func scanToken(scan func(...any) error) (Token, error) {
	var t Token
	var clientID sql.NullString
	var expiresAt, lastUsedAt sql.NullInt64
	err := scan(&t.Hash, &t.UserID, &t.Kind, &t.Label, &t.Prefix, &clientID, &expiresAt, &lastUsedAt, &t.CreatedAt)
	t.ClientID, t.ExpiresAt, t.LastUsedAt = clientID.String, expiresAt.Int64, lastUsedAt.Int64
	return t, notFound(err)
}

func (s *Store) CreateToken(ctx context.Context, t Token) error {
	return insertToken(ctx, s.db, t)
}

func insertToken(ctx context.Context, db execer, t Token) error {
	_, err := db.ExecContext(ctx, "INSERT INTO tokens ("+tokenColumns+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		t.Hash, t.UserID, t.Kind, t.Label, t.Prefix, nullString(t.ClientID), nullInt(t.ExpiresAt), nullInt(t.LastUsedAt), t.CreatedAt)
	return err
}

func (s *Store) TokenByHash(ctx context.Context, hash []byte) (Token, error) {
	return scanToken(s.db.QueryRowContext(ctx, "SELECT "+tokenColumns+" FROM tokens WHERE hash = ?", hash).Scan)
}

func (s *Store) TouchToken(ctx context.Context, hash []byte, now int64) error {
	_, err := s.db.ExecContext(ctx, "UPDATE tokens SET last_used_at = ? WHERE hash = ?", now, hash)
	return err
}

// APIKeys lists a user's console API keys, newest first.
func (s *Store) APIKeys(ctx context.Context, userID string) ([]Token, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+tokenColumns+" FROM tokens WHERE user_id = ? AND kind = ? ORDER BY created_at DESC, prefix", userID, KindAPIKey)
	if err != nil {
		return nil, err
	}
	return collect(rows, func(rows *sql.Rows) (Token, error) { return scanToken(rows.Scan) })
}

func (s *Store) DeleteAPIKey(ctx context.Context, userID, prefix string) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM tokens WHERE user_id = ? AND kind = ? AND prefix = ?", userID, KindAPIKey, prefix)
	return affected(result, err)
}

// --- MCP OAuth clients, authorization codes, and refresh tokens ---

// OAuthClient is a dynamically registered client, or a client whose
// metadata document (its client_id is the document's URL) was consented to.
type OAuthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
	CreatedAt    int64
}

// SaveOAuthClient adds a client, or updates an existing one's name and
// redirect URIs.
func (s *Store) SaveOAuthClient(ctx context.Context, c OAuthClient) error {
	uris, err := json.Marshal(c.RedirectURIs)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris`, c.ID, c.Name, string(uris), c.CreatedAt)
	return err
}

func (s *Store) OAuthClient(ctx context.Context, clientID string) (OAuthClient, error) {
	c := OAuthClient{ID: clientID}
	var uris string
	err := s.db.QueryRowContext(ctx, "SELECT name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?", clientID).Scan(&c.Name, &uris, &c.CreatedAt)
	if err != nil {
		return OAuthClient{}, notFound(err)
	}
	return c, json.Unmarshal([]byte(uris), &c.RedirectURIs)
}

type OAuthCode struct {
	Hash        []byte
	ClientID    string
	UserID      string
	RedirectURI string
	// Challenge is the PKCE S256 code challenge.
	Challenge string
	ExpiresAt int64
}

func (s *Store) CreateOAuthCode(ctx context.Context, c OAuthCode) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
		c.Hash, c.ClientID, c.UserID, c.RedirectURI, c.Challenge, c.ExpiresAt)
	return err
}

// RedeemOAuthCode deletes and returns an unexpired authorization code, so
// each code works once.
func (s *Store) RedeemOAuthCode(ctx context.Context, hash []byte, now int64) (OAuthCode, error) {
	c := OAuthCode{Hash: hash}
	err := s.db.QueryRowContext(ctx, "DELETE FROM oauth_codes WHERE hash = ? AND expires_at > ? RETURNING client_id, user_id, redirect_uri, challenge, expires_at",
		hash, now).Scan(&c.ClientID, &c.UserID, &c.RedirectURI, &c.Challenge, &c.ExpiresAt)
	return c, notFound(err)
}

type OAuthRefresh struct {
	Hash      []byte
	ClientID  string
	UserID    string
	ExpiresAt int64
}

// CreateOAuthGrant stores an access token together with its refresh token.
func (s *Store) CreateOAuthGrant(ctx context.Context, access Token, refresh OAuthRefresh) error {
	return s.inTx(ctx, func(tx *sql.Tx) error { return insertGrant(ctx, tx, access, refresh) })
}

// RotateOAuthGrant redeems the unexpired refresh token oldHash of
// refresh.ClientID: it is deleted, and access and refresh are stored for its
// user. It fails with ErrNotFound if the old token is unknown, expired,
// already used, or another client's.
func (s *Store) RotateOAuthGrant(ctx context.Context, oldHash []byte, now int64, access Token, refresh OAuthRefresh) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		var userID string
		err := tx.QueryRowContext(ctx, "DELETE FROM oauth_refresh WHERE hash = ? AND client_id = ? AND expires_at > ? RETURNING user_id",
			oldHash, refresh.ClientID, now).Scan(&userID)
		if err != nil {
			return notFound(err)
		}
		access.UserID, refresh.UserID = userID, userID
		return insertGrant(ctx, tx, access, refresh)
	})
}

func insertGrant(ctx context.Context, tx *sql.Tx, access Token, refresh OAuthRefresh) error {
	if err := insertToken(ctx, tx, access); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO oauth_refresh (hash, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)",
		refresh.Hash, refresh.ClientID, refresh.UserID, refresh.ExpiresAt)
	return err
}

// OAuthApp is a client holding unexpired MCP OAuth tokens for a user.
type OAuthApp struct {
	ClientID  string
	Name      string
	CreatedAt int64
	// LastUsedAt is the latest use or issue of one of its access tokens; 0
	// once they have all been purged.
	LastUsedAt int64
}

// OAuthApps lists the clients with an unexpired access or refresh token for
// a user, newest first.
func (s *Store) OAuthApps(ctx context.Context, userID string, now int64) ([]OAuthApp, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.client_id, c.name, c.created_at,
		(SELECT MAX(COALESCE(t.last_used_at, t.created_at)) FROM tokens t WHERE t.user_id = ? AND t.kind = ? AND t.client_id = c.client_id)
		FROM oauth_clients c
		WHERE EXISTS (SELECT 1 FROM oauth_refresh r WHERE r.user_id = ? AND r.client_id = c.client_id AND r.expires_at > ?)
		OR EXISTS (SELECT 1 FROM tokens t WHERE t.user_id = ? AND t.kind = ? AND t.client_id = c.client_id AND t.expires_at > ?)
		ORDER BY c.created_at DESC, c.client_id`, userID, KindAccess, userID, now, userID, KindAccess, now)
	if err != nil {
		return nil, err
	}
	return collect(rows, func(rows *sql.Rows) (OAuthApp, error) {
		var app OAuthApp
		var lastUsed sql.NullInt64
		err := rows.Scan(&app.ClientID, &app.Name, &app.CreatedAt, &lastUsed)
		app.LastUsedAt = lastUsed.Int64
		return app, err
	})
}

// DeleteOAuthGrant revokes everything a user granted a client: access
// tokens, refresh tokens, and unredeemed codes.
func (s *Store) DeleteOAuthGrant(ctx context.Context, userID, clientID string) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM tokens WHERE user_id = ? AND client_id = ? AND kind = ?", userID, clientID, KindAccess)
		if err == nil {
			_, err = tx.ExecContext(ctx, "DELETE FROM oauth_refresh WHERE user_id = ? AND client_id = ?", userID, clientID)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, "DELETE FROM oauth_codes WHERE user_id = ? AND client_id = ?", userID, clientID)
		}
		return err
	})
}

// --- channels ---

type Channel struct {
	UserID    string
	ChannelID string
	Title     string
	Handle    string
	Scopes    string
	// RefreshToken is the sealed Google refresh token.
	RefreshToken []byte
	Status       string
	CheckedAt    int64
	CreatedAt    int64
}

const channelColumns = "user_id, channel_id, title, handle, scopes, refresh_token, status, checked_at, created_at"

func scanChannel(rows *sql.Rows) (Channel, error) {
	var c Channel
	var checkedAt sql.NullInt64
	err := rows.Scan(&c.UserID, &c.ChannelID, &c.Title, &c.Handle, &c.Scopes, &c.RefreshToken, &c.Status, &checkedAt, &c.CreatedAt)
	c.CheckedAt = checkedAt.Int64
	return c, err
}

// repairDefaults points any default at a channel that no longer exists to
// the user's oldest remaining channel, or NULL.
const repairDefaults = `UPDATE users SET default_channel_id =
	(SELECT channel_id FROM channels WHERE channels.user_id = users.id ORDER BY created_at, channel_id LIMIT 1)
	WHERE default_channel_id IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM channels WHERE channels.user_id = users.id AND channels.channel_id = users.default_channel_id)`

// UpsertChannel connects or reconnects a channel (status ok); a user's first
// channel becomes their default.
func (s *Store) UpsertChannel(ctx context.Context, c Channel) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO channels (`+channelColumns+`) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)
			ON CONFLICT (user_id, channel_id) DO UPDATE SET title = excluded.title, handle = excluded.handle,
			scopes = excluded.scopes, refresh_token = excluded.refresh_token, status = 'ok', checked_at = excluded.checked_at`,
			c.UserID, c.ChannelID, c.Title, c.Handle, c.Scopes, c.RefreshToken, nullInt(c.CheckedAt), c.CreatedAt)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE users SET default_channel_id = ? WHERE id = ? AND default_channel_id IS NULL", c.ChannelID, c.UserID)
		return err
	})
}

// Channels lists a user's channels, oldest first.
func (s *Store) Channels(ctx context.Context, userID string) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+channelColumns+" FROM channels WHERE user_id = ? ORDER BY created_at, channel_id", userID)
	if err != nil {
		return nil, err
	}
	return collect(rows, scanChannel)
}

// ChannelsWithStatus lists every user's channels with a status.
func (s *Store) ChannelsWithStatus(ctx context.Context, status string) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+channelColumns+" FROM channels WHERE status = ? ORDER BY user_id, created_at", status)
	if err != nil {
		return nil, err
	}
	return collect(rows, scanChannel)
}

func (s *Store) SetChannelStatus(ctx context.Context, userID, channelID, status string, checkedAt int64) error {
	result, err := s.db.ExecContext(ctx, "UPDATE channels SET status = ?, checked_at = ? WHERE user_id = ? AND channel_id = ?", status, checkedAt, userID, channelID)
	return affected(result, err)
}

func (s *Store) SetRefreshToken(ctx context.Context, userID, channelID string, sealed []byte) error {
	result, err := s.db.ExecContext(ctx, "UPDATE channels SET refresh_token = ? WHERE user_id = ? AND channel_id = ?", sealed, userID, channelID)
	return affected(result, err)
}

func (s *Store) DeleteChannel(ctx context.Context, userID, channelID string) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "DELETE FROM channels WHERE user_id = ? AND channel_id = ?", userID, channelID)
		if err := affected(result, err); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, repairDefaults)
		return err
	})
}

// DeleteRevokedChannels removes channels that were revoked and last checked
// before a cutoff.
func (s *Store) DeleteRevokedChannels(ctx context.Context, checkedBefore int64) (int64, error) {
	var deleted int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "DELETE FROM channels WHERE status = ? AND checked_at < ?", StatusRevoked, checkedBefore)
		if err != nil {
			return err
		}
		if deleted, err = result.RowsAffected(); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, repairDefaults)
		return err
	})
	return deleted, err
}

// --- upkeep ---

type Purged struct {
	Sessions, AccessTokens, OAuthCodes, OAuthRefresh int64
}

// Purge deletes everything that expired at or before now.
func (s *Store) Purge(ctx context.Context, now int64) (Purged, error) {
	var p Purged
	for _, step := range []struct {
		query string
		args  []any
		count *int64
	}{
		{"DELETE FROM sessions WHERE expires_at <= ?", []any{now}, &p.Sessions},
		{"DELETE FROM tokens WHERE kind = ? AND expires_at <= ?", []any{KindAccess, now}, &p.AccessTokens},
		{"DELETE FROM oauth_codes WHERE expires_at <= ?", []any{now}, &p.OAuthCodes},
		{"DELETE FROM oauth_refresh WHERE expires_at <= ?", []any{now}, &p.OAuthRefresh},
	} {
		result, err := s.db.ExecContext(ctx, step.query, step.args...)
		if err != nil {
			return p, err
		}
		if *step.count, err = result.RowsAffected(); err != nil {
			return p, err
		}
	}
	return p, nil
}

// --- helpers ---

// execer is a *sql.DB or *sql.Tx.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (s *Store) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func collect[T any](rows *sql.Rows, scan func(*sql.Rows) (T, error)) ([]T, error) {
	defer rows.Close()
	var out []T
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func affected(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func nullInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

-- Timestamps are unix seconds. Secrets (session IDs, API keys, tokens, codes)
-- are stored only as sha256 hashes; Google refresh tokens are sealed.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL, default_channel_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash BLOB PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
-- console API keys and MCP OAuth access tokens: one table, one verifier
CREATE TABLE IF NOT EXISTS tokens (hash BLOB PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('api_key','access')), label TEXT NOT NULL, prefix TEXT NOT NULL, client_id TEXT, expires_at INTEGER, last_used_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, title TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL, refresh_token BLOB NOT NULL, status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','revoked')), checked_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, channel_id));
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (hash BLOB PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_refresh (hash BLOB PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);

# Hosted MCP server (oytcd)

`oytcd` runs oytc's read-only tools as a remote MCP server. You sign in to a small web console
with Google, connect one or more YouTube channels, and either mint an API key or let an MCP
client sign in with OAuth. Any MCP client can then use the tools at `https://<host>/mcp`.

- Public-data tools (`search`, `video_get`, …) use a server-held YouTube Data API key.
- Analytics tools use the connected channel's Google grant. `channel` picks a connected channel
  by ID or @handle; omitting it uses the default channel. `list_channels` shows what's connected.
- Console API keys and MCP OAuth access tokens are both bearer tokens checked by one verifier.
  Google tokens never leave the server.
- Sign-in is limited to `OYTCD_ALLOWED_EMAILS`.

The same tools run locally over stdio with `oytc mcp` (see [commands.md](commands.md)).

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` , `/console` | Sign in, connect channels, manage API keys |
| `/mcp` | Streamable HTTP MCP endpoint (stateless), `Authorization: Bearer <token>` |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | MCP OAuth discovery |
| `/register`, `/authorize`, `/token` | MCP OAuth (dynamic client registration, client ID metadata documents, PKCE) |
| `/privacy` | Privacy policy |
| `/healthz` | Health check |

## Configuration

| Variable | Value |
| --- | --- |
| `OYTCD_BASE_URL` | Public origin, no trailing slash: `https://oytc.davis7.sh` |
| `OYTCD_DB_PATH` | SQLite file; default `/data/oytcd.db` (the Railway volume) |
| `OYTCD_SECRET_KEY` | `openssl rand -base64 32`; seals Google refresh tokens and cookies. Losing it means reconnecting channels |
| `OYTCD_GOOGLE_CLIENT_ID` / `OYTCD_GOOGLE_CLIENT_SECRET` | Google OAuth "Web application" client |
| `OYTCD_YOUTUBE_API_KEY` | YouTube Data API v3 key for public data |
| `OYTCD_ALLOWED_EMAILS` | Comma-separated Google accounts allowed to sign in |
| `PORT` | Listen port (Railway sets it) |

`oytcd` refuses to start and lists every missing or invalid variable.

## Local development

```sh
cp .env.example .env.local   # fill in real values; keep OYTCD_BASE_URL=http://localhost:8080
make serve
```

The Google client needs `http://localhost:8080/auth/google/callback` and
`http://localhost:8080/channels/callback` as redirect URIs.

## Deploy

### Google Cloud

1. Create a project at <https://console.cloud.google.com/projectcreate> (no billing needed).
2. Enable [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
   and [YouTube Analytics API](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com).
3. <https://console.cloud.google.com/auth/overview> → **Get started**: app name `oytc`, your
   support email, audience **External**, your contact email, accept the policy, **Create**.
   Skip the logo (a logo triggers verification).
4. **Audience** → **Publish app** → **Confirm**. The status must read **In production**:
   Testing mode expires refresh tokens after 7 days. Unverified production apps show a warning
   when connecting a channel and are capped at 100 users for the project's lifetime.
5. **Clients** → **Create client** → **Web application**, name `oytcd`, no JavaScript origins,
   redirect URIs:
   - `https://oytc.davis7.sh/auth/google/callback`
   - `https://oytc.davis7.sh/channels/callback`
   - `http://localhost:8080/auth/google/callback`
   - `http://localhost:8080/channels/callback`

   Copy the client secret immediately; Google only shows it once.
6. <https://console.cloud.google.com/apis/credentials> → **Create credentials** → **API key**,
   restricted to **YouTube Data API v3**, application restriction **None**.

### Railway (Hobby plan or above)

1. **New Project** → **GitHub repo** → `davis7dotsh/open-yt-cli`. Railway builds the root
   `Dockerfile`. Service → Settings → Source picks the branch.
2. Add a volume mounted at `/data`.
3. Variables → Raw Editor: every variable from the table above with production values.
4. Settings → Healthcheck Path: `/healthz`.
5. Settings → Public Networking → **Custom Domain** `oytc.davis7.sh`, target port `8080`.
   Railway shows a CNAME and a TXT verification record.
6. Backups → schedule daily backups of the volume.

A volume means one replica and a few seconds of downtime per deploy.

### DNS (Vercel DNS for davis7.sh)

Add both records Railway shows: CNAME `oytc` → `<target>.up.railway.app` and the TXT record.
The explicit CNAME overrides the `*.davis7.sh` wildcard; allow ~20 minutes for caches.

## Connecting clients

Create a key in the console and export it as `OYTC_MCP_KEY`.

```sh
# Claude Code
claude mcp add --transport http --scope user oytc https://oytc.davis7.sh/mcp \
  --header 'Authorization: Bearer ${OYTC_MCP_KEY}'

# Codex
codex mcp add oytc --url https://oytc.davis7.sh/mcp --bearer-token-env-var OYTC_MCP_KEY
```

```json
// ~/.cursor/mcp.json
{ "mcpServers": { "oytc": { "url": "https://oytc.davis7.sh/mcp", "headers": { "Authorization": "Bearer ${env:OYTC_MCP_KEY}" } } } }
```

claude.ai, Claude Desktop/mobile, and ChatGPT: add a custom connector with URL
`https://oytc.davis7.sh/mcp` and sign in when prompted (MCP OAuth). Claude Code also uses OAuth
if you add the server without a header.

## Operations

- A daily job force-refreshes each channel's Google grant, marks revoked ones, deletes channels
  revoked for 30 days, and purges expired sessions, codes, and tokens.
- Disconnecting a channel revokes its Google grant. Revoked or expired grants show in the console
  and in tool errors with a reconnect link.
- Quota is the Google project's: 10,000 units/day plus 100 searches/day. MCP list calls stop after
  20 pages and return a `nextPageToken`.

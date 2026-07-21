# OAuth setup for YouTube Analytics

`oytc analytics` needs authorization from the owner of the channel being reported. The CLI
uses Google's OAuth 2.0 loopback flow with PKCE and requests two read-only scopes:

- `https://www.googleapis.com/auth/yt-analytics.readonly` — Analytics reports
- `https://www.googleapis.com/auth/youtube.readonly` — Data API reads, so public-data
  commands also work through OAuth when no API key is configured

`oytc` has no write commands and does not request upload, moderation, revenue, or
content-owner scopes.

**Sensitive-scope caveat:** Google classifies `youtube.readonly` as **sensitive**.
Accounts with Advanced Protection or restrictive Workspace policies hard-block (not just
warn) unverified apps requesting sensitive scopes — consent fails with "This app is
blocked". If that affects you, either complete Google's app verification for your consent
app, or authorize from an account without those restrictions.

## 1. Create or select a Google Cloud project

Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (or
select the project already used for your API key). Confirm the intended project in the
console's project picker before continuing.

## 2. Enable both APIs

In **APIs & Services → Library**, enable:

1. **YouTube Data API v3**
2. **YouTube Analytics API**

The Data API is used to validate the read-only OAuth credential; the Analytics API serves
reports.

## 3. Configure the OAuth consent screen

In **Google Auth Platform → Branding / Audience / Data Access** (older console layouts call
this **OAuth consent screen**):

1. Create an app registration and supply the required app name and contact addresses.
2. Choose **External** unless every account that will authorize belongs to one Google
   Workspace organization that you control.
3. Add these scopes under **Data Access**:
   - `.../auth/yt-analytics.readonly`
   - `.../auth/youtube.readonly` (sensitive — see the caveat above; unverified apps
     requesting it are hard-blocked for Advanced Protection and restrictive Workspace
     accounts)
4. While the app is in **Testing**, add each authorizing Google account as a test user.
5. When ready, publish the app to **Production**.

Publishing to Production is important for unattended use: refresh tokens for an External
app left in Testing generally expire after seven days. Production does not make `oytc`
publicly writable or broaden its scopes; it changes the consent app's publishing status.

### Unverified-app warning and user cap

Because `youtube.readonly` is a sensitive scope, an unverified app will show a
**“Google hasn't verified this app”** interstitial on most accounts. For an app you
created and trust, use the warning's advanced path to continue, and inspect the requested
scopes before approving. Accounts with Advanced Protection or restrictive Workspace
policies cannot bypass this warning — they are hard-blocked until the app is verified.

An unverified External app is generally limited to 100 users over the lifetime of the
Google Cloud project (the cap is project-wide, not per client ID, and cannot be reset).
That is normally sufficient for a personal Desktop client. Complete Google's verification
process before distributing beyond that cap; do not ask users to share one person's
client secret or tokens.

## 4. Create a Desktop OAuth client

In **Google Auth Platform → Clients** (or **APIs & Services → Credentials**):

1. Select **Create client** / **Create credentials → OAuth client ID**.
2. Choose application type **Desktop app**.
3. Give it a recognizable name such as `oytc desktop`.
4. Copy the generated **Client ID** and **Client secret**.

Do not create a Web application client. Desktop clients permit the random
`http://127.0.0.1:<port>` loopback redirect that `oytc` starts for each login.

## 5. Authorize `oytc`

Choose one bootstrap method.

### Environment variables

```sh
export OYTC_OAUTH_CLIENT_ID='1234567890-example.apps.googleusercontent.com'
export OYTC_OAUTH_CLIENT_SECRET='your-desktop-client-secret'
oytc login --oauth
```

If you keep these values in a local `.env`, load/export them with your shell or secret
manager before invoking `oytc`; the CLI does not parse `.env` files itself. Keep that file
out of version control. Each environment variable independently takes precedence over a
stored client credential during login.

### Prompted bootstrap

```sh
oytc login --oauth
```

Paste the client ID at the normal prompt and the client secret at the no-echo prompt.

`oytc` prints the authorization URL, attempts to open it in the default browser, and waits
up to about three minutes on a random local loopback port. Sign in as the channel owner,
review the read-only analytics scope, and approve. The browser then redirects only to the
local listener. On success, `oytc` exchanges the one-time code using PKCE and stores the client
credentials and tokens in the protected `auth.json` file.

No browser was opened? Copy the printed URL into a browser on the same machine where
`oytc` is running, because the final redirect targets that machine's `127.0.0.1` listener.

## 6. Verify and run a report

```sh
oytc status --check
oytc analytics overview --by day
oytc analytics traffic-sources --start 2026-01-01 --end 2026-01-31 --format json
```

`status` displays the OAuth client ID, granted scopes, and access-token expiry, but never
the access token, refresh token, or client secret. Access tokens refresh automatically and
rotated values are atomically persisted.

To disconnect, run `oytc logout`. It attempts to revoke the OAuth token and then removes all
stored credentials. An `OYTC_API_KEY` environment variable remains active until removed
from the environment.

## Troubleshooting

- **`access_denied`**: consent was declined or the account is not an allowed test user.
- **`invalid_grant`**: the refresh token expired or was revoked; run `oytc login --oauth`
  again. Publishing a Testing app to Production prevents the usual seven-day test-token
  expiry for newly issued tokens.
- **`insufficientPermissions`**: re-run `oytc login --oauth` and approve the requested
  scope.
- **API not enabled**: enable both APIs in the same project as the Desktop client.
- **Metric/dimension error**: Google restricts compatible Analytics combinations; adjust
  the report's `--metrics`, `--dimensions`, and filters. The CLI preserves Google's error
  message.

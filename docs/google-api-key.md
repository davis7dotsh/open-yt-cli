# Creating a YouTube Data API v3 key for oytc

This is a deterministic, click-by-click guide to creating and restricting a Google Cloud
API key for `oytc`. It is written so that a person — or a computer-use agent — can follow
it without guessing. All URLs are direct deep links into the Google Cloud console.

The key is free. The YouTube Data API v3 has a default free quota (10,000 units/day for
most endpoints plus a separate bucket of 100 `search.list` calls/day) and `oytc` performs
read-only requests, so no billing account is required.

> **Never paste your key into files, shell commands, or chat.** The only supported ways to
> give it to `oytc` are the no-echo `oytc login` prompt, piping into `oytc login`, or the
> `OYTC_API_KEY` environment variable.

## Prerequisites

- A Google Account. Create one at <https://accounts.google.com/signup> if needed.
- A browser signed in to that account. If you are signed in to multiple accounts, confirm
  the account avatar in the top-right corner of the console before proceeding.

## Step 1 — Create or select a Google Cloud project

1. Open the project creation page directly: <https://console.cloud.google.com/projectcreate>
   - First-time console users may see a terms-of-service dialog. Check the agreement box
     and click **Agree and continue**.
2. In the **Project name** field, type a name, e.g. `oytc`. (The auto-generated project ID
   below it is fine; you never need to type it again for this guide.)
3. Leave **Location / Organization** as `No organization` unless you know otherwise.
4. Click the **Create** button.
5. Wait for the notification bell (top right) to show "Create project: oytc" finished,
   then click **SELECT PROJECT** in that notification — or pick the project from the
   project selector dropdown at the top-left of the page (next to the "Google Cloud" logo).

To reuse an existing project instead: open <https://console.cloud.google.com/projectselector2/home/dashboard>
and click the project's name in the list.

## Step 2 — Enable the YouTube Data API v3

1. Open the API's library page directly:
   <https://console.cloud.google.com/apis/library/youtube.googleapis.com>
   - Confirm the project selector in the top bar shows your project. If not, click it and
     choose the project, then re-open the URL.
   - Alternative navigation: <https://console.cloud.google.com/apis/library> → type
     `YouTube Data API v3` in the search field → click the **YouTube Data API v3** card.
2. Click the blue **Enable** button.
   - If you instead see **Manage** and **API Enabled**, the API is already on; continue.
3. Wait for the redirect to the API's overview page (URL contains
   `/apis/api/youtube.googleapis.com`).

## Step 3 — Create the API key

1. Open the credentials page directly: <https://console.cloud.google.com/apis/credentials>
2. Click **+ Create credentials** near the top of the page.
3. Select **API key** from the dropdown menu.
4. A "API key created" dialog appears showing the key string (starts with `AIza…`).
   - Click the copy icon next to the key and store it *temporarily* in a password manager
     or keep the dialog open. Do not paste it into a plain-text file.
   - Recent console versions may show a **key creation flow with a restriction step**
     instead of a plain dialog; if a restriction form appears now, jump to Step 4's
     settings, apply them in that form, then save and copy the key.
5. Click **Close** (or **Edit API key** to jump straight to Step 4).

## Step 4 — Restrict the key to the YouTube Data API v3

Restricting the key means a leaked key can only spend *your YouTube quota*, not call other
(potentially billable) Google APIs on your project.

1. On <https://console.cloud.google.com/apis/credentials>, in the **API Keys** table,
   click the name of the key you just created (default name: `API key 1`).
2. Optional: change **Name** to `oytc` so future-you knows what it is for.
3. Scroll to the **API restrictions** section.
4. Select the **Restrict key** radio button.
5. Click the **Select APIs** dropdown, type `YouTube` in its filter box, and check
   **YouTube Data API v3**. Click **OK** to close the dropdown.
   - If YouTube Data API v3 is not listed, you skipped Step 2 — enable the API first,
     then reload this page.
6. Leave everything else and click **Save** at the bottom.

### Application restrictions for a roaming CLI (trade-offs)

The **Application restrictions** section (`None` / `Websites` / `IP addresses` / `Android
apps` / `iOS apps`) controls *where* the key may be used from:

- **None** (recommended for a laptop CLI): the key works from any network. This is the
  practical choice for a CLI that roams between home, office, and mobile networks. The API
  restriction above is your main protection; also keep the key out of files and history.
- **IP addresses**: strongest option *if* you only run `oytc` from hosts with stable
  public IPs (e.g. one server or a fixed egress IP). Enter each IP/CIDR. On a laptop with
  DHCP/VPN/mobile networks this will lock you out whenever your IP changes — expect
  `403 forbidden` errors from `oytc` until you update the list.
- **Websites / Android / iOS**: designed for browser and mobile apps; they key off HTTP
  referrers or app signatures that a CLI does not send. Do not use these for `oytc` —
  they will simply block every request.

If you cannot decide: choose **None**, keep the API restriction from Step 4, and rotate
the key (Step 7) if you ever suspect exposure.

## Step 5 — Save the key into oytc

Run:

```sh
oytc login
```

Paste the key at the `YouTube Data API key:` prompt (input is not echoed) and press Enter.
`oytc` validates the key with a cheap `i18nLanguages.list` request and writes it atomically
to the platform config path with `0600` permissions. For non-interactive setups, pipe it:

```sh
some-secret-manager get youtube-api-key | oytc login
```

> A freshly created or freshly restricted key can take a few minutes to propagate. If
> validation fails immediately after creation with `keyInvalid` or `accessNotConfigured`,
> wait 2–5 minutes and retry.

Now delete the key from wherever you temporarily stashed it (clipboard managers included).

## Step 6 — Verify

```sh
oytc status --check
```

Expected output ends with `Remote check: valid` (or `"valid": true` in JSON mode). Then
try a real query:

```sh
oytc video get dQw4w9WgXcQ
```

## Step 7 — Rotation and revocation

- Rotate: on <https://console.cloud.google.com/apis/credentials>, click the key name, then
  the **Regenerate key** button; re-run `oytc login` with the new value. The old value
  keeps working for a short overlap window, then dies.
- Revoke: on the same credentials page, click the trash icon in the key's row and confirm.
- Remove from this machine: `oytc logout`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `API key validation failed … accessNotConfigured` | YouTube Data API v3 is not enabled on the key's project. Redo Step 2, wait a few minutes, retry. |
| `API key validation failed … keyInvalid` | Typo/truncation in the pasted key, or the key was just created and hasn't propagated. Re-copy carefully; wait and retry. |
| `403 … requests from this client are blocked` or IP errors | Application restriction mismatch — you set IP/website restrictions that don't match your machine. Set application restrictions to **None** (Step 4 trade-offs) or update the allowed IPs. |
| `quotaExceeded` (exit code 5) | Daily quota exhausted. Search has its own 100 calls/day bucket. Wait for the midnight-Pacific reset or request more quota via the [YouTube API quota extension form](https://support.google.com/youtube/contact/yt_api_form). |
| `status` shows `Source: OYTC_API_KEY` when you expected the file | The environment variable outranks `auth.json`. `unset OYTC_API_KEY` to fall back to the saved key. |
| Key works in the browser test but not in `oytc` | Check `oytc status` for which key is actually active; check for API restrictions excluding YouTube Data API v3. |
| Console pages look different from this guide | Google periodically redesigns the console. The stable anchors are the direct URLs above and the labels "Create credentials", "API key", "Restrict key". Google's current canonical docs: [API key docs](https://cloud.google.com/docs/authentication/api-keys) and [YouTube Data API getting started](https://developers.google.com/youtube/v3/getting-started). |

## Reference quota costs

| Operation | Cost |
| --- | ---: |
| Most list reads (`videos`, `channels`, `playlists`, `comments`, …) | 1 unit |
| `search.list` | 1 call from the dedicated 100 calls/day search bucket |
| `videoTrainability.get` (`oytc video trainability`) | free, no key needed |

Default allocation: 10,000 units/day combined for non-search endpoints, plus the search
bucket. See [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost).

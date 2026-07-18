# oytc command reference

`oytc` is a read-only CLI for public YouTube Data API v3 resources and the authorized
user's YouTube Analytics. Public-data commands accept an API key (or the read-only OAuth
credential); analytics commands require OAuth. This page documents every command, shared
flags, output formats, pagination, configuration, and error behavior.

Help output is always authoritative: run `oytc --help`, `oytc <command> --help`, or
`oytc <command> <subcommand> --help` for the flags supported by your installed version.

- [Command tree](#command-tree)
- [Authentication commands](#authentication-commands)
- [Analytics](#analytics)
- [Search](#search)
- [Channels](#channels)
- [Videos](#videos)
- [Playlists](#playlists)
- [Comments](#comments)
- [Subscriptions](#subscriptions)
- [Live chat](#live-chat)
- [Metadata lists](#metadata-lists)
- [Agent skill installation](#agent-skill-installation)
- [Version and self-update](#version-and-self-update)
- [Output](#output)
- [Pagination and quota](#pagination-and-quota)
- [Configuration and precedence](#configuration-and-precedence)
- [Errors and exit codes](#errors-and-exit-codes)
- [Read-only limitations](#read-only-limitations)

## Command tree

```text
oytc login [--oauth]
oytc status [--check]
oytc logout

oytc analytics report --metrics <CSV>
oytc analytics overview [--by day|month]
oytc analytics video <VIDEO_ID>
oytc analytics traffic-sources
oytc analytics demographics

oytc search [QUERY]

oytc channel get <REFERENCE>...
oytc channel activities <CHANNEL>
oytc channel sections <CHANNEL>
oytc channel sections --id <SECTION_IDS>
oytc channel uploads <CHANNEL>

oytc video get <VIDEO_ID>...
oytc video stats <VIDEO_ID>...
oytc video popular
oytc video trainability <VIDEO_ID>

oytc playlist get <PLAYLIST_ID>...
oytc playlist list --channel <CHANNEL_ID>
oytc playlist items <PLAYLIST_ID>

oytc comment get <COMMENT_ID>...
oytc comment replies <PARENT_COMMENT_ID>
oytc comment threads --video <VIDEO_ID>
oytc comment threads --channel <CHANNEL_ID>
oytc comment threads --id <THREAD_IDS>

oytc subscription list --channel <CHANNEL_ID>
oytc subscription list --id <SUBSCRIPTION_IDS>

oytc live-chat list (--video <VIDEO_ID> | --chat-id <LIVE_CHAT_ID>)
oytc live-chat stream (--video <VIDEO_ID> | --chat-id <LIVE_CHAT_ID>)

oytc category list (--region <REGION> | --id <CATEGORY_IDS>)
oytc language list
oytc region list

oytc skills install                              # `oytc skill install` also works
oytc version
oytc update [--check] [--version vX.Y.Z]     # `oytc upgrade` is an alias
```

## Authentication commands

### `oytc login [--oauth]`

Without flags, prompts for a YouTube Data API key without terminal echo, validates it with
a cheap `i18nLanguages.list` call, and atomically writes it as JSON to the config path. A
key can also be piped on standard input for non-interactive secret injection; there is
deliberately no `--api-key` flag, so the key never appears in shell history or the process
table.

```sh
oytc login                       # interactive
some-secret-manager get yt | oytc login   # piped
```

If `OYTC_API_KEY` is set, `login` still saves the file but notes that the environment
variable remains the active, higher-precedence credential.

`oytc login --oauth` runs a PKCE-protected loopback-browser flow and requests only
`yt-analytics.readonly` (non-sensitive, so protected accounts can still consent). It prints the authorization URL as a
headless fallback, stores access/refresh tokens in the same protected file, and preserves
an existing API key. Client credentials come from `OYTC_OAUTH_CLIENT_ID` and
`OYTC_OAUTH_CLIENT_SECRET` when set; missing values are prompted (the secret without echo).
See [OAuth setup](oauth.md).

### `oytc status [--check]`

Local-only by default. It reports the API key's source and SHA-256 fingerprint and the
OAuth client ID, granted scopes, and token expiry — never the key, tokens, or client secret.
`--check` validates each configured credential and may refresh/persist an expiring OAuth
token.

### `oytc logout`

Attempts to revoke the stored OAuth refresh token, continues if revocation fails, then
idempotently removes the complete credential file. It warns when `OYTC_API_KEY` remains set.

## Analytics

All analytics commands query `ids=channel==MINE` and require `oytc login --oauth`. Dates
are inclusive `YYYY-MM-DD`; both default to the last 28 complete UTC days (ending
yesterday). Every command accepts:

| Flag | Meaning |
| --- | --- |
| `--start YYYY-MM-DD` / `--end YYYY-MM-DD` | inclusive report range |
| `--filters EXPR` | YouTube Analytics filter expression |
| `--sort CSV` | sort fields, prefix descending fields with `-` |
| `--limit N` | maximum rows, 1–200 (default 200; one Analytics API page) |

Google's metric/dimension compatibility rules are authoritative. Incompatible combinations
are returned verbatim as API errors.

### `oytc analytics report`

Raw report command. `--metrics CSV` is required; `--dimensions CSV` is optional.

```sh
oytc analytics report --metrics views,estimatedMinutesWatched \
  --dimensions day --start 2026-01-01 --end 2026-01-31 --sort day --format json
```

### Preset reports

```sh
oytc analytics overview --by day --format table
oytc analytics video VIDEO_ID --start 2026-01-01 --end 2026-01-31
oytc analytics traffic-sources --sort=-views --format tsv
oytc analytics demographics --format jsonl
```

- `overview` requests views, estimated watch minutes, average view duration, average view
  percentage, and subscribers gained. `--by day|month` is optional. (Thumbnail impressions
  and impression click-through rate are only available in YouTube Studio; the Analytics API
  exposes no such metrics.)
- `video <VIDEO_ID>` applies `video==VIDEO_ID` and requests core engagement/watch metrics.
- `traffic-sources` groups views and estimated watch minutes by
  `insightTrafficSourceType`.
- `demographics` groups `viewerPercentage` by `ageGroup,gender`.

Analytics' column-oriented response is normalized into ordinary objects, so all shared
formats and `--columns` work unchanged. Example JSON envelope:

```json
{
  "items": [{"day": "2026-01-01", "views": 42}],
  "requests": 1
}
```

## Search

```sh
oytc search 'Go conference' --type video --region US --page-size 10
oytc search 'live coding' --type video --event-type live --format jsonl
```

`search` costs one call from the Data API's dedicated search bucket (100 `search.list`
calls per day by default), so it never follows extra pages unless `--all` is explicit.

Filters (see `oytc search --help` for the complete list):

| Flag | Values / meaning |
| --- | --- |
| `--type` | comma-separated `video`, `channel`, `playlist` (default: all three) |
| `--channel` | only resources created by this channel ID |
| `--order` | `date`, `rating`, `relevance` (default), `title`, `videoCount`, `viewCount` |
| `--published-after` / `--published-before` | RFC 3339 bounds |
| `--region` / `--language` | region code / relevance language |
| `--safe-search` | `moderate` (default), `none`, `strict` |
| `--event-type` | `completed`, `live`, `upcoming` (requires `--type video`) |
| `--location` + `--location-radius` | geographic video search (both required together) |
| `--topic` | Freebase topic ID |
| `--video-caption`, `--video-category`, `--video-duration`, `--video-embeddable`, `--video-license`, `--video-paid-product-placement`, `--video-syndicated` | video-only filters (require `--type video`) |
| `--channel-type` | `any`, `show` (requires `--type channel`) |

Incompatible combinations are rejected locally before any request is made.

## Channels

Channel references accept canonical `UC…` IDs, `@handles`, and common
`youtube.com/channel/…`, `youtube.com/@…`, `youtube.com/user/…`, and `youtube.com/c/…`
URL forms. Legacy custom `/c/` names cannot be resolved exactly through the API, so they
use a best-match channel search (may resolve to the wrong channel for ambiguous names).

```sh
oytc channel get @GoogleDevelopers --parts snippet,statistics
oytc channel activities UC_x5XG1OV2P6uZZ5FSM9Ttw --published-after 2026-01-01T00:00:00Z
oytc channel sections @GoogleDevelopers
oytc channel uploads https://youtube.com/@GoogleDevelopers --all --limit 100
```

- `get` accepts multiple references and batches IDs (50 per request).
- `activities` lists public channel activity with publication bounds.
- `sections` lists a channel's sections, or fetches specific section IDs with `--id`.
- `uploads` resolves the channel's `contentDetails.relatedPlaylists.uploads` playlist and
  then lists its items — the reliable way to enumerate all public uploads.
- Owner-only parts (`auditDetails`, `contentOwnerDetails`) are rejected locally.

## Videos

```sh
oytc video get dQw4w9WgXcQ --parts snippet,contentDetails,statistics
oytc video stats dQw4w9WgXcQ jNQXAC9IVRw --format tsv --columns id,statistics.viewCount
oytc video popular --region CA --category 28
oytc video trainability dQw4w9WgXcQ --format json
```

- `get` / `stats` batch up to 50 IDs per request. `stats` defaults to the `statistics` part.
- `popular` lists the `mostPopular` chart for a region (default `US`), optionally by category.
- `trainability` calls the public `videoTrainability.get` endpoint **without any key** and
  consumes no Data API quota.
- Owner-only parts (`fileDetails`, `processingDetails`, `suggestions`) are rejected locally.

## Playlists

```sh
oytc playlist get PLxxxx
oytc playlist list --channel UC_x5XG1OV2P6uZZ5FSM9Ttw
oytc playlist items PLxxxx --all --limit 250
```

- `get` batches playlist IDs (50 per request).
- `list` lists a channel's public playlists (`--channel` is required).
- `items` lists a playlist's items; `--video` filters to entries for one video ID.

## Comments

```sh
oytc comment threads --video dQw4w9WgXcQ --order relevance --search music
oytc comment threads --channel UC_x5XG1OV2P6uZZ5FSM9Ttw
oytc comment replies Ugz...parent-id
oytc comment get Ugz...comment-id
```

- `threads` requires exactly one of `--video`, `--channel` (all threads related to the
  channel), or `--id`. `--order time|relevance` and `--search` are incompatible with `--id`.
- `replies` lists replies to one top-level comment.
- `get` batches comment IDs (100 per request).
- `--text-format plainText|html` controls comment text rendering (default `plainText`).

## Subscriptions

```sh
oytc subscription list --channel UC_x5XG1OV2P6uZZ5FSM9Ttw
oytc subscription list --channel UC... --for-channel UCtarget --order alphabetical
```

Lists a channel's **public** subscriptions (many channels hide these; a hidden list returns
an API error). Requires exactly one of `--channel` or `--id`. The owner-only
`subscriberSnippet` part is rejected locally.

## Live chat

Given `--video`, `oytc` resolves the video's `liveStreamingDetails.activeLiveChatId`
(one extra request); `--chat-id` skips that lookup.

```sh
oytc live-chat list --video LIVE_VIDEO_ID
oytc live-chat stream --video LIVE_VIDEO_ID --format jsonl
oytc live-chat stream --chat-id CHAT_ID --limit 500
```

- `list` fetches exactly one finite page. `--all` is rejected there because a live-chat
  next token represents *future polling*, not a static collection.
- `stream` continuously polls `liveChatMessages.list`. It is explicitly a **REST polling
  fallback**, not Google's lower-latency gRPC `streamList` method. It:
  - carries the returned page token forward;
  - waits at least `pollingIntervalMillis` between calls;
  - emits JSONL by default (TSV/table also available; `--format json` is rejected for an
    unbounded stream);
  - deduplicates message IDs within the process;
  - supports `--page-token` for external resumption and `--limit` for bounded runs;
  - stops when the chat goes offline and exits cleanly on interruption.
- `--page-size` (200–2000, default 500) and `--profile-image-size` (16–720) are validated
  locally.

## Metadata lists

```sh
oytc category list --region GB
oytc category list --id 1,10,28
oytc language list
oytc region list
```

## Agent skill installation

```sh
oytc skills install
```

`skills install` (also available as `skill install`) shows the exact destination and the
write permission it needs, then waits for an explicit `y`/`yes` confirmation. On approval,
it atomically installs the skill bundled with that CLI release to
`~/.agents/skills/oytc`, replacing an older installation. Declining makes no filesystem
changes. The installed bundle contains `SKILL.md` and its `references/` files.

## Version and self-update

```sh
oytc version                     # version, commit, build date, Go/platform
oytc update                      # self-update to the latest GitHub release
oytc update --check              # report only; change nothing
oytc update --version v0.2.0     # install an exact tag (permits pinning/downgrade)
oytc upgrade                     # alias of update
```

`oytc_update` and `oytc_upgrade` executables (symlinks created by the installer) run the
same operation via argv[0] dispatch — `oytc_update --check` is `oytc update --check`.

The updater downloads the platform archive and `checksums.txt` from GitHub Releases,
verifies the archive's SHA-256, extracts the binary with path-traversal protection, and
atomically replaces the current executable. Guarantees and edge cases:

- It **never** reads, needs, or transmits the YouTube API key.
- A checksum mismatch or a missing `checksums.txt` aborts before anything is replaced.
- Without an explicit `--version`, it refuses to downgrade.
- Prereleases are never installed implicitly; `releases/latest` excludes them. Pass
  `--version` to install a specific prerelease tag.
- Homebrew-managed installs are detected and refused — use `brew upgrade` instead.
- If the install directory is not writable it fails with instructions rather than
  escalating; re-run with appropriate permissions or reinstall via the install script.
- On Windows the running `oytc.exe` is renamed to `oytc.exe.old` and the new binary takes
  its place; if that is not possible, it prints manual replacement instructions.

## Output

Global flags available on all commands:

| Flag | Meaning |
| --- | --- |
| `--format table\|json\|jsonl\|tsv` | output format (default: `table` on a TTY, `json` otherwise) |
| `--columns a.b,c.d` | dotted property paths for table/TSV columns |
| `--no-header` | omit the table/TSV header row |
| `--no-color` | accepted for scripting (current output emits no color) |
| `--quiet`, `-q` | suppress human request summaries on stderr |
| `--timeout` | per-request timeout (default 20s) |

Resource commands also accept `--parts` (API resource parts) and `--fields` (Google's
partial-response selector); localized endpoints add `--hl`.

Finite JSON output uses a stable envelope:

```json
{
  "items": [],
  "nextPageToken": "…",
  "requests": 1
}
```

- JSONL emits exactly one resource per line (no envelope).
- TSV/table cells replace embedded tabs and newlines so records stay one line.
- YouTube counters (view counts etc.) are JSON strings in the API and are preserved as
  strings, avoiding integer precision loss.
- Human table output prints an item/request summary on stderr unless `--quiet` is used.
- When using `--fields` with pagination, keep `items` and `nextPageToken` in the selector;
  for live streaming also retain `pollingIntervalMillis` and message `id` if continuation
  and deduplication are desired.

## Pagination and quota

List commands support:

```text
--page-size N       API results per request
--page-token TOKEN  start/resume at a token
--all               follow nextPageToken until exhausted
--limit N           cap emitted resources (0 = no cap)
```

The default is one page. `--limit` can stop an `--all` traversal early; the final page can
leave a valid `nextPageToken` in the JSON envelope for resumption. Batch-get commands split
IDs according to endpoint limits (50 for channels/videos/playlists, 100 for comments).

Quota: most list requests cost 1 unit against the default 10,000-unit daily quota, while
`search.list` draws from its own default bucket of 100 calls/day. See
[quota costs](https://developers.google.com/youtube/v3/determine_quota_cost).

## Configuration and precedence

| Platform | Default credential file |
| --- | --- |
| macOS | `~/Library/Application Support/oytc/auth.json` |
| Linux/Unix | `${XDG_CONFIG_HOME:-~/.config}/oytc/auth.json` |
| Windows | `%APPDATA%\oytc\auth.json` |

API-key precedence (highest first):

1. `OYTC_API_KEY` environment variable
2. `auth.json` in `OYTC_CONFIG_DIR` (if set)
3. `auth.json` in the platform default directory

`OYTC_OAUTH_CLIENT_ID` and `OYTC_OAUTH_CLIENT_SECRET` independently override stored client
credentials only when bootstrapping `login --oauth`; authorized tokens are always read from
`auth.json`. API-key and OAuth sections coexist and updates to one preserve the other.

On POSIX systems the config directory is created `0700` and the file `0600` where the
filesystem permits. Keys use `X-Goog-Api-Key`; OAuth uses `Authorization: Bearer`. Neither
secret is placed in request URLs.

## Errors and exit codes

Exit statuses are grouped for automation:

| Code | Meaning |
| ---: | --- |
| 0 | success |
| 2 | usage/validation error |
| 3 | missing/invalid API key or OAuth authorization; re-run the indicated login |
| 4 | resource unavailable / not found / forbidden |
| 5 | quota or rate limit |
| 6 | network, temporary upstream, config, or other operational failure |
| 130 | interrupted before a command could shut down cleanly |

Transient transport errors and HTTP 429/5xx responses are retried with bounded exponential
backoff and `Retry-After` support. Google JSON errors are parsed into status, message, and
reason without exposing the key.

## Read-only limitations

- OAuth is limited to read-only YouTube and Analytics scopes for the authorized channel.
  Revenue/content-owner reports, uploads, moderation, and all mutations remain absent.
- `/c/` custom channel URLs require a search and can resolve to the API's best match.
- Live chat uses REST polling rather than the lower-latency official gRPC stream.
- `--fields` is passed through verbatim, so excluding continuation metadata can
  intentionally prevent pagination.
- Table defaults are intentionally compact; use JSON or custom `--columns` for full
  resources.

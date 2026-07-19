# oytc — open YouTube CLI

Read **public YouTube data and your own channel analytics** from the command line. `oytc`
is a fast, scriptable, read-only client for the YouTube Data API v3 and YouTube Analytics
API. API keys cover public data; OAuth 2.0 adds owner-authorized analytics. There are no
write commands.

**Website & install:** <https://davis7dotsh.github.io/open-yt-cli/>

## Install

macOS / Linux (verifies SHA-256 before installing; no root needed):

```sh
curl -fsSL https://davis7dotsh.github.io/open-yt-cli/install.sh | sh
```

Windows (PowerShell): `irm https://davis7dotsh.github.io/open-yt-cli/install.ps1 | iex`,
or download a zip from [releases](https://github.com/davis7dotsh/open-yt-cli/releases).

From source (Go 1.26+): `go install ./cmd/oytc` from a clone, or `make build`.

## Quick start

```sh
oytc login                                    # save an API key for public data
oytc status --check                           # verify configured credentials
oytc search "Go conference" --type video --limit 5
oytc channel get @GoogleDevelopers
oytc video stats dQw4w9WgXcQ --format json
oytc playlist items PLxxxx --all --limit 250

# Optional: authorize read-only access to your own channel analytics
oytc login --oauth
oytc analytics overview --by day --format json
oytc analytics video YOUR_OWN_VIDEO_ID --start 2026-01-01 --end 2026-01-31   # must be your channel's video
```

Output defaults to a compact table on a terminal and stable JSON when piped; `--format
table|json|jsonl|tsv` and `--columns` cover the rest.

## Commands

| Command | Purpose |
| --- | --- |
| `search` | Search public videos, channels, and playlists |
| `channel` | Channels, activities, sections, and full uploads enumeration |
| `video` | Videos, statistics, popular charts, AI trainability |
| `playlist` | Playlists and playlist items |
| `comment` | Comments, replies, and comment threads |
| `subscription` | Public channel subscriptions |
| `live-chat` | Live chat, one page or continuous (REST polling fallback) |
| `category` / `language` / `region` | YouTube metadata lists |
| `analytics` | OAuth-only reports, overview, video, traffic-source, and demographic analytics |
| `login` / `status` / `logout` | Manage API-key and read-only OAuth credentials |
| `skills install` | Confirm and install the bundled agent skill to `~/.agents/skills/oytc` |
| `version` | Show version, commit, and build date |
| `update` (alias `upgrade`) | Checksum-verified self-update from GitHub Releases |

`oytc <command> --help` documents every flag; validation errors explain incompatible
combinations before any request is sent. Full reference: [docs/commands.md](docs/commands.md).

## API key setup

1. Create a Google Cloud project and enable **YouTube Data API v3**
   (free; default quota is plenty for CLI use).
2. Create an API key and restrict it to the YouTube Data API v3.
3. `oytc login` (or pipe the key in; there is deliberately no `--api-key` flag).
4. `oytc status --check`.

Step-by-step guide with direct console URLs and restriction trade-offs:
[docs/google-api-key.md](docs/google-api-key.md). For ephemeral use, `OYTC_API_KEY` takes
precedence over the saved key.

For analytics, follow [docs/oauth.md](docs/oauth.md), then run `oytc login --oauth`.
`OYTC_OAUTH_CLIENT_ID` and `OYTC_OAUTH_CLIENT_SECRET` can bootstrap login non-interactively;
otherwise `oytc` prompts for both (the secret without echo). OAuth requests only
`yt-analytics.readonly`, which Google classifies as non-sensitive — consent therefore works
even on accounts that hard-block unverified apps requesting sensitive scopes.

## Security & config

- API-key and OAuth credentials coexist in `auth.json` at
  `~/Library/Application Support/oytc` (macOS), `~/.config/oytc` (Linux), or
  `%APPDATA%\oytc` (Windows) — directory `0700`, file `0600` where supported.
  `OYTC_CONFIG_DIR` overrides the location.
- Keys use the `X-Goog-Api-Key` header; OAuth access tokens use `Authorization: Bearer`.
  Neither is put in request URLs.
- `status` shows a key fingerprint plus OAuth client ID, scopes, and expiry. It never prints
  tokens or the client secret. `logout` attempts OAuth revocation, then removes the file.
- `oytc update` verifies release checksums and never reads or transmits credentials.

## Scope: read-only public data + your analytics

An API key remains sufficient for every public-data command. Optional OAuth 2.0 support is
also strictly read-only and is used for **your authorized channel's YouTube Analytics**:
views, watch time, retention, traffic sources, and audience demographics supported by
Google's metric/dimension compatibility rules. (Thumbnail impressions and CTR are not in
the Analytics API — those remain YouTube Studio-only.)

There are still zero writes: uploads, edits, moderation, and mutations are out of scope.
Revenue scopes/metrics, content-owner reports, and arbitrary private-account operations are
not requested or supported. Live chat streaming uses documented REST polling, not the
official gRPC stream.

## Documentation

- [Command reference](docs/commands.md) — every command, flag, output format, exit code
- [Google API key setup](docs/google-api-key.md) — deterministic click-by-click guide
- [OAuth analytics setup](docs/oauth.md) — GCP consent screen and Desktop client setup
- [Releasing](docs/releasing.md) — release procedure and required repo settings
- [Agent skill](skills/oytc/SKILL.md) — using `oytc` from AI agents; install it with `oytc skills install`

## Development

```sh
make build                  # build bin/oytc
make test                   # go test ./...
make check                  # vet + tests
make fmt                    # gofmt -w .
make dev login              # run from source; positional goals are forwarded
make dev ARGS="status --check"
./scripts/package.sh v0.1.0 # cross-compile release archives + checksums locally
```

CI, releases, and the website deploy run on [Depot CI](https://depot.dev/docs/ci/overview)
(GitHub Actions-compatible workflows in `.depot/workflows/`, executed entirely on Depot
compute — not GitHub Actions and not Depot's GitHub Actions runners); see
[docs/releasing.md](docs/releasing.md).

# oytc — open YouTube CLI

Read **public YouTube data** from the command line. `oytc` is a fast, scriptable client for
the official YouTube Data API v3 that authenticates with an API key only — no OAuth, no
private-account access, no writes.

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
oytc login                                    # save an API key (prompts, no echo)
oytc status --check                           # verify it against the API
oytc search "Go conference" --type video --limit 5
oytc channel get @GoogleDevelopers
oytc video stats dQw4w9WgXcQ --format json
oytc playlist items PLxxxx --all --limit 250
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
| `login` / `status` / `logout` | Manage the locally stored API key |
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

## Security & config

- The key is stored at `~/Library/Application Support/oytc/auth.json` (macOS),
  `~/.config/oytc/auth.json` (Linux), or `%APPDATA%\oytc\auth.json` (Windows) — directory
  `0700`, file `0600` where the filesystem permits. `OYTC_CONFIG_DIR` overrides the location.
- Keys are sent in the `X-Goog-Api-Key` header, never in URLs.
- `status` prints a SHA-256 fingerprint, never the key. `logout` removes the file.
- `oytc update` verifies release checksums and never reads or transmits the API key.

## Scope: public data only

`oytc` intentionally supports **only** what an API key can reach: public, read-only data.
Private channel analytics (watch time, revenue, demographics), private playlists or
subscriptions, moderation, and every write operation require OAuth and are out of scope.
Live chat streaming uses documented REST polling, not the official gRPC stream.

## Documentation

- [Command reference](docs/commands.md) — every command, flag, output format, exit code
- [Google API key setup](docs/google-api-key.md) — deterministic click-by-click guide
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

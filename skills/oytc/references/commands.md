# oytc command matrix (agent reference)

Canonical, exhaustive documentation lives at
<https://github.com/davis7dotsh/open-yt-cli/blob/main/docs/commands.md>. `oytc <cmd> --help`
is authoritative for the installed version. This file is a condensed matrix.

## Global flags (all commands)

| Flag | Notes |
| --- | --- |
| `--format table\|json\|jsonl\|tsv` | JSON when piped by default; be explicit anyway |
| `--columns a.b,c.d` | dotted paths for table/TSV |
| `--no-header` / `--quiet` | script-friendly output |
| `--timeout 20s` | per-request timeout |

Resource commands: `--parts` (API parts), `--fields` (Google partial-response selector),
sometimes `--hl` (localization).

List commands: `--page-size N`, `--page-token T`, `--all`, `--limit N`.

## Commands

| Command | Required input | Key flags |
| --- | --- | --- |
| `search [QUERY]` | — | `--type video,channel,playlist`, `--channel`, `--order`, `--published-after/-before` (RFC3339), `--region`, `--language`, `--safe-search`, `--event-type` (video), `--video-duration/-caption/-category/…`, `--location`+`--location-radius`, `--topic` |
| `channel get <REF>...` | UC… ID, @handle, or channel URL | `--parts` (no `auditDetails`/`contentOwnerDetails`) |
| `channel activities <CHANNEL>` | channel ref | `--published-after/-before` |
| `channel sections <CHANNEL>` or `--id` | one of the two | |
| `channel uploads <CHANNEL>` | channel ref | resolves uploads playlist, then lists items |
| `video get <ID>...` / `video stats <ID>...` | video IDs (batched ×50) | `--parts` (no `fileDetails`/`processingDetails`/`suggestions`) |
| `video popular` | — | `--region` (default US), `--category` |
| `video trainability <ID>` | video ID | no key, no quota |
| `playlist get <ID>...` | playlist IDs | |
| `playlist list --channel <ID>` | channel ID | |
| `playlist items <ID>` | playlist ID | `--video` filters to one video |
| `comment get <ID>...` | comment IDs (batched ×100) | `--text-format plainText\|html` |
| `comment replies <PARENT_ID>` | parent comment ID | |
| `comment threads` | exactly one of `--video`/`--channel`/`--id` | `--order time\|relevance`, `--search` (both incompatible with `--id`) |
| `subscription list` | exactly one of `--channel`/`--id` | `--for-channel`, `--order` (incompatible with `--id`); many channels hide subscriptions → API error |
| `live-chat list` | one of `--video`/`--chat-id` | finite single page; `--all` rejected |
| `live-chat stream` | one of `--video`/`--chat-id` | JSONL default, `--limit`, `--page-token`; REST polling, respects `pollingIntervalMillis`, dedupes IDs, exits when chat ends |
| `category list` | one of `--region`/`--id` | |
| `language list` / `region list` | — | |
| `status [--check]` | — | local-only unless `--check` |
| `skills install` | confirmation | installs this bundled skill to `~/.agents/skills/oytc` |
| `version` | — | version/commit/date/platform |
| `update [--check] [--version vX.Y.Z]` | — | self-update; alias `upgrade` |

## Output envelope (JSON)

```json
{"items": [...], "nextPageToken": "…", "requests": 2}
```

JSONL: one item object per line, no envelope. Numeric counters are strings.

## Exit codes

0 success · 2 usage · 3 credentials · 4 not found/forbidden · 5 quota/rate limit ·
6 network/transient · 130 interrupted.

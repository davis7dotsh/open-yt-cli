---
name: oytc
description: Query public YouTube data and an authorized channel's read-only analytics via the oytc CLI. Use for video/channel stats, searches, uploads, comments, live chat, watch time, traffic sources, and demographics.
---

# oytc — read-only YouTube data and analytics CLI

`oytc` reads public YouTube Data API v3 resources with an API key and the authorized
channel's YouTube Analytics with read-only OAuth. It never writes. Revenue/content-owner
reports, private playlist/subscription access, moderation, uploads, and mutations remain
unsupported.

This skill assumes `oytc` is installed. Public commands need `oytc login` (or
`OYTC_API_KEY`); `analytics ...` needs `oytc login --oauth`. Verify both with
`oytc status --check`. Exit code 3 means the indicated credential must be configured or
reauthorized.

## Core usage pattern

Always request machine-readable output: `--format json` (stable envelope with `items`,
`nextPageToken`, `requests`) or `--format jsonl` (one resource per line). Piped output
defaults to JSON already, but be explicit.

```sh
oytc search "topic" --type video --limit 10 --format json
oytc channel get @handle --format json                 # accepts UC… IDs, @handles, URLs
oytc channel uploads @handle --all --limit 200 --format jsonl
oytc video get VIDEO_ID --format json
oytc video stats VIDEO_ID_1 VIDEO_ID_2 --format json   # counters are JSON strings
oytc playlist items PLAYLIST_ID --all --format jsonl
oytc comment threads --video VIDEO_ID --order relevance --format jsonl
oytc live-chat stream --video LIVE_VIDEO_ID --limit 100   # JSONL; REST polling fallback

# OAuth-only owner analytics
oytc analytics overview --by day --format json
oytc analytics video VIDEO_ID --start 2026-01-01 --end 2026-01-31 --format json
oytc analytics traffic-sources --format jsonl
oytc analytics demographics --format json
```

Pagination: `--all` follows pages, `--limit N` caps output, `--page-token` resumes.
Trim payloads with `--parts` and `--fields` when you only need specific properties.

## Quota and safety

- `search` costs 1 call from a small daily bucket (default 100/day) — batch reasoning
  before searching, prefer `channel uploads` / `playlist items` for enumeration.
- Other list reads cost ~1 unit of a 10,000/day quota; exit code 5 = quota exhausted.
- Exit codes: 0 ok, 2 usage, 3 credentials, 4 not found/forbidden, 5 quota, 6 transient.
- Never print, log, or echo API keys, OAuth tokens, or the client secret. `oytc status`
  intentionally shows only a key fingerprint plus OAuth client ID/scopes/expiry. Do not
  read the `auth.json` credential file.
- View/subscriber counters arrive as strings; keep them as strings to avoid precision loss.

## References

- [references/commands.md](references/commands.md) — condensed command/flag matrix
- [references/recipes.md](references/recipes.md) — common data-collection recipes
- Full project docs: https://github.com/davis7dotsh/open-yt-cli/blob/main/docs/commands.md

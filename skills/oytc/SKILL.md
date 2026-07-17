---
name: oytc
description: Query public YouTube data (search, videos, channels, playlists, comments, live chat) via the oytc CLI, which uses the YouTube Data API v3 with an API key. Use whenever a task needs public YouTube information — video/channel stats, search results, uploads, comment threads, live chat. NOT for private channel/account analytics (watch time, revenue, demographics, private playlists) — those require OAuth and are unsupported.
---

# oytc — public YouTube data CLI

`oytc` reads public YouTube Data API v3 resources with an API key. It is read-only and
cannot access anything private: if the task needs owner analytics (watch time, revenue,
audience demographics), private playlists/subscriptions, moderation, or uploads, stop —
those need OAuth and `oytc` deliberately does not implement it.

This skill assumes `oytc` is installed and a key is configured. Verify with
`oytc status --check` (exit code 3 means no/invalid key; the user must run `oytc login`).

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
```

Pagination: `--all` follows pages, `--limit N` caps output, `--page-token` resumes.
Trim payloads with `--parts` and `--fields` when you only need specific properties.

## Quota and safety

- `search` costs 1 call from a small daily bucket (default 100/day) — batch reasoning
  before searching, prefer `channel uploads` / `playlist items` for enumeration.
- Other list reads cost ~1 unit of a 10,000/day quota; exit code 5 = quota exhausted.
- Exit codes: 0 ok, 2 usage, 3 credentials, 4 not found/forbidden, 5 quota, 6 transient.
- Never print, log, or echo the API key; `oytc status` intentionally shows only a
  fingerprint. Do not read the auth.json credential file.
- View/subscriber counters arrive as strings; keep them as strings to avoid precision loss.

## References

- [references/commands.md](references/commands.md) — condensed command/flag matrix
- [references/recipes.md](references/recipes.md) — common data-collection recipes
- Full project docs: https://github.com/davis7dotsh/open-yt-cli/blob/main/docs/commands.md

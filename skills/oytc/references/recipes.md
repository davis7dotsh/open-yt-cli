# oytc recipes (agent reference)

Practical patterns for common data-collection tasks. All examples assume a configured key
(`oytc status --check` exits 0).

## Resolve a channel and get its stats

```sh
oytc channel get @GoogleDevelopers --format json \
  --columns id,snippet.title,statistics.subscriberCount,statistics.viewCount
```

Accepts `UC…` IDs, `@handles`, and youtube.com channel URLs. Legacy `/c/name` URLs resolve
by best-match search and may be wrong for ambiguous names — prefer the @handle.

## Enumerate every public upload of a channel

Cheaper and more complete than search:

```sh
oytc channel uploads @handle --all --format jsonl \
  --fields 'items(contentDetails/videoId,snippet/title,snippet/publishedAt),nextPageToken'
```

Then batch stats (50 IDs per request):

```sh
oytc video stats ID1 ID2 ID3 … --format json
```

## Search sparingly

Search has its own small quota bucket (default 100 calls/day). One page of 25–50 results
is usually enough; avoid `--all` on search.

```sh
oytc search "query" --type video --page-size 25 --order viewCount \
  --published-after 2026-01-01T00:00:00Z --format json
```

## Collect a video's comment threads

```sh
oytc comment threads --video VIDEO_ID --order relevance --all --limit 500 --format jsonl
```

Replies beyond the inlined ones: `oytc comment replies TOP_LEVEL_COMMENT_ID`.

## Sample a live stream's chat

```sh
oytc live-chat stream --video LIVE_VIDEO_ID --limit 200 --format jsonl
```

Bounded by `--limit`; exits on its own when the chat ends. This is REST polling (documented
fallback), so expect `pollingIntervalMillis`-paced batches, not per-message latency.

## Check AI-training permission for a video (no key, no quota)

```sh
oytc video trainability VIDEO_ID --format json
```

## Robust scripting

- Check exit codes: retry only on 6, surface 3 (credentials) and 5 (quota) to the user.
- Resume long enumerations with the `nextPageToken` from the JSON envelope + `--page-token`.
- Keep counter fields as strings; they can exceed float64-safe integers.

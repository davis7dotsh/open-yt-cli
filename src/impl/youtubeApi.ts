/**
 * The YouTube Data API client — `Get`, `List` and `ResolveChannel` from
 * `internal/youtube/client.go` + `list.go`, layered over `HttpCore`.
 *
 * `Get` decodes the one typed envelope; `items` stay opaque records, because
 * `--parts` and `--fields` let a user request arbitrary subsets and any
 * per-resource schema would reject responses the Go client accepts.
 */

import { Effect, Layer, Result, Schema } from "effect"
import { OperationalError, type OytcError } from "../domain/errors.ts"
import type { ListResult, PageOptions } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import { DataApiResponse } from "../schema/dataapi.ts"
import {
  HttpCore,
  type HttpCoreShape,
  type Params,
  type ResolvedChannel,
  YouTubeApi,
  type YouTubeApiShape
} from "../services/index.ts"
import { DEFAULT_BASE_URL } from "./httpCore.ts"
import { resolveChannelWith } from "./resolveChannel.ts"

export interface YouTubeApiConfig {
  /** Overridable so tests (and the Analytics client) can retarget the host. */
  readonly baseUrl?: string | undefined
}

const decodeResponse = Schema.decodeUnknownResult(DataApiResponse)

/**
 * `params.Set(key, value)` — replaces every existing entry for `key` and, when
 * the key is new, appends. Position of an existing key is preserved, which is
 * invisible in the URL (the encoder sorts) but keeps this list stable.
 */
const setParam = (params: Params, key: string, value: string): Params => {
  const kept = params.filter(([k]) => k !== key)
  return kept.length === params.length
    ? [...params, [key, value] as const]
    : params.map((entry) => (entry[0] === key ? ([key, value] as const) : entry))
}

export const makeYouTubeApi = (
  config: YouTubeApiConfig = {}
): Effect.Effect<YouTubeApiShape, never, HttpCoreShape> =>
  Effect.gen(function* () {
    const core = yield* HttpCore
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL

    const get = (resource: string, params: Params): Effect.Effect<DataApiResponse, OytcError> =>
      Effect.gen(function* () {
        const body = yield* core.getJson({ baseUrl, resource, params, authenticate: true })
        const decoded = decodeResponse(body)
        if (Result.isFailure(decoded)) {
          // Go's decoder is far more forgiving than a Schema — it silently
          // zeroes a wrong-typed field. Reaching this means the envelope's
          // shape is genuinely wrong, which Go would also surface as a decode
          // error, so the message matches `%w`-wrapped Go text.
          return yield* Effect.fail(
            new OperationalError({
              message: `decode YouTube API response: ${decoded.failure.message}`,
              cause: decoded.failure
            })
          )
        }
        return decoded.success
      })

    /**
     * The pagination loop.
     *
     * DEVIATIONS.md D2: Go set `nextPageToken` unconditionally to the last
     * fetched page's token, so a `--limit` truncation advertised a resume token
     * that skipped the discarded items. Here a page from which items were
     * DISCARDED reports `""` instead. Evaluated per page, so a page trimmed to
     * exactly its own length is not truncated and keeps its token.
     */
    const list = (
      resource: string,
      params: Params,
      options: PageOptions
    ): Effect.Effect<ListResult, OytcError> =>
      Effect.gen(function* () {
        // Go mutates the caller's url.Values in place; copying is strictly
        // safer and observationally identical for every call site.
        let current = params
        if (options.pageSize > 0) current = setParam(current, "maxResults", String(options.pageSize))
        if (options.pageToken !== "") current = setParam(current, "pageToken", options.pageToken)

        const kept: Array<JsonObject> = []
        let requests = 0
        let nextPageToken = ""

        for (;;) {
          const response = yield* get(resource, current)
          requests++

          let items = ((response.items ?? []) as ReadonlyArray<JsonObject>).slice()
          // The filter runs BEFORE the limit, so rejected items do not count
          // toward it and a page can contribute zero items while still
          // consuming a request.
          if (options.filter !== undefined) items = items.filter(options.filter)

          let truncated = false
          if (options.limit > 0 && kept.length + items.length > options.limit) {
            items = items.slice(0, options.limit - kept.length)
            truncated = true // items were DISCARDED from this page
          }
          kept.push(...items)
          // DEVIATIONS.md D2
          nextPageToken = truncated ? "" : (response.nextPageToken ?? "")

          if (
            !options.all ||
            nextPageToken === "" ||
            (options.limit > 0 && kept.length >= options.limit)
          ) {
            break
          }
          current = setParam(current, "pageToken", nextPageToken)
        }

        return { items: kept, nextPageToken, requests }
      })

    const resolveChannel = (reference: string): Effect.Effect<ResolvedChannel, OytcError> =>
      resolveChannelWith(get)(reference)

    return { get, list, resolveChannel } satisfies YouTubeApiShape
  })

export const youTubeApiLayer = (config: YouTubeApiConfig = {}) =>
  Layer.effect(YouTubeApi, makeYouTubeApi(config))

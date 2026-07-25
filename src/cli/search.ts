/**
 * `oytc search [QUERY]`.
 *
 * Ports `searchCommand` and `searchResultFilter` from `internal/cli/app.go`.
 *
 * Two things make this the most intricate command in the package.
 *
 * 1. THE CLIENT-SIDE KIND FILTER. The API's `type` parameter is advisory
 *    enough that Go re-checks every item's `id.kind` locally, and that filter
 *    runs INSIDE the pagination loop — before `--limit`. So rejected items do
 *    not count toward the limit, and a page can contribute zero items while
 *    still consuming a request. `items/id/kind` is injected into `--fields`
 *    when the user's selector would have excluded it, then deleted again
 *    (along with `id` itself, if that emptied it) before rendering.
 *
 * 2. THE `--type` CHECKS ARE EXACT STRING EQUALITY. `resourceType != "video"`
 *    compares the WHOLE flag value against the single word "video", so the
 *    default `video,channel,playlist` rejects every video-specific filter —
 *    and so does `--type video,channel`, and even `--type "video "`. Verified
 *    against the real binary; this is a wart, not a misreading, and it is
 *    preserved deliberately (DEVIATIONS.md lists only D1 and D2 as fixes).
 */

import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { isJsonObject } from "../json/value.ts"
import type { JsonObject } from "../json/value.ts"
import { searchColumns } from "../output/columns.ts"
import { YouTubeApi } from "../services/index.ts"
import type { Params } from "../services/index.ts"
import { fieldsWithRequired, stripSearchKinds } from "./fields.ts"
import { renderResult } from "./render.ts"
import {
  apiFlags,
  firstFailure,
  goTrimSpace,
  listFlags,
  maximumArgs,
  pageOptionsOf,
  partsOr,
  publishedFlags,
  raise,
  requireThat,
  requireTogether,
  setValues,
  validateCsvEnum,
  validateEnum,
  validatePagination,
  validateTimestamp
} from "./validate.ts"

/**
 * `searchResultFilter`'s acceptance half.
 *
 * An item is kept when `id.kind` starts with `youtube#` AND the remainder is in
 * the `--type` list. Everything else — a missing `id`, a non-object `id`, a
 * missing/oddly-prefixed kind — is REJECTED. Note the allowed set is built by
 * splitting `--type` on `,` and trimming, so it is far more permissive than the
 * exact-equality `--type` checks above; `--type "video, channel"` really does
 * accept both kinds here.
 */
export const searchKindFilter = (resourceTypes: string): ((item: JsonObject) => boolean) => {
  const allowed = new Set(resourceTypes.split(",").map(goTrimSpace))
  return (item) => {
    const id = item["id"]
    if (id === undefined || !isJsonObject(id)) return false
    const kind = id["kind"]
    if (typeof kind !== "string" || !kind.startsWith("youtube#")) return false
    return allowed.has(kind.slice("youtube#".length))
  }
}

export const searchCommand = Command.make(
  "search",
  {
    // Go's `maximumArgs(1)`: zero or one QUERY. A variadic argument is the only
    // way to observe an over-supply and report Go's own message.
    query: Argument.string("QUERY").pipe(
      Argument.withDescription("Search terms"),
      Argument.variadic()
    ),
    ...listFlags({ pageSize: 25 }),
    ...apiFlags,
    ...publishedFlags,
    channel: Flag.string("channel").pipe(
      Flag.withDefault(""),
      Flag.withDescription("only resources created by this channel ID")
    ),
    channelType: Flag.string("channel-type").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any or show (requires --type channel)")
    ),
    order: Flag.string("order").pipe(
      Flag.withDefault("relevance"),
      Flag.withDescription("date, rating, relevance, title, videoCount, or viewCount")
    ),
    region: Flag.string("region").pipe(
      Flag.withDefault(""),
      Flag.withDescription("ISO 3166-1 alpha-2 region code")
    ),
    language: Flag.string("language").pipe(
      Flag.withDefault(""),
      Flag.withDescription("relevance language code")
    ),
    safeSearch: Flag.string("safe-search").pipe(
      Flag.withDefault("moderate"),
      Flag.withDescription("moderate, none, or strict")
    ),
    resourceType: Flag.string("type").pipe(
      Flag.withDefault("video,channel,playlist"),
      Flag.withDescription("comma-separated video, channel, and/or playlist")
    ),
    eventType: Flag.string("event-type").pipe(
      Flag.withDefault(""),
      Flag.withDescription("completed, live, or upcoming (video searches)")
    ),
    location: Flag.string("location").pipe(
      Flag.withDefault(""),
      Flag.withDescription("latitude,longitude for a geographic video search")
    ),
    locationRadius: Flag.string("location-radius").pipe(
      Flag.withDefault(""),
      Flag.withDescription("radius such as 5km (requires --location)")
    ),
    topicId: Flag.string("topic").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Freebase topic ID")
    ),
    videoCaption: Flag.string("video-caption").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any, closedCaption, or none")
    ),
    videoCategory: Flag.string("video-category").pipe(
      Flag.withDefault(""),
      Flag.withDescription("video category ID")
    ),
    videoDuration: Flag.string("video-duration").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any, short, medium, or long")
    ),
    videoEmbeddable: Flag.string("video-embeddable").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any or true")
    ),
    videoLicense: Flag.string("video-license").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any, creativeCommon, or youtube")
    ),
    videoPaidProductPlacement: Flag.string("video-paid-product-placement").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any or true")
    ),
    videoSyndicated: Flag.string("video-syndicated").pipe(
      Flag.withDefault(""),
      Flag.withDescription("any or true")
    )
  },
  (flags) =>
    Effect.gen(function* () {
      const {
        query,
        channel,
        channelType,
        order,
        region,
        language,
        safeSearch,
        resourceType,
        eventType,
        location,
        locationRadius,
        topicId,
        videoCaption,
        videoCategory,
        videoDuration,
        videoEmbeddable,
        videoLicense,
        videoPaidProductPlacement,
        videoSyndicated,
        publishedAfter,
        publishedBefore,
        ...rest
      } = flags

      /**
       * Any video-only filter being set. `--topic`, `--region`, `--language`
       * and `--channel` are deliberately NOT in this list, matching Go — only
       * these nine are, and `--video-category` IS one despite not being an
       * enum. Confirmed against the binary.
       */
      const videoFilter =
        eventType !== "" ||
        location !== "" ||
        videoCaption !== "" ||
        videoCategory !== "" ||
        videoDuration !== "" ||
        videoEmbeddable !== "" ||
        videoLicense !== "" ||
        videoPaidProductPlacement !== "" ||
        videoSyndicated !== ""

      // Go's exact RunE order. Argument count and pagination come first
      // (cobra's Args and PreRunE), then every semantic check in source order.
      const invalid = firstFailure([
        maximumArgs(1, query.length),
        validatePagination(rest, 50),
        validateEnum("--order", order, [
          "date",
          "rating",
          "relevance",
          "title",
          "videoCount",
          "viewCount"
        ]),
        validateEnum("--safe-search", safeSearch, ["moderate", "none", "strict"]),
        validateCsvEnum("--type", resourceType, ["video", "channel", "playlist"]),
        validateEnum("--channel-type", channelType, ["any", "show"]),
        validateEnum("--event-type", eventType, ["completed", "live", "upcoming"]),
        validateEnum("--video-caption", videoCaption, ["any", "closedCaption", "none"]),
        validateEnum("--video-duration", videoDuration, ["any", "short", "medium", "long"]),
        validateEnum("--video-embeddable", videoEmbeddable, ["any", "true"]),
        validateEnum("--video-license", videoLicense, ["any", "creativeCommon", "youtube"]),
        validateEnum("--video-paid-product-placement", videoPaidProductPlacement, ["any", "true"]),
        validateEnum("--video-syndicated", videoSyndicated, ["any", "true"]),
        validateTimestamp("--published-after", publishedAfter),
        validateTimestamp("--published-before", publishedBefore),
        requireTogether(
          location,
          locationRadius,
          "--location and --location-radius must be used together"
        ),
        // EXACT string equality against "video" — see the file header.
        requireThat(!videoFilter || resourceType === "video", "video-specific filters require --type video"),
        requireThat(
          channelType === "" || resourceType === "channel",
          "--channel-type requires --type channel"
        )
      ])
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const { fields: requestFields, preserve: preserveKind } = fieldsWithRequired(
        rest.fields,
        "items/id/kind"
      )

      let params: Params = [["part", partsOr(rest.parts, "snippet")]]
      if (query.length === 1) params = [...params, ["q", query[0]!]]
      params = setValues(params, {
        channelId: channel,
        channelType,
        order,
        publishedAfter,
        publishedBefore,
        regionCode: region,
        relevanceLanguage: language,
        safeSearch,
        type: resourceType,
        eventType,
        location,
        locationRadius,
        topicId,
        videoCaption,
        videoCategoryId: videoCategory,
        videoDuration,
        videoEmbeddable,
        videoLicense,
        videoPaidProductPlacement,
        videoSyndicated,
        fields: requestFields
      })

      const youtube = yield* YouTubeApi
      const result = yield* youtube.list(
        "search",
        params,
        pageOptionsOf(rest, searchKindFilter(resourceType))
      )

      // Go deletes `id.kind` inside the filter, on accepted items only. Doing
      // it here is equivalent — the accepted items ARE the result items — and
      // is the only option over readonly values.
      yield* renderResult(
        { ...result, items: stripSearchKinds(result.items, preserveKind) },
        searchColumns
      )
    })
).pipe(
  Command.withDescription(
    "Search public YouTube resources (1 call from the 100 calls/day search bucket)"
  )
)

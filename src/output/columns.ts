/**
 * Column resolution and cell rendering — the shared row generator behind both
 * `table` and `tsv`.
 *
 * Ports `pathValue`, `cell`, and `clean` from `internal/output/output.go`, plus
 * the per-command default column lists that live in `internal/cli/*.go`.
 */

import { compareUtf8, runeLength } from "../util/gostring.ts"
import { isJsonArray, isJsonObject, isRawNumber } from "../json/value.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"

/**
 * `renderRows`'s fallback when the caller supplies no columns at all.
 * Every command supplies defaults in practice, but `RenderObject` callers and
 * `live-chat stream` route through the same code path.
 */
export const fallbackColumns: ReadonlyArray<string> = ["id", "snippet.title"]

/** `columns` if non-empty, else the command default, else the global fallback. */
export const resolveColumns = (
  requested: ReadonlyArray<string>,
  defaults: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const chosen = requested.length > 0 ? requested : defaults
  return chosen.length > 0 ? chosen : fallbackColumns
}

/**
 * The 27 runes where Go's SIMPLE uppercase is one rune but JS's FULL uppercase
 * expands to several, so the "length-changing means leave it alone" rule below
 * would wrongly leave them unchanged.
 *
 * All of them are the Greek ypogegrammeni (iota-subscript) letters: Go maps
 * each to its precomposed *prosgegrammeni* capital (U+1F80 "ᾀ" -> U+1F88 "ᾈ"),
 * while JS decomposes to a capital plus a separate U+0399 ("ἈΙ", 2 runes).
 * Enumerated by diffing `strings.ToUpper` over every rune in Go 1.26.5 against
 * this function; these were the only disagreements of this kind.
 *
 * Encoded as [start, end, delta] runs rather than 27 entries: 0x1F80-0x1F87,
 * 0x1F90-0x1F97 and 0x1FA0-0x1FA7 shift by +8; the three standalone
 * 0x1FB3/0x1FC3/0x1FF3 shift by +9.
 */
const IOTA_SUBSCRIPT_UPPER: ReadonlyArray<readonly [number, number, number]> = [
  [0x1f80, 0x1f87, 8],
  [0x1f90, 0x1f97, 8],
  [0x1fa0, 0x1fa7, 8],
  [0x1fb3, 0x1fb3, 9],
  [0x1fc3, 0x1fc3, 9],
  [0x1ff3, 0x1ff3, 9]
]

const simpleUpperException = (codePoint: number): string | undefined => {
  for (const [start, end, delta] of IOTA_SUBSCRIPT_UPPER) {
    if (codePoint >= start && codePoint <= end) return String.fromCodePoint(codePoint + delta)
  }
  return undefined
}

/**
 * `strings.ToUpper` — per-rune, locale-independent, and NEVER length-changing.
 *
 * Go's ToUpper applies the Unicode SIMPLE uppercase mapping, which is a
 * 1-rune -> 1-rune function. JS `toUpperCase()` applies the FULL mapping, which
 * expands some runes ("ß" -> "SS", "ﬁ" -> "FI"). Verified against the Go
 * implementation: ToUpper("straße") == "STRAßE" and ToUpper("ﬁle") == "ﬁLE", so
 * any rune whose uppercase is longer than one rune is left unchanged — EXCEPT
 * for the iota-subscript runes above, where Go does have a 1-rune mapping.
 *
 * "ı" (U+0131) -> "I" and "ǳ" (U+01F3) -> "Ǳ" (U+01F1, the *upper* not the
 * title form) both round-trip correctly through this rule.
 *
 * Checked exhaustively against Go 1.26.5 over all 1,112,064 scalar values; the
 * only remaining differences are runes cased in Unicode 15.1 (Bun's ICU) but
 * not in Unicode 15.0 (Go's table), e.g. U+019B and the Garay/Kirat Rai blocks.
 * That is a data-version gap, not a rule difference, and it resolves itself as
 * Go's tables update.
 */
export const goUpper = (s: string): string => {
  let out = ""
  for (const ch of s) {
    const upper = ch.toUpperCase()
    if (runeLength(upper) === 1) {
      out += upper
      continue
    }
    out += simpleUpperException(ch.codePointAt(0) ?? 0) ?? ch
  }
  return out
}

/** Header text for one column: the ENTIRE dotted path, uppercased. */
export const headerCell = (column: string): string => goUpper(column)

/**
 * Walk a dotted path. Returns `null` when any intermediate value is not an
 * object — indistinguishable from an explicit JSON `null` or a missing key,
 * exactly as in Go (all three collapse to `nil`).
 *
 * There is no escaping for literal dots in keys: a key containing a dot is
 * unreachable through `--columns`.
 */
export const pathValue = (item: JsonObject, path: string): JsonValue => {
  let value: JsonValue = item
  for (const segment of path.split(".")) {
    if (!isJsonObject(value)) return null
    value = value[segment] ?? null
  }
  return value
}

/**
 * Go's `strings.NewReplacer("\t", " ", "\r", " ", "\n", " ")`.
 *
 * Note what is NOT replaced: `\v` (U+000B) and `\f` (U+000C) survive, and both
 * are cell/line terminators for text/tabwriter. `table.ts` reproduces that.
 */
export const clean = (value: string): string => value.replace(/[\t\r\n]/g, " ")

/**
 * Render one value as flat text.
 *
 *   null/missing -> ""            (indistinguishable from an empty string)
 *   string       -> clean()       (tab, CR, LF each become one space)
 *   number       -> the ORIGINAL literal text (`1.50` stays `1.50`)
 *   bool         -> "true"/"false"
 *   array        -> elements joined with "," (no brackets, no quoting)
 *   object       -> keys sorted, "k=v" joined with "," (no braces)
 */
export const cell = (value: JsonValue): string => {
  if (value === null) return ""
  if (typeof value === "string") return clean(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (isRawNumber(value)) return value.$rawNumber
  if (isJsonArray(value)) return value.map(cell).join(",")
  if (isJsonObject(value)) {
    return Object.keys(value)
      .sort(compareUtf8)
      .map((key) => `${key}=${cell(value[key] ?? null)}`)
      .join(",")
  }
  return ""
}

/** One rendered row: `cell(pathValue(item, column))` for each column. */
export const rowCells = (
  item: JsonObject,
  columns: ReadonlyArray<string>
): ReadonlyArray<string> => columns.map((column) => cell(pathValue(item, column)))

/** The header row. */
export const headerRow = (columns: ReadonlyArray<string>): ReadonlyArray<string> =>
  columns.map(headerCell)

/**
 * Every row that will be emitted, header included when not suppressed. Shared
 * verbatim by `table.ts` and `tsv.ts` — Go's `renderRows` generates the rows
 * once and only the writer differs.
 */
export const generateRows = (
  items: ReadonlyArray<JsonObject>,
  columns: ReadonlyArray<string>,
  noHeader: boolean
): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: Array<ReadonlyArray<string>> = []
  if (!noHeader) rows.push(headerRow(columns))
  for (const item of items) rows.push(rowCells(item, columns))
  return rows
}

// ---------------------------------------------------------------------------
// Default column sets
//
// Transcribed from the Go call sites, NOT from the spec table, and cross-checked
// with `grep -rn 'columns' internal/cli/`. Each comment names the Go file:line.
// ---------------------------------------------------------------------------

/** `search` — app.go:186 */
export const searchColumns: ReadonlyArray<string> = [
  "id.kind",
  "id.videoId",
  "id.channelId",
  "id.playlistId",
  "snippet.title"
]

/** `channel get` — channel_video.go:61 */
export const channelGetColumns: ReadonlyArray<string> = [
  "id",
  "snippet.title",
  "statistics.subscriberCount",
  "statistics.videoCount",
  "statistics.viewCount"
]

/** `channel activities` — channel_video.go:98 */
export const channelActivitiesColumns: ReadonlyArray<string> = [
  "id",
  "snippet.publishedAt",
  "snippet.type",
  "snippet.title"
]

/** `channel sections` — channel_video.go:140 */
export const channelSectionsColumns: ReadonlyArray<string> = [
  "id",
  "snippet.type",
  "snippet.position",
  "snippet.title"
]

/** `channel uploads` — channel_video.go:183 */
export const channelUploadsColumns: ReadonlyArray<string> = [
  "snippet.position",
  "contentDetails.videoId",
  "snippet.title",
  "snippet.publishedAt"
]

/** `video get` — channel_video.go:200 */
export const videoGetColumns: ReadonlyArray<string> = [
  "id",
  "snippet.title",
  "snippet.channelTitle",
  "contentDetails.duration",
  "statistics.viewCount"
]

/** `video stats` — channel_video.go:203 */
export const videoStatsColumns: ReadonlyArray<string> = [
  "id",
  "statistics.viewCount",
  "statistics.likeCount",
  "statistics.commentCount"
]

/** `video popular` — channel_video.go:252 */
export const videoPopularColumns: ReadonlyArray<string> = [
  "id",
  "snippet.title",
  "snippet.channelTitle",
  "statistics.viewCount"
]

/** `video trainability` — channel_video.go:273 */
export const videoTrainabilityColumns: ReadonlyArray<string> = ["videoId", "permitted"]

/** `playlist get` — resources.go:43 */
export const playlistGetColumns: ReadonlyArray<string> = [
  "id",
  "snippet.title",
  "snippet.channelTitle",
  "contentDetails.itemCount",
  "status.privacyStatus"
]

/** `playlist list` — resources.go:62 */
export const playlistListColumns: ReadonlyArray<string> = [
  "id",
  "snippet.title",
  "contentDetails.itemCount",
  "status.privacyStatus"
]

/** `playlist items` — resources.go:80 */
export const playlistItemsColumns: ReadonlyArray<string> = [
  "snippet.position",
  "contentDetails.videoId",
  "snippet.title",
  "snippet.videoOwnerChannelTitle"
]

/** `comment get` and `comment replies` — resources.go:195 (`commentColumns()`) */
export const commentColumns: ReadonlyArray<string> = [
  "id",
  "snippet.authorDisplayName",
  "snippet.textDisplay",
  "snippet.likeCount",
  "snippet.publishedAt"
]

/** `comment threads` — resources.go:180 */
export const commentThreadsColumns: ReadonlyArray<string> = [
  "id",
  "snippet.topLevelComment.snippet.authorDisplayName",
  "snippet.topLevelComment.snippet.textDisplay",
  "snippet.totalReplyCount"
]

/** `subscription list` — resources.go:225 */
export const subscriptionListColumns: ReadonlyArray<string> = [
  "id",
  "snippet.resourceId.channelId",
  "snippet.title",
  "contentDetails.totalItemCount"
]

/** `category list` — resources.go:249 */
export const categoryListColumns: ReadonlyArray<string> = [
  "id",
  "snippet.title",
  "snippet.assignable"
]

/** `language list` — resources.go:267 */
export const languageListColumns: ReadonlyArray<string> = ["id", "snippet.name"]

/** `region list` — resources.go:283 */
export const regionListColumns: ReadonlyArray<string> = ["id", "snippet.name", "snippet.glName"]

/** `live-chat list` and `live-chat stream` — live_chat.go:201 */
export const liveChatColumns: ReadonlyArray<string> = [
  "snippet.publishedAt",
  "authorDetails.displayName",
  "snippet.displayMessage",
  "snippet.type",
  "id"
]

/**
 * `analytics report` — analytics.go:53. Dimensions first (in the order given),
 * then metrics. Both lists come from `csvValues`, which trims and drops empties.
 */
export const analyticsReportColumns = (
  dimensions: ReadonlyArray<string>,
  metrics: ReadonlyArray<string>
): ReadonlyArray<string> => [...dimensions, ...metrics]

/** `analytics overview` metrics — analytics.go:66 */
export const analyticsOverviewMetrics: ReadonlyArray<string> = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained"
]

/**
 * `analytics overview` — `[--by if set]` then the metrics (analytics.go:76).
 * `--by` goes through `csvValues`, so a blank or whitespace-only value
 * contributes no dimension at all.
 */
export const analyticsOverviewColumns = (by: string): ReadonlyArray<string> => {
  const dimension = by.trim()
  return dimension === "" ? analyticsOverviewMetrics : [dimension, ...analyticsOverviewMetrics]
}

/** `analytics video` — analytics.go:85 (metrics only, no dimensions). */
export const analyticsVideoColumns: ReadonlyArray<string> = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "likes",
  "comments",
  "subscribersGained"
]

/** `analytics traffic-sources` — analytics.go:99-100 */
export const analyticsTrafficSourcesColumns: ReadonlyArray<string> = [
  "insightTrafficSourceType",
  "views",
  "estimatedMinutesWatched"
]

/** `analytics demographics` — analytics.go:115-116 */
export const analyticsDemographicsColumns: ReadonlyArray<string> = [
  "ageGroup",
  "gender",
  "viewerPercentage"
]

/** `status` without `--check`, non-table formats only — auth.go:169 */
export const statusColumns: ReadonlyArray<string> = [
  "path",
  "api_key.configured",
  "api_key.source",
  "api_key.fingerprint",
  "oauth.configured",
  "oauth.client_id",
  "oauth.scopes",
  "oauth.expiry"
]

/** `status --check`, non-table formats only — auth.go:171 */
export const statusCheckColumns: ReadonlyArray<string> = [
  "path",
  "api_key.configured",
  "api_key.source",
  "api_key.fingerprint",
  "api_key.valid",
  "oauth.configured",
  "oauth.client_id",
  "oauth.scopes",
  "oauth.expiry",
  "oauth.valid"
]

/** `version`, non-table formats only — version_update.go:31 */
export const versionColumns: ReadonlyArray<string> = [
  "version",
  "commit",
  "date",
  "goVersion",
  "os",
  "arch"
]

/** `update`, non-table formats only — version_update.go:71 */
export const updateColumns: ReadonlyArray<string> = [
  "currentVersion",
  "targetVersion",
  "updated",
  "upToDate",
  "asset",
  "executable"
]

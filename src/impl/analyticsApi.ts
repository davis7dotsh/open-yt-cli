/**
 * YouTube Analytics reports client — the port of `internal/analytics/client.go`.
 *
 * One endpoint, no pagination, no token loop: `GET {base}/reports` decoded into
 * the typed `columnHeaders`/`rows` shape and flattened into row objects.
 *
 * Analytics is **OAuth-only**. The Go constructor builds its transport with an
 * empty API key, so the API-key branch of the auth switch can never fire; here
 * that falls out of `authenticate: true` plus a `HttpCore` whose token source
 * strictly beats the key. Retries, the 401-refresh-once dance, the 16 MiB cap,
 * number-preserving decoding, and `ApiError` construction all live in
 * `HttpCore` and are inherited unchanged.
 *
 * This module depends on `HttpCore` BY TAG ONLY.
 */

import { Effect, Layer, Result, Schema } from "effect"
import { OperationalError, type OytcError } from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { AnalyticsResponse } from "../schema/analytics.ts"
import {
  AnalyticsApi,
  type AnalyticsApiShape,
  type AnalyticsQuery,
  HttpCore,
  type HttpCoreShape,
  type Params
} from "../services/index.ts"

/** `analytics.DefaultBaseURL`. */
export const ANALYTICS_BASE_URL = "https://youtubeanalytics.googleapis.com/v2"

/** `analytics.MaxResults`. Also the CLI's `--limit` upper bound. */
export const MAX_RESULTS = 200

/**
 * `ids` is a hard-coded literal in Go — there is no support for
 * `contentOwner==`, `channel==<id>`, or any other owner form.
 */
export const ANALYTICS_IDS = "channel==MINE"

const RESOURCE = "reports"

// ---------------------------------------------------------------------------
// Query resolution
// ---------------------------------------------------------------------------

/**
 * Go's exact order of operations:
 *
 *   limit := query.Limit
 *   if limit == 0 { limit = MaxResults }        // zero-default FIRST
 *   if limit < 1 || limit > MaxResults { err }  // range check SECOND
 *
 * so `0` is legal and means 200, while `-1` and `201` are both errors.
 */
export const resolveLimit = (limit: number): Result.Result<number, OperationalError> => {
  const resolved = limit === 0 ? MAX_RESULTS : limit
  if (resolved < 1 || resolved > MAX_RESULTS) {
    return Result.fail(
      new OperationalError({ message: `analytics limit must be between 1 and ${MAX_RESULTS}` })
    )
  }
  return Result.succeed(resolved)
}

/**
 * `0` means "unspecified" and becomes the 1-based first row. Everything else,
 * negatives included, is sent verbatim — Go range-checks this value nowhere.
 */
export const resolveStartIndex = (startIndex: number): number =>
  startIndex === 0 ? 1 : startIndex

/**
 * The `reports` query string.
 *
 * `ids`, `startDate`, `endDate`, `metrics`, `maxResults` and `startIndex` are
 * ALWAYS present — including `startDate=&endDate=` when the caller left the
 * dates empty, which Google answers with a 400. That is Go's behaviour and it
 * is preserved deliberately; the CLI always fills the dates from computed flag
 * defaults, so an empty date only reaches here through a direct library call.
 *
 * `dimensions`, `filters` and `sort` are sent only when non-empty.
 */
export const analyticsQueryParams = (
  query: AnalyticsQuery
): Result.Result<Params, OperationalError> => {
  if (query.metrics === "") {
    return Result.fail(new OperationalError({ message: "analytics metrics cannot be empty" }))
  }
  const limit = resolveLimit(query.limit)
  if (Result.isFailure(limit)) return Result.fail(limit.failure)
  const startIndex = resolveStartIndex(query.startIndex)

  const params: Array<readonly [string, string]> = [
    ["ids", ANALYTICS_IDS],
    ["startDate", query.startDate],
    ["endDate", query.endDate],
    ["metrics", query.metrics],
    ["maxResults", String(limit.success)],
    ["startIndex", String(startIndex)]
  ]
  if (query.dimensions !== "") params.push(["dimensions", query.dimensions])
  if (query.filters !== "") params.push(["filters", query.filters])
  if (query.sort !== "") params.push(["sort", query.sort])
  return Result.succeed(params)
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * `analytics.Normalize` — flatten `columnHeaders` + `rows` into row objects.
 *
 *   - a row SHORTER than the header list is padded with explicit `null`
 *     (Go writes the nil into the map; the key is present, not absent)
 *   - a row LONGER than the header list has its extra cells dropped
 *     (the loop is over headers, not over cells)
 *   - duplicate header names collapse, last write winning, as Go's map does
 *
 * Cell values arrive as `JsonValue`, so a numeric cell is a `RawNumber` holding
 * its original literal: the integer `12` re-encodes as `12`, never `12.0`.
 *
 * Keys are installed with `Object.defineProperty`, not `item[name] = …`. A
 * header literally named `__proto__` — which Go stores in its map like any
 * other string — would otherwise hit the `Object.prototype` setter: the column
 * would VANISH from the output (or, for an object-valued cell, silently
 * replace the row's prototype). `defineProperty` creates a plain own property
 * for every name, so `__proto__` round-trips as a column like Go's does.
 */
export const normalizeAnalytics = (
  response: AnalyticsResponse
): ReadonlyArray<JsonObject> => {
  const headers = response.columnHeaders ?? []
  const rows = response.rows ?? []
  return rows.map((row) => {
    const item: Record<string, JsonValue> = {}
    for (let index = 0; index < headers.length; index++) {
      const name = headers[index]!.name
      Object.defineProperty(item, name, {
        value: index < row.length ? (row[index] as JsonValue) : null,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    return item
  })
}

/**
 * The list envelope Go's `Report` returns. `requests` is always exactly 1 —
 * there is no second request and no token pagination — and `nextPageToken` is
 * always empty, so the JSON envelope omits it.
 */
export const analyticsListResult = (response: AnalyticsResponse): ListResult => ({
  items: normalizeAnalytics(response),
  nextPageToken: "",
  requests: 1
})

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/** Go's `time.DateOnly` (`2006-01-02`) formatting of a UTC instant. */
export const formatDateOnly = (date: Date): string =>
  `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`

/** `AddDate(0, 0, days)` in UTC. `Date.UTC` normalizes month/year rollover. */
export const addUtcDays = (date: Date, days: number): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days))

export interface DateRange {
  readonly start: string
  readonly end: string
}

/**
 * The `--start`/`--end` flag defaults: 28 complete UTC days ending YESTERDAY.
 *
 *   end   = todayUTC - 1 day
 *   start = end - 27 days     // NOT end - 28: the window is inclusive
 *
 * Today is excluded because Analytics data for the current day is incomplete.
 * Computed in UTC, never local time — a machine in UTC+13 must not report a
 * different default window from one in UTC-8.
 */
export const defaultDateRange = (now: Date): DateRange => {
  const end = addUtcDays(now, -1)
  return { start: formatDateOnly(addUtcDays(end, -27)), end: formatDateOnly(end) }
}

/**
 * The range `status --check` probes with. Note it INCLUDES today, unlike the
 * command defaults: it is a liveness probe, not a report.
 */
export const statusCheckDateRange = (now: Date): DateRange => ({
  start: formatDateOnly(addUtcDays(now, -7)),
  end: formatDateOnly(now)
})

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const decodeResponse = Schema.decodeUnknownEffect(AnalyticsResponse)

/**
 * Go decodes into `[]ColumnHeader` / `[][]any`, and `encoding/json` unmarshals
 * a JSON `null` into a slice as a **nil slice with no error** — so
 * `{"rows":null}` is a valid empty report there. `Schema.optional(Schema.Array)`
 * rejects an explicit `null`, so drop those keys before decoding to keep the
 * two implementations in agreement. Verified against Go 1.26.5.
 */
export const tolerateNullSlices = (body: JsonValue): JsonValue => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body
  const record = body as { readonly [key: string]: JsonValue }
  if (record["columnHeaders"] !== null && record["rows"] !== null) return body
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === null && (key === "columnHeaders" || key === "rows")) continue
    out[key] = value
  }
  return out
}

/** Go: `fmt.Errorf("decode YouTube API response: %w", err)` — exit 6. */
const decodeAnalyticsResponse = (
  body: JsonValue
): Effect.Effect<AnalyticsResponse, OperationalError> =>
  decodeResponse(tolerateNullSlices(body)).pipe(
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(
        new OperationalError({ message: `decode YouTube API response: ${cause.message}`, cause })
      )
    )
  )

export const makeAnalyticsApiWith = (
  baseUrl: string
): Effect.Effect<AnalyticsApiShape, never, HttpCoreShape> =>
  Effect.gen(function* () {
    const http = yield* HttpCore
    return {
      report: (query: AnalyticsQuery): Effect.Effect<AnalyticsResponse, OytcError> =>
        Effect.gen(function* () {
          const params = yield* Effect.fromResult(analyticsQueryParams(query))
          const body = yield* http.getJson({
            baseUrl,
            resource: RESOURCE,
            params,
            authenticate: true
          })
          return yield* decodeAnalyticsResponse(body)
        }),
      normalize: normalizeAnalytics
    } satisfies AnalyticsApiShape
  })

export const makeAnalyticsApi = makeAnalyticsApiWith(ANALYTICS_BASE_URL)

export const AnalyticsApiLive = Layer.effect(AnalyticsApi, makeAnalyticsApi)

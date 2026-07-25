/**
 * Ported from `internal/analytics/client_test.go` (both cases) plus the
 * boundary conditions the Go tests leave implicit.
 *
 * `HttpCore` is consumed by TAG ONLY — every test here runs against a
 * `Layer.succeed`/`Layer.mock` double, never the live transport.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { encodeListResultJson } from "../domain/listResult.ts"
import { encodeGoValue } from "../json/encode.ts"
import { parseJson } from "../json/parse.ts"
import { isRawNumber, type JsonObject, type JsonValue, rawLiteral, rawNumber } from "../json/value.ts"
import { AnalyticsResponse } from "../schema/analytics.ts"
import {
  type AnalyticsQuery,
  HttpCore,
  type HttpCoreRequest,
  type HttpCoreShape,
  type Params
} from "../services/index.ts"
import {
  addUtcDays,
  ANALYTICS_BASE_URL,
  ANALYTICS_IDS,
  analyticsListResult,
  analyticsQueryParams,
  defaultDateRange,
  formatDateOnly,
  makeAnalyticsApiWith,
  MAX_RESULTS,
  normalizeAnalytics,
  resolveLimit,
  resolveStartIndex,
  statusCheckDateRange,
  tolerateNullSlices
} from "./analyticsApi.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseQuery: AnalyticsQuery = {
  metrics: "views",
  dimensions: "",
  filters: "",
  sort: "",
  startDate: "2026-01-01",
  endDate: "2026-01-02",
  limit: 0,
  startIndex: 0
}

const query = (overrides: Partial<AnalyticsQuery> = {}): AnalyticsQuery => ({
  ...baseQuery,
  ...overrides
})

const paramsOf = (q: AnalyticsQuery): Params => {
  const r = analyticsQueryParams(q)
  if (Result.isFailure(r)) throw new Error(`unexpected failure: ${r.failure.message}`)
  return r.success
}

const failureOf = (q: AnalyticsQuery): string => {
  const r = analyticsQueryParams(q)
  if (Result.isSuccess(r)) throw new Error("expected a failure")
  return r.failure.message
}

const asRecord = (params: Params): Record<string, string> =>
  Object.fromEntries(params.map(([k, v]) => [k, v]))

const keysOf = (params: Params): ReadonlyArray<string> => params.map(([k]) => k)

const decodeSync = Schema.decodeUnknownSync(AnalyticsResponse)

const parseOk = (text: string): JsonValue => {
  const r = parseJson(text)
  if (Result.isFailure(r)) throw new Error(`parse failed: ${r.failure.message}`)
  return r.success
}

/** A recording HttpCore double: captures the request, replays a fixed body. */
interface Recorder {
  readonly layer: Layer.Layer<HttpCoreShape>
  readonly requests: Array<HttpCoreRequest>
}

const recordingHttpCore = (body: JsonValue): Recorder => {
  const requests: Array<HttpCoreRequest> = []
  const shape: HttpCoreShape = {
    getJson: (request) =>
      Effect.sync(() => {
        requests.push(request)
        return body
      })
  }
  return { layer: Layer.succeed(HttpCore, shape), requests }
}

const BASE = "http://127.0.0.1:1/youtubeanalytics/v2"

const runReport = (
  q: AnalyticsQuery,
  recorder: Recorder,
  baseUrl = BASE
): Promise<AnalyticsResponse> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* makeAnalyticsApiWith(baseUrl)
      return yield* api.report(q)
    }).pipe(Effect.provide(recorder.layer))
  )

// ---------------------------------------------------------------------------
// TestReportNormalizesRowsByColumnName (client_test.go)
// ---------------------------------------------------------------------------

const GO_TEST_BODY =
  '{"columnHeaders":[{"name":"day","columnType":"DIMENSION","dataType":"STRING"},' +
  '{"name":"views","columnType":"METRIC","dataType":"INTEGER"},' +
  '{"name":"estimatedMinutesWatched","columnType":"METRIC","dataType":"FLOAT"}],' +
  '"rows":[["2026-01-01",12,3.5],["2026-01-02",8,2.25]]}'

describe("report normalizes rows by column name", () => {
  const goQuery = query({
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    metrics: "views,estimatedMinutesWatched",
    dimensions: "day",
    limit: 25
  })

  test("hits the reports resource on the analytics base, authenticated", async () => {
    const recorder = recordingHttpCore(parseOk(GO_TEST_BODY))
    await runReport(goQuery, recorder)
    expect(recorder.requests).toHaveLength(1)
    const request = recorder.requests[0]!
    expect(request.baseUrl).toBe(BASE)
    expect(request.resource).toBe("reports")
    // Analytics is OAuth-only; the transport attaches Bearer, never a key.
    expect(request.authenticate).toBe(true)
  })

  test("sends the exact query the Go test asserts", async () => {
    const recorder = recordingHttpCore(parseOk(GO_TEST_BODY))
    await runReport(goQuery, recorder)
    const params = asRecord(recorder.requests[0]!.params)
    expect(params["ids"]).toBe("channel==MINE")
    expect(params["metrics"]).toBe("views,estimatedMinutesWatched")
    expect(params["dimensions"]).toBe("day")
    expect(params["maxResults"]).toBe("25")
    expect(params["startIndex"]).toBe("1")
  })

  test("flattens two rows and reports exactly one request", async () => {
    const recorder = recordingHttpCore(parseOk(GO_TEST_BODY))
    const response = await runReport(goQuery, recorder)
    const result = analyticsListResult(response)
    expect(result.items).toHaveLength(2)
    expect(result.requests).toBe(1)
    expect(result.nextPageToken).toBe("")
    expect(result.items[0]!["day"]).toBe("2026-01-01")
    expect(result.items[1]!["day"]).toBe("2026-01-02")
  })

  // The heart of the Go assertion: `views` must be json.Number("12"), not a
  // float64 that renders as 12.0.
  test("integer cell 12 stays the literal \"12\", never \"12.0\"", async () => {
    const recorder = recordingHttpCore(parseOk(GO_TEST_BODY))
    const response = await runReport(goQuery, recorder)
    const first = normalizeAnalytics(response)[0]!
    const views = first["views"]
    expect(isRawNumber(views)).toBe(true)
    expect(rawLiteral(views as { readonly $rawNumber: string })).toBe("12")
    expect(encodeGoValue(views as JsonValue, { indent: "" })).toBe("12")
    expect(encodeGoValue(first, { indent: "" })).toBe(
      '{"day":"2026-01-01","estimatedMinutesWatched":3.5,"views":12}'
    )
  })

  test("float cells keep their literals too", async () => {
    const recorder = recordingHttpCore(parseOk(GO_TEST_BODY))
    const response = await runReport(goQuery, recorder)
    const items = normalizeAnalytics(response)
    expect(rawLiteral(items[0]!["estimatedMinutesWatched"] as never)).toBe("3.5")
    expect(rawLiteral(items[1]!["estimatedMinutesWatched"] as never)).toBe("2.25")
  })

  test("counters beyond 2^53 survive byte-for-byte", async () => {
    const recorder = recordingHttpCore(
      parseOk(
        '{"columnHeaders":[{"name":"views"}],"rows":[[9007199254740993123]]}'
      )
    )
    const response = await runReport(query(), recorder)
    const item = normalizeAnalytics(response)[0]!
    expect(encodeGoValue(item, { indent: "" })).toBe('{"views":9007199254740993123}')
  })
})

// ---------------------------------------------------------------------------
// TestNormalizeFillsMissingCells (client_test.go)
// ---------------------------------------------------------------------------

describe("normalize", () => {
  test("pads a short row with explicit null", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "day" }, { name: "views" }],
      rows: [["2026-01-01"]]
    })
    expect(items).toHaveLength(1)
    expect(items[0]!["day"]).toBe("2026-01-01")
    expect(items[0]!["views"]).toBeNull()
  })

  test("the padded key is PRESENT, not absent", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "day" }, { name: "views" }],
      rows: [["2026-01-01"]]
    })
    expect(Object.keys(items[0] as JsonObject)).toEqual(["day", "views"])
    expect("views" in (items[0] as object)).toBe(true)
    expect(encodeGoValue(items[0]!, { indent: "" })).toBe('{"day":"2026-01-01","views":null}')
  })

  test("drops cells beyond the header list", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "day" }],
      rows: [["2026-01-01", "extra", rawNumber("7")]]
    })
    expect(Object.keys(items[0] as JsonObject)).toEqual(["day"])
    expect(items[0]!["day"]).toBe("2026-01-01")
  })

  test("an empty row becomes an all-null object", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "a" }, { name: "b" }],
      rows: [[]]
    })
    expect(items[0]).toEqual({ a: null, b: null })
  })

  test("no headers yields empty objects, one per row", () => {
    const items = normalizeAnalytics({ columnHeaders: [], rows: [["x"], ["y"]] })
    expect(items).toEqual([{}, {}])
  })

  test("no rows yields an empty array, never null", () => {
    const items = normalizeAnalytics({ columnHeaders: [{ name: "day" }], rows: [] })
    expect(items).toEqual([])
  })

  test("omitted columnHeaders/rows are treated as empty", () => {
    expect(normalizeAnalytics({})).toEqual([])
    expect(normalizeAnalytics({ rows: [["x"]] })).toEqual([{}])
    expect(normalizeAnalytics({ columnHeaders: [{ name: "day" }] })).toEqual([])
  })

  // Go writes into a map, so a repeated header name keeps the LAST cell.
  test("duplicate header names collapse, last write winning", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "day" }, { name: "day" }],
      rows: [["first", "second"]]
    })
    expect(items[0]).toEqual({ day: "second" })
  })

  // Go stores `__proto__` in its map like any other header name. A plain
  // `item[name] = value` in JS hits the Object.prototype setter instead, so
  // the column would silently vanish from the output.
  test("a header named __proto__ becomes a real column, not a prototype write", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "__proto__" }, { name: "views" }],
      rows: [["2026-01-01", rawNumber("5")]]
    })
    expect(Object.keys(items[0] as JsonObject)).toEqual(["__proto__", "views"])
    expect(Object.getPrototypeOf(items[0])).toBe(Object.prototype)
    expect(encodeGoValue(items[0]!, { indent: "" })).toBe(
      '{"__proto__":"2026-01-01","views":5}'
    )
  })

  // The dangerous shape: an OBJECT cell under a __proto__ header would
  // otherwise replace the row's prototype and export zero own keys.
  test("an object cell under a __proto__ header does not swap the prototype", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "__proto__" }],
      rows: [[{ evil: "yes" }]]
    })
    expect(Object.getPrototypeOf(items[0])).toBe(Object.prototype)
    expect((items[0] as Record<string, unknown>)["evil"]).toBeUndefined()
    expect(encodeGoValue(items[0]!, { indent: "" })).toBe('{"__proto__":{"evil":"yes"}}')
  })

  test("duplicate __proto__ headers still collapse last-write-wins", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "__proto__" }, { name: "__proto__" }],
      rows: [["first", "second"]]
    })
    expect(items[0]!["__proto__"]).toBe("second")
    expect(Object.keys(items[0] as JsonObject)).toEqual(["__proto__"])
  })

  test("null, boolean and nested cells pass through untouched", () => {
    const items = normalizeAnalytics({
      columnHeaders: [{ name: "a" }, { name: "b" }, { name: "c" }],
      rows: [[null, true, ["x", "y"]]]
    })
    expect(items[0]!["a"]).toBeNull()
    expect(items[0]!["b"]).toBe(true)
    expect(items[0]!["c"]).toEqual(["x", "y"])
  })
})

// ---------------------------------------------------------------------------
// Parameter construction
// ---------------------------------------------------------------------------

describe("query parameters", () => {
  test("ids is the hard-coded constant", () => {
    expect(ANALYTICS_IDS).toBe("channel==MINE")
    expect(asRecord(paramsOf(query()))["ids"]).toBe("channel==MINE")
  })

  test("the six unconditional params are always present", () => {
    expect([...keysOf(paramsOf(query()))].sort()).toEqual([
      "endDate",
      "ids",
      "maxResults",
      "metrics",
      "startDate",
      "startIndex"
    ])
  })

  // Go sets startDate/endDate unconditionally; empty dates go on the wire and
  // Google answers 400. Preserved deliberately — see SPEC_API.md §6.3.
  test("empty dates are still sent, as empty values", () => {
    const params = paramsOf(query({ startDate: "", endDate: "" }))
    expect(keysOf(params)).toContain("startDate")
    expect(keysOf(params)).toContain("endDate")
    const record = asRecord(params)
    expect(record["startDate"]).toBe("")
    expect(record["endDate"]).toBe("")
  })

  test.each([
    ["dimensions", "day"],
    ["filters", "video==abc"],
    ["sort", "-views"]
  ])("%s is omitted when empty and sent when set", (key, value) => {
    expect(keysOf(paramsOf(query()))).not.toContain(key)
    const params = paramsOf(query({ [key]: value } as Partial<AnalyticsQuery>))
    expect(asRecord(params)[key]).toBe(value)
  })

  test("all three optional params can appear together", () => {
    const params = asRecord(
      paramsOf(query({ dimensions: "ageGroup,gender", filters: "video==abc", sort: "-views" }))
    )
    expect(params["dimensions"]).toBe("ageGroup,gender")
    expect(params["filters"]).toBe("video==abc")
    expect(params["sort"]).toBe("-views")
  })

  test("metrics is passed through verbatim", () => {
    expect(asRecord(paramsOf(query({ metrics: "views,likes" })))["metrics"]).toBe("views,likes")
  })

  test("empty metrics is rejected", () => {
    expect(failureOf(query({ metrics: "" }))).toBe("analytics metrics cannot be empty")
  })

  test("metrics is checked before the limit bounds", () => {
    expect(failureOf(query({ metrics: "", limit: 999 }))).toBe(
      "analytics metrics cannot be empty"
    )
  })

  test("report fails without ever reaching the transport", async () => {
    const recorder = recordingHttpCore(parseOk("{}"))
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const api = yield* makeAnalyticsApiWith(BASE)
          return yield* api.report(query({ metrics: "" }))
        }).pipe(Effect.provide(recorder.layer))
      )
    )
    expect(exit._tag).toBe("Failure")
    expect(recorder.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Limit and startIndex resolution — the zero-default-before-range-check rule
// ---------------------------------------------------------------------------

describe("limit resolution", () => {
  test("MaxResults is 200", () => {
    expect(MAX_RESULTS).toBe(200)
  })

  test.each([
    [0, 200, "zero means unspecified, resolved BEFORE the range check"],
    [1, 1, "lower bound"],
    [25, 25, "the Go test's value"],
    [200, 200, "upper bound"]
  ])("limit %d -> maxResults %d (%s)", (input, expected) => {
    const r = resolveLimit(input)
    if (!Result.isSuccess(r)) throw new Error("expected a success")
    expect(r.success).toBe(expected)
    expect(asRecord(paramsOf(query({ limit: input })))["maxResults"]).toBe(String(expected))
  })

  test.each([
    [201, "just past the upper bound"],
    [1000, "far past the upper bound"],
    [-1, "negative, NOT rescued by the zero-default"],
    [-200, "negative magnitude is irrelevant"]
  ])("limit %d is rejected (%s)", (input) => {
    expect(failureOf(query({ limit: input }))).toBe("analytics limit must be between 1 and 200")
  })

  // Order matters: if the range check ran first, 0 would be an error too.
  test("0 is valid but -1 is not — proof the zero-default runs first", () => {
    expect(Result.isSuccess(resolveLimit(0))).toBe(true)
    expect(Result.isFailure(resolveLimit(-1))).toBe(true)
  })
})

describe("startIndex resolution", () => {
  test("0 becomes 1", () => {
    expect(resolveStartIndex(0)).toBe(1)
    expect(asRecord(paramsOf(query({ startIndex: 0 })))["startIndex"]).toBe("1")
  })

  test.each([1, 2, 201, 100_000])("%d passes through unchanged", (input) => {
    expect(resolveStartIndex(input)).toBe(input)
    expect(asRecord(paramsOf(query({ startIndex: input })))["startIndex"]).toBe(String(input))
  })

  // Go range-checks startIndex nowhere; a negative is sent verbatim.
  test("negatives are sent verbatim, not validated", () => {
    expect(resolveStartIndex(-5)).toBe(-5)
    expect(asRecord(paramsOf(query({ startIndex: -5 })))["startIndex"]).toBe("-5")
  })
})

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe("list envelope", () => {
  test("requests is always exactly 1", () => {
    expect(analyticsListResult({}).requests).toBe(1)
    expect(analyticsListResult({ columnHeaders: [], rows: [] }).requests).toBe(1)
    expect(
      analyticsListResult({ columnHeaders: [{ name: "a" }], rows: [["x"], ["y"]] }).requests
    ).toBe(1)
  })

  test("nextPageToken is always empty — no analytics pagination", () => {
    expect(analyticsListResult({ columnHeaders: [{ name: "a" }], rows: [["x"]] }).nextPageToken)
      .toBe("")
  })

  test("an empty report yields an empty items array", () => {
    expect(analyticsListResult({}).items).toEqual([])
  })

  // Golden: byte-for-byte output of the equivalent Go program (`go run`,
  // json.Encoder with SetIndent("", "  ") over the same ListResult struct).
  test.each([
    [
      '{"columnHeaders":[{"name":"day"},{"name":"views"}],"rows":[["2026-01-01",12],["2026-01-02",8]]}',
      '{\n  "items": [\n    {\n      "day": "2026-01-01",\n      "views": 12\n    },\n' +
        '    {\n      "day": "2026-01-02",\n      "views": 8\n    }\n  ],\n  "requests": 1\n}\n'
    ],
    ['{"columnHeaders":[{"name":"day"}],"rows":[]}', '{\n  "items": [],\n  "requests": 1\n}\n'],
    ["{}", '{\n  "items": [],\n  "requests": 1\n}\n']
  ])("envelope for %s matches the Go encoder byte-for-byte", (body, expected) => {
    expect(encodeListResultJson(analyticsListResult(decodeSync(parseOk(body))))).toBe(expected)
  })

  // nextPageToken carries `omitempty` in Go and is never set by analytics, so
  // the key must not appear at all.
  test("the envelope omits nextPageToken entirely", () => {
    expect(
      encodeListResultJson(analyticsListResult({ columnHeaders: [{ name: "a" }], rows: [["x"]] }))
    ).not.toContain("nextPageToken")
  })
})

// ---------------------------------------------------------------------------
// Transport surface
// ---------------------------------------------------------------------------

describe("transport", () => {
  test("the default base URL is the analytics v2 host", () => {
    expect(ANALYTICS_BASE_URL).toBe("https://youtubeanalytics.googleapis.com/v2")
  })

  test("the base URL is injectable, so tests can point at a local server", async () => {
    const recorder = recordingHttpCore(parseOk("{}"))
    await runReport(query(), recorder, "http://localhost:9/v2")
    expect(recorder.requests[0]!.baseUrl).toBe("http://localhost:9/v2")
  })

  test("exactly one request per report — no token loop", async () => {
    const recorder = recordingHttpCore(parseOk(GO_TEST_BODY))
    await runReport(query(), recorder)
    expect(recorder.requests).toHaveLength(1)
  })

  test("transport failures propagate untouched", async () => {
    const failing = Layer.succeed(HttpCore, {
      getJson: () => Effect.die("boom")
    } satisfies HttpCoreShape)
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const api = yield* makeAnalyticsApiWith(BASE)
          return yield* api.report(query())
        }).pipe(Effect.provide(failing))
      )
    )
    expect(exit._tag).toBe("Failure")
  })

  test("a response with unknown extra keys still decodes", async () => {
    const recorder = recordingHttpCore(
      parseOk('{"kind":"youtubeAnalytics#resultTable","columnHeaders":[{"name":"day"}],"rows":[["x"]]}')
    )
    const response = await runReport(query(), recorder)
    expect(normalizeAnalytics(response)).toEqual([{ day: "x" }])
  })

  test("an empty JSON object decodes to an empty report", async () => {
    const recorder = recordingHttpCore(parseOk("{}"))
    const response = await runReport(query(), recorder)
    expect(analyticsListResult(response).items).toEqual([])
  })

  // Go's encoding/json unmarshals a JSON null into a slice field as a nil
  // slice with NO error, so these are valid empty reports there. Verified
  // against Go 1.26.5; the frozen schema would reject the explicit null, so
  // the client strips it first.
  test.each([
    '{"rows":null}',
    '{"columnHeaders":null}',
    '{"columnHeaders":null,"rows":null}',
    '{"columnHeaders":[{"name":"day"}],"rows":null}'
  ])("%s decodes to an empty report, matching Go", async (body) => {
    const recorder = recordingHttpCore(parseOk(body))
    const response = await runReport(query(), recorder)
    expect(analyticsListResult(response).items).toEqual([])
  })

  test("a null row list does not disturb the headers", async () => {
    const recorder = recordingHttpCore(parseOk('{"columnHeaders":[{"name":"day"}],"rows":null}'))
    const response = await runReport(query(), recorder)
    expect(response.columnHeaders).toEqual([{ name: "day" }])
  })

  test("tolerateNullSlices leaves everything else untouched", () => {
    const body = parseOk('{"kind":"x","columnHeaders":[{"name":"day"}],"rows":[["x"]]}')
    expect(tolerateNullSlices(body)).toBe(body)
    expect(tolerateNullSlices(parseOk('{"other":null}'))).toEqual({ other: null })
    expect(tolerateNullSlices(parseOk("[1,2]"))).toEqual([rawNumber("1"), rawNumber("2")])
  })

  // Go: fmt.Errorf("decode YouTube API response: %w", err) — an OperationalError,
  // which exits 6.
  test.each([
    ['{"rows":"nope"}', "rows is not an array"],
    ['{"columnHeaders":[{"name":123}]}', "header name is not a string"],
    ["[1,2,3]", "body is not an object"]
  ])("%s fails to decode (%s)", async (body) => {
    const recorder = recordingHttpCore(parseOk(body))
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const api = yield* makeAnalyticsApiWith(BASE)
          return yield* api.report(query())
        }).pipe(Effect.provide(recorder.layer))
      )
    )
    expect(exit._tag).toBe("Failure")
  })

  test("a decode failure is an OperationalError with Go's message prefix", async () => {
    const recorder = recordingHttpCore(parseOk('{"rows":"nope"}'))
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const api = yield* makeAnalyticsApiWith(BASE)
          return yield* api.report(query())
        }).pipe(Effect.provide(recorder.layer))
      )
    )
    if (!Result.isFailure(result)) throw new Error("expected a failure")
    expect(result.failure._tag).toBe("OperationalError")
    expect(result.failure.message).toStartWith("decode YouTube API response: ")
  })

  test("normalize is exposed on the service", async () => {
    const recorder = recordingHttpCore(parseOk("{}"))
    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeAnalyticsApiWith(BASE)
        return api.normalize({ columnHeaders: [{ name: "day" }], rows: [["x"]] })
      }).pipe(Effect.provide(recorder.layer))
    )
    expect(items).toEqual([{ day: "x" }])
  })
})

// ---------------------------------------------------------------------------
// Date ranges — UTC, always
// ---------------------------------------------------------------------------

describe("date helpers", () => {
  test.each([
    ["2026-03-01T05:00:00Z", "2026-02-01", "2026-02-28"],
    ["2026-01-01T00:00:00Z", "2025-12-04", "2025-12-31"],
    ["2024-03-01T23:59:59Z", "2024-02-02", "2024-02-29"],
    ["2026-07-24T12:00:00Z", "2026-06-26", "2026-07-23"],
    ["2025-01-15T00:00:00Z", "2024-12-18", "2025-01-14"]
  ])("default range at %s is %s..%s", (now, start, end) => {
    // Values produced by `go run` against the Go expression
    //   end := now().UTC().AddDate(0,0,-1); start := end.AddDate(0,0,-27)
    expect(defaultDateRange(new Date(now))).toEqual({ start, end })
  })

  test("the window is 28 inclusive days: end - 27, not end - 28", () => {
    const { start, end } = defaultDateRange(new Date("2026-07-24T12:00:00Z"))
    const days =
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
    expect(days).toBe(27)
  })

  test("today is excluded — end is yesterday", () => {
    expect(defaultDateRange(new Date("2026-07-24T00:00:00Z")).end).toBe("2026-07-23")
  })

  // A local-time computation would give a different answer either side of
  // midnight UTC; this pins the UTC reading.
  test("computed in UTC, not local time", () => {
    const justAfterUtcMidnight = new Date("2026-07-24T00:30:00Z")
    const justBeforeUtcMidnight = new Date("2026-07-23T23:30:00Z")
    expect(defaultDateRange(justAfterUtcMidnight).end).toBe("2026-07-23")
    expect(defaultDateRange(justBeforeUtcMidnight).end).toBe("2026-07-22")
  })

  test("status --check probes a 7-day window that INCLUDES today", () => {
    expect(statusCheckDateRange(new Date("2026-07-24T12:00:00Z"))).toEqual({
      start: "2026-07-17",
      end: "2026-07-24"
    })
  })

  test.each([
    ["2026-07-24T12:00:00Z", "2026-07-24"],
    ["0999-01-02T00:00:00Z", "0999-01-02"],
    ["2026-01-09T00:00:00Z", "2026-01-09"]
  ])("formatDateOnly(%s) = %s (zero-padded, Go's time.DateOnly)", (input, expected) => {
    expect(formatDateOnly(new Date(input))).toBe(expected)
  })

  test("addUtcDays rolls over months, years and leap days", () => {
    expect(formatDateOnly(addUtcDays(new Date("2026-01-31T00:00:00Z"), 1))).toBe("2026-02-01")
    expect(formatDateOnly(addUtcDays(new Date("2026-01-01T00:00:00Z"), -1))).toBe("2025-12-31")
    expect(formatDateOnly(addUtcDays(new Date("2024-02-28T00:00:00Z"), 1))).toBe("2024-02-29")
    expect(formatDateOnly(addUtcDays(new Date("2025-02-28T00:00:00Z"), 1))).toBe("2025-03-01")
  })
})

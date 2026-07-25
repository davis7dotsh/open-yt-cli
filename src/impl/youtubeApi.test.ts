/**
 * Data API client tests.
 *
 * Ported from `internal/youtube/client_test.go`:
 *   TestListPaginationLimitAndToken            (MODIFIED — see DEVIATIONS.md D2)
 *   TestListReturnsEmptySliceWhenResponseHasNoItems
 *
 * These run against a stub `HttpCore` rather than a stub `fetch`, because the
 * transport already has its own suite; what matters here is the pagination
 * algebra. One case reaches all the way down through the real `HttpCore` to a
 * stub `fetch` to prove the two layers actually compose.
 */

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { FetchHttpClient } from "../effect.ts"
import { ApiError, OperationalError, type OytcError } from "../domain/errors.ts"
import { defaultPageOptions, type PageOptions } from "../domain/listResult.ts"
import { parseJson } from "../json/parse.ts"
import { isRawNumber, type JsonObject, type JsonValue } from "../json/value.ts"
import {
  HttpCore,
  type HttpCoreRequest,
  type HttpCoreShape,
  type Params
} from "../services/index.ts"
import { makeHttpCore } from "./httpCore.ts"
import { makeYouTubeApi } from "./youtubeApi.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SeenCall {
  readonly resource: string
  readonly params: Params
  readonly authenticate: boolean
  readonly baseUrl: string
}

interface Stub {
  readonly seen: Array<SeenCall>
  readonly layer: Layer.Layer<HttpCoreShape>
}

/** See httpCore.test.ts — a stub only needs fetch's call signature. */
type StubFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

const jsonBody = (text: string): JsonValue => {
  const parsed = parseJson(text)
  if (parsed._tag === "Failure") throw new Error(`bad fixture: ${parsed.failure.message}`)
  return parsed.success
}

/** `bodies[n-1]` answers request n; the last entry repeats. */
const stubCore = (bodies: ReadonlyArray<string | OytcError>): Stub => {
  const seen: Array<SeenCall> = []
  const layer = Layer.succeed(HttpCore, {
    getJson: (request: HttpCoreRequest) => {
      seen.push({
        resource: request.resource,
        params: request.params,
        authenticate: request.authenticate,
        baseUrl: request.baseUrl
      })
      const entry = bodies[Math.min(seen.length - 1, bodies.length - 1)]!
      return typeof entry === "string"
        ? Effect.succeed(jsonBody(entry))
        : Effect.fail(entry as never)
    }
  })
  return { seen, layer }
}

const runList = (
  bodies: ReadonlyArray<string | OytcError>,
  options: Partial<PageOptions> = {},
  resource = "playlistItems",
  params: Params = []
) => {
  const stub = stubCore(bodies)
  const program = Effect.gen(function* () {
    const api = yield* makeYouTubeApi()
    return yield* api.list(resource, params, { ...defaultPageOptions, ...options })
  })
  return Effect.runPromise(
    program.pipe(Effect.provide(stub.layer), Effect.exit)
  ).then((exit) => ({ exit, seen: stub.seen }))
}

const okOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const errOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  const found = Cause.findErrorOption(exit.cause)
  if (!Option.isSome(found)) throw new Error("no error in cause")
  return found.value
}

const param = (params: Params, key: string): string | undefined =>
  params.find(([k]) => k === key)?.[1]

const ids = (items: ReadonlyArray<JsonObject>): ReadonlyArray<unknown> =>
  items.map((item) => item["id"])

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  test("decodes the envelope and always authenticates", async () => {
    const stub = stubCore([`{"items":[{"id":"v"}],"nextPageToken":"n","kind":"youtube#videoListResponse"}`])
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi()
        return yield* api.get("videos", [["id", "v"]])
      }).pipe(Effect.provide(stub.layer))
    )
    expect(response.items).toHaveLength(1)
    expect(response.nextPageToken).toBe("n")
    expect(stub.seen[0]!.authenticate).toBe(true)
    expect(stub.seen[0]!.resource).toBe("videos")
  })

  test("{} decodes with no items", async () => {
    const stub = stubCore(["{}"])
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi()
        return yield* api.get("search", [])
      }).pipe(Effect.provide(stub.layer))
    )
    expect(response.items).toBeUndefined()
  })

  test("unknown top-level keys are ignored", async () => {
    const stub = stubCore([`{"items":[],"regionCode":"US","tokenPagination":{}}`])
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi()
        return yield* api.get("search", [])
      }).pipe(Effect.provide(stub.layer))
    )
    expect(response.items).toEqual([])
  })

  test("defaults to the production base URL", async () => {
    const stub = stubCore(["{}"])
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi()
        return yield* api.get("videos", [])
      }).pipe(Effect.provide(stub.layer))
    )
    expect(stub.seen[0]!.baseUrl).toBe("https://www.googleapis.com/youtube/v3")
  })

  test("an overridden base URL is threaded through", async () => {
    const stub = stubCore(["{}"])
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi({ baseUrl: "https://stub.test/v3" })
        return yield* api.get("videos", [])
      }).pipe(Effect.provide(stub.layer))
    )
    expect(stub.seen[0]!.baseUrl).toBe("https://stub.test/v3")
  })

  test("propagates an ApiError unchanged", async () => {
    const stub = stubCore([
      new ApiError({ httpStatus: 403, code: 403, apiMessage: "no", reasons: ["quotaExceeded"] })
    ])
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi()
        return yield* api.get("videos", [])
      }).pipe(Effect.provide(stub.layer), Effect.exit)
    )
    const error = errOf(exit)
    expect(error).toBeInstanceOf(ApiError)
  })

  test("an envelope of the wrong shape is a decode error", async () => {
    const stub = stubCore([`{"items":"not-an-array"}`])
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* makeYouTubeApi()
        return yield* api.get("videos", [])
      }).pipe(Effect.provide(stub.layer), Effect.exit)
    )
    const error = errOf(exit)
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("decode YouTube API response: ")
  })
})

// ---------------------------------------------------------------------------
// list — pagination
// ---------------------------------------------------------------------------

describe("list", () => {
  // Go: TestListPaginationLimitAndToken — MODIFIED under DEVIATIONS.md D2.
  test("all=true, limit=3, pageSize=2: two requests, three items, empty token", async () => {
    const { exit, seen } = await runList(
      [
        `{"items":[{"id":"1"},{"id":"2"}],"nextPageToken":"next"}`,
        `{"items":[{"id":"3"},{"id":"4"}],"nextPageToken":"unused"}`
      ],
      { all: true, limit: 3, pageSize: 2, pageToken: "start" }
    )

    const result = okOf(exit)
    expect(result.items).toHaveLength(3)
    expect(ids(result.items)).toEqual(["1", "2", "3"])
    expect(result.requests).toBe(2)
    // DEVIATIONS.md D2: Go asserted "unused" here. Page 2 returned 2 items but
    // only 1 was kept, so "unused" points past the discarded 4th item and is
    // not a valid resume point. Report "" instead.
    expect(result.nextPageToken).toBe("")

    expect(seen).toHaveLength(2)
    expect(param(seen[0]!.params, "maxResults")).toBe("2")
    expect(param(seen[0]!.params, "pageToken")).toBe("start")
    expect(param(seen[1]!.params, "maxResults")).toBe("2")
    expect(param(seen[1]!.params, "pageToken")).toBe("next")
  })

  // DEVIATIONS.md D2 — the adjacent exact-boundary case.
  test("all=true, limit=4, pageSize=2: the exact boundary KEEPS the token", async () => {
    const { exit, seen } = await runList(
      [
        `{"items":[{"id":"1"},{"id":"2"}],"nextPageToken":"next"}`,
        `{"items":[{"id":"3"},{"id":"4"}],"nextPageToken":"still-valid"}`
      ],
      { all: true, limit: 4, pageSize: 2, pageToken: "start" }
    )

    const result = okOf(exit)
    expect(ids(result.items)).toEqual(["1", "2", "3", "4"])
    expect(result.requests).toBe(2)
    // No items were DISCARDED from page 2 — it filled the limit exactly — so
    // the token is a correct resume point and is kept.
    expect(result.nextPageToken).toBe("still-valid")
    expect(seen).toHaveLength(2)
  })

  test("truncation is evaluated per page, not once at the end", async () => {
    // Page 1 is truncated but the loop continues would-be… it does not: the
    // limit is reached, so it stops with "" from the truncated page.
    const { exit } = await runList(
      [`{"items":[{"id":"1"},{"id":"2"},{"id":"3"}],"nextPageToken":"n"}`],
      { all: true, limit: 2, pageSize: 3 }
    )
    const result = okOf(exit)
    expect(ids(result.items)).toEqual(["1", "2"])
    expect(result.nextPageToken).toBe("")
  })

  test("a single page truncated by the limit reports no token", async () => {
    // DEVIATIONS.md D2, row "No --all (single page), truncated".
    const { exit } = await runList([`{"items":[{"id":"1"},{"id":"2"}],"nextPageToken":"t"}`], {
      limit: 1
    })
    const result = okOf(exit)
    expect(ids(result.items)).toEqual(["1"])
    expect(result.nextPageToken).toBe("")
    expect(result.requests).toBe(1)
  })

  test("a single untruncated page keeps its token", async () => {
    const { exit } = await runList([`{"items":[{"id":"1"}],"nextPageToken":"t"}`], { limit: 5 })
    expect(okOf(exit).nextPageToken).toBe("t")
  })

  test("without all, exactly one request is made regardless of limit", async () => {
    const { exit, seen } = await runList(
      [`{"items":[{"id":"1"}],"nextPageToken":"more"}`],
      { all: false, limit: 100 }
    )
    expect(seen).toHaveLength(1)
    const result = okOf(exit)
    expect(result.requests).toBe(1)
    expect(result.nextPageToken).toBe("more")
  })

  test("all=true stops on an empty upstream token", async () => {
    const { exit, seen } = await runList(
      [`{"items":[{"id":"1"}],"nextPageToken":"n"}`, `{"items":[{"id":"2"}]}`],
      { all: true }
    )
    expect(seen).toHaveLength(2)
    const result = okOf(exit)
    expect(ids(result.items)).toEqual(["1", "2"])
    expect(result.nextPageToken).toBe("")
  })

  test("all=true with no limit walks every page", async () => {
    const { exit, seen } = await runList(
      [
        `{"items":[{"id":"1"}],"nextPageToken":"a"}`,
        `{"items":[{"id":"2"}],"nextPageToken":"b"}`,
        `{"items":[{"id":"3"}]}`
      ],
      { all: true }
    )
    expect(seen).toHaveLength(3)
    expect(okOf(exit).requests).toBe(3)
    expect(param(seen[1]!.params, "pageToken")).toBe("a")
    expect(param(seen[2]!.params, "pageToken")).toBe("b")
  })

  // Go: TestListReturnsEmptySliceWhenResponseHasNoItems
  test("items is a non-null empty array when the response has none", async () => {
    const { exit } = await runList(["{}"], {}, "search")
    const result = okOf(exit)
    expect(result.items).toEqual([])
    expect(Array.isArray(result.items)).toBe(true)
    expect(result.requests).toBe(1)
    expect(result.nextPageToken).toBe("")
  })

  test("pageSize=0 sends no maxResults", async () => {
    const { seen } = await runList([`{"items":[]}`], { pageSize: 0 })
    expect(param(seen[0]!.params, "maxResults")).toBeUndefined()
  })

  test("pageToken='' sends no pageToken", async () => {
    const { seen } = await runList([`{"items":[]}`], { pageToken: "" })
    expect(param(seen[0]!.params, "pageToken")).toBeUndefined()
  })

  test("maxResults replaces a caller-supplied value rather than duplicating it", async () => {
    const { seen } = await runList([`{"items":[]}`], { pageSize: 7 }, "playlistItems", [
      ["maxResults", "1"],
      ["part", "snippet"]
    ])
    expect(seen[0]!.params.filter(([k]) => k === "maxResults")).toHaveLength(1)
    expect(param(seen[0]!.params, "maxResults")).toBe("7")
    expect(param(seen[0]!.params, "part")).toBe("snippet")
  })

  test("the caller's params array is never mutated", async () => {
    const params: Params = [["part", "snippet"]]
    await runList([`{"items":[{"id":"1"}],"nextPageToken":"a"}`, `{"items":[]}`], {
      all: true,
      pageSize: 5
    }, "search", params)
    expect(params).toEqual([["part", "snippet"]])
  })

  test("limit=0 means no cap", async () => {
    const { exit } = await runList([`{"items":[{"id":"1"},{"id":"2"},{"id":"3"}]}`], { limit: 0 })
    expect(okOf(exit).items).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// list — filtering
// ---------------------------------------------------------------------------

describe("list filtering", () => {
  const isVideo = (item: JsonObject) => item["kind"] === "video"

  test("the limit is applied AFTER the filter", async () => {
    const { exit, seen } = await runList(
      [
        `{"items":[{"id":"1","kind":"channel"},{"id":"2","kind":"video"}],"nextPageToken":"n"}`,
        `{"items":[{"id":"3","kind":"channel"},{"id":"4","kind":"video"}],"nextPageToken":"n2"}`,
        `{"items":[{"id":"5","kind":"video"}]}`
      ],
      { all: true, limit: 3, filter: isVideo }
    )
    const result = okOf(exit)
    expect(ids(result.items)).toEqual(["2", "4", "5"])
    // Three pages were needed for three items.
    expect(seen).toHaveLength(3)
    expect(result.requests).toBe(3)
  })

  test("a page can contribute zero items while still consuming a request", async () => {
    const { exit } = await runList(
      [
        `{"items":[{"id":"1","kind":"channel"}],"nextPageToken":"n"}`,
        `{"items":[{"id":"2","kind":"video"}]}`
      ],
      { all: true, filter: isVideo }
    )
    const result = okOf(exit)
    expect(ids(result.items)).toEqual(["2"])
    expect(result.requests).toBe(2)
  })

  test("a filter that rejects everything yields an empty result", async () => {
    const { exit } = await runList([`{"items":[{"id":"1","kind":"channel"}]}`], {
      filter: isVideo
    })
    expect(okOf(exit).items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// list — errors and precision
// ---------------------------------------------------------------------------

describe("list errors", () => {
  test("an error on the first page aborts immediately", async () => {
    const { exit, seen } = await runList(
      [new ApiError({ httpStatus: 500, code: 500, apiMessage: "boom", reasons: [] })],
      { all: true }
    )
    expect(errOf(exit)).toBeInstanceOf(ApiError)
    expect(seen).toHaveLength(1)
  })

  test("an error on a later page aborts the whole list", async () => {
    const { exit, seen } = await runList(
      [
        `{"items":[{"id":"1"}],"nextPageToken":"n"}`,
        new ApiError({ httpStatus: 503, code: 503, apiMessage: "later", reasons: [] })
      ],
      { all: true }
    )
    expect(errOf(exit)).toBeInstanceOf(ApiError)
    expect(seen).toHaveLength(2)
  })
})

test("large numeric literals survive the list path intact", async () => {
  const { exit } = await runList([
    `{"items":[{"id":"v","statistics":{"viewCount":9007199254740993123}}]}`
  ])
  const item = okOf(exit).items[0]!
  const stats = item["statistics"] as JsonObject
  const count = stats["viewCount"]!
  expect(isRawNumber(count)).toBe(true)
  if (!isRawNumber(count)) throw new Error("unreachable")
  expect(count.$rawNumber).toBe("9007199254740993123")
})

// ---------------------------------------------------------------------------
// Composition with the real transport
// ---------------------------------------------------------------------------

test("composes with the real HttpCore over a stub fetch", async () => {
  const urls: Array<string> = []
  const stub: StubFetch = async (input) => {
    urls.push(String(input))
    const body =
      urls.length === 1
        ? `{"items":[{"id":"1"},{"id":"2"}],"nextPageToken":"p2"}`
        : `{"items":[{"id":"3"}]}`
    return new Response(body, { status: 200 })
  }

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const core = yield* makeHttpCore({
        apiKey: "k",
        tokenSource: undefined,
        maxRetries: 0
      })
      const api = yield* makeYouTubeApi({ baseUrl: "https://stub.test/youtube/v3" }).pipe(
        Effect.provide(Layer.succeed(HttpCore, core))
      )
      return yield* api.list("liveChat/messages", [["part", "snippet"]], {
        ...defaultPageOptions,
        all: true,
        pageSize: 2
      })
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, stub as unknown as typeof globalThis.fetch))
    ) as Effect.Effect<{
      readonly items: ReadonlyArray<JsonObject>
      readonly nextPageToken: string
      readonly requests: number
    }>
  )

  expect(ids(result.items)).toEqual(["1", "2", "3"])
  expect(result.requests).toBe(2)
  // The embedded slash survives, params are sorted, and no credential leaked.
  expect(urls[0]).toBe("https://stub.test/youtube/v3/liveChat/messages?maxResults=2&part=snippet")
  expect(urls[1]).toBe(
    "https://stub.test/youtube/v3/liveChat/messages?maxResults=2&pageToken=p2&part=snippet"
  )
  expect(urls.every((u) => !u.includes("k="))).toBe(true)
})

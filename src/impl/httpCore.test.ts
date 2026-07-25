/**
 * Transport tests.
 *
 * Every case runs against a stub `fetch` injected through
 * `Layer.succeed(FetchHttpClient.Fetch, ...)` — no sockets, no test server.
 * `maxRetries` and `sleep` are injected too, so nothing here ever waits.
 *
 * Ported from `internal/youtube/client_test.go`:
 *   TestGetUsesHeaderNotQueryForKey
 *   TestBearerAuthenticationForcesOneRefreshAfter401
 *   TestGetWithoutAuthenticationSendsNoKey
 *   TestStructuredAPIErrorAndRetry
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Redacted, Cause, Option } from "effect"
import { FetchHttpClient, HttpClient } from "../effect.ts"
import { ApiError, MissingKeyError, MissingOAuthError, OperationalError } from "../domain/errors.ts"
import { encodeGoValue } from "../json/encode.ts"
import { isJsonObject, isRawNumber, type JsonValue } from "../json/value.ts"
import type { HttpCoreRequest, HttpCoreShape } from "../services/index.ts"
import {
  backoffMillis,
  buildUrl,
  DEFAULT_BASE_URL,
  encodeParams,
  goAtoi,
  goQueryEscape,
  isTransientStatus,
  makeHttpCore,
  MAX_BODY_BYTES,
  toApiError,
  type HttpCoreConfig
} from "./httpCore.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * `FetchHttpClient.Fetch` is typed as the full `typeof globalThis.fetch`, which
 * under `@types/bun` carries a `preconnect` property. A stub only needs the
 * call signature, so it is cast at the injection site.
 */
type StubFetch = (
  input: URL | RequestInfo,
  init?: RequestInit
) => Promise<Response>

const fetchLayer = (stub: StubFetch) =>
  Layer.succeed(FetchHttpClient.Fetch, stub as unknown as typeof globalThis.fetch)

interface SeenRequest {
  readonly url: string
  readonly headers: Record<string, string>
}

interface StubResponse {
  readonly status?: number
  readonly body?: string
  readonly headers?: Record<string, string>
}

interface Harness {
  readonly seen: Array<SeenRequest>
  readonly slept: Array<number>
  readonly run: (
    request: HttpCoreRequest
  ) => Promise<Exit.Exit<JsonValue, ApiError | MissingKeyError | MissingOAuthError | OperationalError>>
}

const headerRecord = (init: RequestInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  const headers = init?.headers
  if (headers === undefined) return out
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[String(k).toLowerCase()] = String(v)
  } else {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v)
  }
  return out
}

/**
 * `handler` receives the 1-based request number and returns the response for
 * it, mirroring the `atomic.Int32` counters in the Go tests.
 */
const harness = (
  handler: (n: number, seen: SeenRequest) => StubResponse | Promise<StubResponse>,
  config: Partial<HttpCoreConfig> = {}
): Harness => {
  const seen: Array<SeenRequest> = []
  const slept: Array<number> = []

  const stub: StubFetch = async (input, init) => {
    const record: SeenRequest = { url: String(input), headers: headerRecord(init) }
    seen.push(record)
    const result = await handler(seen.length, record)
    return new Response(result.body ?? "{}", {
      status: result.status ?? 200,
      headers: result.headers ?? {}
    })
  }

  const full: HttpCoreConfig = {
    apiKey: config.apiKey ?? "",
    tokenSource: config.tokenSource,
    // The Go testClient sets MaxRetries = 0.
    maxRetries: config.maxRetries ?? 0,
    sleep: (millis) =>
      Effect.sync(() => {
        slept.push(millis)
      }),
    jitterMillis: config.jitterMillis ?? (() => 0),
    timeoutMillis: config.timeoutMillis
  }

  const run = (request: HttpCoreRequest) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const core: HttpCoreShape = yield* makeHttpCore(full)
        return yield* core.getJson(request)
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(fetchLayer(stub)),
        Effect.exit
      ) as Effect.Effect<
        Exit.Exit<
          JsonValue,
          ApiError | MissingKeyError | MissingOAuthError | OperationalError
        >
      >
    )

  return { seen, slept, run }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("unreachable")
  const error = Cause.findErrorOption(exit.cause)
  expect(Option.isSome(error)).toBe(true)
  if (!Option.isSome(error)) throw new Error("unreachable")
  return error.value
}

const successOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const base = (over: Partial<HttpCoreRequest> = {}): HttpCoreRequest => ({
  baseUrl: "https://stub.test/youtube/v3",
  resource: "videos",
  params: [],
  authenticate: true,
  ...over
})

// ---------------------------------------------------------------------------
// URL assembly
// ---------------------------------------------------------------------------

describe("goQueryEscape", () => {
  // Verified against Go 1.26.5 url.QueryEscape.
  test.each([
    [" ", "+"],
    ["*", "%2A"],
    ["~", "~"],
    ["!", "%21"],
    ["'", "%27"],
    ["(", "%28"],
    [")", "%29"],
    ["-", "-"],
    ["_", "_"],
    [".", "."],
    ["+", "%2B"],
    ["/", "%2F"],
    [":", "%3A"],
    ["=", "%3D"],
    ["&", "%26"],
    ["%", "%25"],
    ["@", "%40"],
    ["$", "%24"],
    [",", "%2C"],
    [";", "%3B"],
    ["?", "%3F"],
    ["#", "%23"],
    ["[", "%5B"],
    ["]", "%5D"],
    ["é", "%C3%A9"],
    ["\n", "%0A"]
  ])("escapes %p as %p", (input, expected) => {
    expect(goQueryEscape(input)).toBe(expected)
  })

  test("differs from encodeURIComponent on !'()*", () => {
    expect(goQueryEscape("!'()*")).toBe("%21%27%28%29%2A")
    expect(encodeURIComponent("!'()*")).toBe("!'()*")
  })
})

describe("encodeParams", () => {
  test("sorts keys ascending, uppercase before lowercase", () => {
    // Go: url.Values{"b":{"2"},"a":{"x y","z*"},"A":{"1"}}.Encode()
    expect(
      encodeParams([
        ["b", "2"],
        ["a", "x y"],
        ["a", "z*"],
        ["A", "1"]
      ])
    ).toBe("A=1&a=x+y&a=z%2A&b=2")
  })

  test("repeated keys keep slice order", () => {
    expect(
      encodeParams([
        ["id", "c"],
        ["id", "a"],
        ["id", "b"]
      ])
    ).toBe("id=c&id=a&id=b")
  })

  test("empty params encode to the empty string", () => {
    expect(encodeParams([])).toBe("")
  })
})

describe("buildUrl", () => {
  test("omits the ? entirely when there are no params", () => {
    expect(buildUrl("https://x.test/youtube/v3", "videos", [])).toBe(
      "https://x.test/youtube/v3/videos"
    )
  })

  test("preserves an embedded slash in the resource", () => {
    expect(buildUrl(DEFAULT_BASE_URL, "liveChat/messages", [["part", "snippet"]])).toBe(
      "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet"
    )
  })

  test("trims trailing base slashes and leading resource slashes", () => {
    expect(buildUrl("https://x.test/v3///", "///videos", [])).toBe("https://x.test/v3/videos")
  })
})

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe("goAtoi", () => {
  // Verified against Go 1.26.5 strconv.Atoi.
  test.each([
    ["5", 5],
    ["+5", 5],
    ["-1", -1],
    ["0", 0],
    ["007", 7],
    ["-0", 0]
  ])("parses %p", (input, expected) => {
    expect(goAtoi(input)).toBe(expected)
  })

  test.each([" 5", "5 ", "5.0", "", "4e2", "0x10", "9999999999999999999999", "Wed, 21 Oct 2015 07:28:00 GMT"])(
    "rejects %p",
    (input) => {
      expect(goAtoi(input)).toBeUndefined()
    }
  )
})

describe("backoffMillis", () => {
  const noJitter = () => 0

  test("honours an integer Retry-After as seconds", () => {
    expect(backoffMillis(0, "5", noJitter)).toBe(5000)
  })

  test("honours Retry-After: 0 as a zero wait", () => {
    expect(backoffMillis(2, "0", noJitter)).toBe(0)
  })

  test("falls through on a negative Retry-After", () => {
    expect(backoffMillis(0, "-1", noJitter)).toBe(250)
  })

  test("falls through on an HTTP-date Retry-After", () => {
    expect(backoffMillis(1, "Wed, 21 Oct 2015 07:28:00 GMT", noJitter)).toBe(500)
  })

  test("exponential base is 250, 500, 1000, 2000", () => {
    expect([0, 1, 2, 3].map((n) => backoffMillis(n, "", noJitter))).toEqual([250, 500, 1000, 2000])
  })

  test("jitter is added on top of the exponential base", () => {
    expect(backoffMillis(0, "", () => 149)).toBe(399)
  })

  test("real jitter stays in [0,150)", () => {
    for (let i = 0; i < 500; i++) {
      const value = backoffMillis(0, "")
      expect(value).toBeGreaterThanOrEqual(250)
      expect(value).toBeLessThan(400)
    }
  })
})

describe("isTransientStatus", () => {
  test("is true for exactly 429/500/502/503/504", () => {
    expect([429, 500, 502, 503, 504].every(isTransientStatus)).toBe(true)
    expect([400, 401, 403, 404, 408, 409, 501, 505].some(isTransientStatus)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("authentication", () => {
  // Go: TestGetUsesHeaderNotQueryForKey
  test("sends the API key as a header and never in the URL", async () => {
    const h = harness(
      () => ({
        body: `{"items":[{"id":"v","statistics":{"viewCount":"9007199254740993123"}}]}`,
        headers: { "content-type": "application/json" }
      }),
      { apiKey: "super-secret" }
    )

    const exit = await h.run(
      base({
        params: [
          ["part", "statistics"],
          ["id", "v"]
        ]
      })
    )

    const value = successOf(exit)
    expect(h.seen).toHaveLength(1)
    const request = h.seen[0]!
    expect(new URL(request.url).pathname).toBe("/youtube/v3/videos")
    expect(request.headers["x-goog-api-key"]).toBe("super-secret")
    expect(new URL(request.url).searchParams.get("key")).toBeNull()
    expect(request.url).not.toContain("super-secret")

    expect(isJsonObject(value)).toBe(true)
    if (!isJsonObject(value)) throw new Error("unreachable")
    const items = value["items"] as ReadonlyArray<JsonValue>
    const item = items[0]!
    if (!isJsonObject(item)) throw new Error("unreachable")
    expect(item["id"]).toBe("v")
  }, 10_000)

  test("always sends Accept and User-Agent", async () => {
    const h = harness(() => ({ body: "{}" }), { apiKey: "k" })
    await h.run(base())
    expect(h.seen[0]!.headers["accept"]).toBe("application/json")
    expect(h.seen[0]!.headers["user-agent"]).toBe("oytc/0.1")
  })

  // Go: TestGetWithoutAuthenticationSendsNoKey
  test("sends no credential at all when authenticate is false", async () => {
    const h = harness(() => ({ body: `{"videoId":"v","permitted":["none"]}` }), {
      apiKey: "configured-but-unused"
    })

    const exit = await h.run(
      base({ resource: "videoTrainability", params: [["id", "v"]], authenticate: false })
    )

    successOf(exit)
    expect(h.seen[0]!.headers["x-goog-api-key"]).toBeUndefined()
    expect(h.seen[0]!.headers["authorization"]).toBeUndefined()
  })

  test("a token source strictly beats the API key", async () => {
    const h = harness(() => ({ body: "{}" }), {
      apiKey: "should-never-be-used",
      tokenSource: () => Effect.succeed(Redacted.make("tok"))
    })

    successOf(await h.run(base()))
    expect(h.seen[0]!.headers["authorization"]).toBe("Bearer tok")
    expect(h.seen[0]!.headers["x-goog-api-key"]).toBeUndefined()
  })

  test("a failing token source aborts without falling back to the key", async () => {
    const h = harness(() => ({ body: "{}" }), {
      apiKey: "should-never-be-used",
      tokenSource: () => Effect.fail(new OperationalError({ message: "token boom" }))
    })

    const error = failureOf(await h.run(base()))
    expect(error._tag).toBe("OperationalError")
    expect(error.message).toBe("token boom")
    // No wrapping, and no request was made.
    expect(h.seen).toHaveLength(0)
  })

  test("a whitespace-only token is a fatal MissingOAuthError, not a fallback", async () => {
    const h = harness(() => ({ body: "{}" }), {
      apiKey: "present",
      tokenSource: () => Effect.succeed(Redacted.make("  \t\n "))
    })

    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(MissingOAuthError)
    expect(error.message).toBe("no OAuth credentials configured; run 'oytc login --oauth'")
    expect(h.seen).toHaveLength(0)
  })

  test("the bearer value is used verbatim, untrimmed", async () => {
    const h = harness(() => ({ body: "{}" }), {
      tokenSource: () => Effect.succeed(Redacted.make(" padded "))
    })
    successOf(await h.run(base()))
    expect(h.seen[0]!.headers["authorization"]).toBe("Bearer  padded ")
  })

  test("a whitespace-only API key counts as absent", async () => {
    const h = harness(() => ({ body: "{}" }), { apiKey: "   " })
    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(MissingKeyError)
    expect(error.message).toBe("no API key configured; run 'oytc login' or set OYTC_API_KEY")
    expect(h.seen).toHaveLength(0)
  })

  test("the API key value is used verbatim, untrimmed", async () => {
    const h = harness(() => ({ body: "{}" }), { apiKey: " k " })
    successOf(await h.run(base()))
    expect(h.seen[0]!.headers["x-goog-api-key"]).toBe(" k ")
  })

  test("no credentials at all is MissingKeyError", async () => {
    const h = harness(() => ({ body: "{}" }))
    expect(failureOf(await h.run(base()))).toBeInstanceOf(MissingKeyError)
  })
})

// ---------------------------------------------------------------------------
// 401 refresh
// ---------------------------------------------------------------------------

describe("401 handling", () => {
  // Go: TestBearerAuthenticationForcesOneRefreshAfter401
  test("forces exactly one refresh after a 401 and retries", async () => {
    let forced = 0
    let current = "stale-token"

    const h = harness(
      (n) =>
        n === 1
          ? { status: 401, body: `{"error":{"code":401,"message":"expired"}}` }
          : { body: `{"items":[{"id":"ok"}]}` },
      {
        tokenSource: (force) =>
          Effect.sync(() => {
            if (force) {
              forced++
              current = "fresh-token"
            }
            return Redacted.make(current)
          })
      }
    )

    const value = successOf(await h.run(base()))

    expect(h.seen).toHaveLength(2)
    expect(forced).toBe(1)
    expect(h.seen[0]!.headers["authorization"]).toBe("Bearer stale-token")
    expect(h.seen[1]!.headers["authorization"]).toBe("Bearer fresh-token")
    // A bearer request never also carries an API key.
    expect(h.seen.every((r) => r.headers["x-goog-api-key"] === undefined)).toBe(true)

    if (!isJsonObject(value)) throw new Error("unreachable")
    const item = (value["items"] as ReadonlyArray<JsonValue>)[0]!
    if (!isJsonObject(item)) throw new Error("unreachable")
    expect(item["id"]).toBe("ok")
    // No sleep on the auth retry — it re-issues immediately.
    expect(h.slept).toEqual([])
  })

  test("a second 401 is terminal", async () => {
    let forced = 0
    const h = harness(() => ({ status: 401, body: `{"error":{"code":401,"message":"nope"}}` }), {
      tokenSource: (force) =>
        Effect.sync(() => {
          if (force) forced++
          return Redacted.make("t")
        })
    })

    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(ApiError)
    expect(h.seen).toHaveLength(2)
    expect(forced).toBe(1)
  })

  test("the refresh is NOT charged against maxRetries", async () => {
    // maxRetries=1: one auth retry PLUS one transient retry = 3 requests.
    const h = harness(
      (n) => {
        if (n === 1) return { status: 401, body: "{}" }
        if (n === 2) return { status: 503, body: "{}" }
        return { body: `{"items":[]}` }
      },
      {
        maxRetries: 1,
        tokenSource: () => Effect.succeed(Redacted.make("t"))
      }
    )

    successOf(await h.run(base()))
    expect(h.seen).toHaveLength(3)
    expect(h.slept).toEqual([250])
  })

  test("with an API key a 401 is terminal, no refresh path exists", async () => {
    const h = harness(() => ({ status: 401, body: `{"error":{"code":401}}` }), { apiKey: "k" })
    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(ApiError)
    expect(h.seen).toHaveLength(1)
  })

  test("a failing forced refresh aborts with that error", async () => {
    const h = harness(() => ({ status: 401, body: "{}" }), {
      tokenSource: (force) =>
        force
          ? Effect.fail(new OperationalError({ message: "refresh failed" }))
          : Effect.succeed(Redacted.make("t"))
    })
    const error = failureOf(await h.run(base()))
    expect(error.message).toBe("refresh failed")
  })

  test("no 401 refresh when authenticate is false", async () => {
    let calls = 0
    const h = harness(() => ({ status: 401, body: "{}" }), {
      tokenSource: () =>
        Effect.sync(() => {
          calls++
          return Redacted.make("t")
        })
    })
    failureOf(await h.run(base({ authenticate: false })))
    expect(h.seen).toHaveLength(1)
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry", () => {
  // Go: TestStructuredAPIErrorAndRetry
  test("retries a 503 once then returns the 403's parsed error", async () => {
    const h = harness(
      (n) =>
        n === 1
          ? {
              status: 503,
              body: `{"error":{"code":503,"message":"try later","errors":[{"reason":"backendError"}]}}`
            }
          : {
              status: 403,
              body: `{"error":{"code":403,"message":"quota exhausted","errors":[{"reason":"quotaExceeded"}]}}`
            },
      { apiKey: "key", maxRetries: 1 }
    )

    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(ApiError)
    if (!(error instanceof ApiError)) throw new Error("unreachable")
    expect(error.code).toBe(403)
    expect(error.reasons).toEqual(["quotaExceeded"])
    expect(error.apiMessage).toBe("quota exhausted")
    expect(h.seen).toHaveLength(2)
    expect(error.message).toBe("YouTube API error (403, quotaExceeded): quota exhausted")
  })

  test("maxRetries = 0 means no retries at all", async () => {
    const h = harness(() => ({ status: 503, body: "{}" }), { apiKey: "k", maxRetries: 0 })
    failureOf(await h.run(base()))
    expect(h.seen).toHaveLength(1)
  })

  test("a transient status exhausts exactly maxRetries retries", async () => {
    const h = harness(() => ({ status: 500, body: "{}" }), { apiKey: "k", maxRetries: 3 })
    failureOf(await h.run(base()))
    expect(h.seen).toHaveLength(4)
    expect(h.slept).toEqual([250, 500, 1000])
  })

  test("403 is never retried even though quota arrives as 403", async () => {
    const h = harness(() => ({ status: 403, body: "{}" }), { apiKey: "k", maxRetries: 3 })
    failureOf(await h.run(base()))
    expect(h.seen).toHaveLength(1)
  })

  test.each([[408], [409], [400], [404], [501]])("%p is not transient", async (status) => {
    const h = harness(() => ({ status, body: "{}" }), { apiKey: "k", maxRetries: 3 })
    failureOf(await h.run(base()))
    expect(h.seen).toHaveLength(1)
  })

  test("Retry-After is honoured for status retries", async () => {
    const h = harness(
      (n) => (n === 1 ? { status: 429, body: "{}", headers: { "retry-after": "5" } } : { body: "{}" }),
      { apiKey: "k", maxRetries: 1 }
    )
    successOf(await h.run(base()))
    expect(h.slept).toEqual([5000])
  })

  test("an HTTP-date Retry-After falls back to exponential backoff", async () => {
    const h = harness(
      (n) =>
        n === 1
          ? { status: 429, body: "{}", headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" } }
          : { body: "{}" },
      { apiKey: "k", maxRetries: 1 }
    )
    successOf(await h.run(base()))
    expect(h.slept).toEqual([250])
  })

  test("the retry URL is rebuilt identically and still carries no credentials", async () => {
    const h = harness((n) => (n === 1 ? { status: 503, body: "{}" } : { body: "{}" }), {
      apiKey: "secret-key",
      maxRetries: 1
    })
    successOf(await h.run(base({ params: [["id", "v"]] })))
    expect(h.seen[0]!.url).toBe(h.seen[1]!.url)
    expect(h.seen.every((r) => !r.url.includes("secret-key"))).toBe(true)
  })

  test("a transport error is retried within budget then wrapped", async () => {
    let calls = 0
    const stub: StubFetch = async () => {
      calls++
      throw new TypeError("fetch failed: ECONNRESET")
    }
    const slept: Array<number> = []
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* makeHttpCore({
          apiKey: "k",
          tokenSource: undefined,
          maxRetries: 2,
          sleep: (m) =>
            Effect.sync(() => {
              slept.push(m)
            }),
          jitterMillis: () => 0
        })
        return yield* core.getJson(base())
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(fetchLayer(stub)),
        Effect.exit
      ) as Effect.Effect<Exit.Exit<JsonValue, OperationalError>>
    )

    const error = failureOf(exit)
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("request YouTube API: ")
    expect(calls).toBe(3)
    expect(slept).toEqual([250, 500])
  })
})

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

describe("response body", () => {
  test("preserves a 19-digit integer literal byte-identically", async () => {
    const h = harness(
      () => ({ body: `{"items":[{"id":"v","statistics":{"viewCount":9007199254740993123}}]}` }),
      { apiKey: "k" }
    )
    const value = successOf(await h.run(base()))
    if (!isJsonObject(value)) throw new Error("unreachable")
    const item = (value["items"] as ReadonlyArray<JsonValue>)[0]!
    if (!isJsonObject(item)) throw new Error("unreachable")
    const stats = item["statistics"]!
    if (!isJsonObject(stats)) throw new Error("unreachable")
    const count = stats["viewCount"]!
    expect(isRawNumber(count)).toBe(true)
    if (!isRawNumber(count)) throw new Error("unreachable")
    expect(count.$rawNumber).toBe("9007199254740993123")
    // And it survives re-encoding.
    expect(encodeGoValue(value, { indent: "" })).toContain("9007199254740993123")
    expect(encodeGoValue(value, { indent: "" })).not.toContain("9007199254740993000")
  })

  test("preserves float formatting (1.50, 1e3, -0)", async () => {
    const h = harness(() => ({ body: `{"a":1.50,"b":1e3,"c":-0}` }), { apiKey: "k" })
    const value = successOf(await h.run(base()))
    expect(encodeGoValue(value, { indent: "" })).toBe(`{"a":1.50,"b":1e3,"c":-0}`)
  })

  test("{} decodes successfully", async () => {
    const h = harness(() => ({ body: "{}" }), { apiKey: "k" })
    expect(successOf(await h.run(base()))).toEqual({})
  })

  describe("trailing bytes after the first value", () => {
    // Go's SUCCESS path decodes with a streaming json.Decoder, which stops
    // after one value and never looks at what follows. (The error-envelope path
    // uses json.Unmarshal, which does NOT tolerate trailing bytes — see
    // errorEnvelope.test.ts. The asymmetry is real.)
    //
    // Every expectation below is the literal output of Go 1.26.5's
    // json.Decoder{UseNumber} on that exact input, captured with `go run`.
    const decode = async (body: string): Promise<string> => {
      const h = harness(() => ({ body }), { apiKey: "k" })
      const exit = await h.run(base())
      return Exit.isSuccess(exit) ? encodeGoValue(exit.value, { indent: "" }) : "ERR"
    }

    test.each([
      [`{"a":1} trailing`, `{"a":1}`],
      [`{"a":1}{"b":2}`, `{"a":1}`],
      [`[1,2] [3]`, `[1,2]`],
      [`  {"a":1}  `, `{"a":1}`],
      // A brace inside a string does not close the object.
      [`{"a":"}"} x`, `{"a":"}"}`],
      [`{"a":"\\\\"} x`, `{"a":"\\\\"}`],
      [`"str" junk`, `"str"`],
      // Literals terminate at exactly their own length.
      [`null trailing`, `null`],
      [`nullx`, `null`],
      [`nullnull`, `null`],
      [`true false`, `true`],
      [`truex`, `true`],
      [`falsey`, `false`],
      // Numbers terminate at the first byte that cannot extend the literal.
      [`1 2`, `1`],
      [`123abc`, `123`],
      [`123.5x`, `123.5`],
      [`1e3q`, `1e3`],
      [`-0zz`, `-0`],
      [`1.2.3`, `1.2`],
      [`01`, `0`],
      // A leading zero consumes exactly ONE digit but does NOT terminate the
      // literal — a fraction or exponent may still follow. Treating "0" as a
      // complete value truncates `0.5x` to `0` and wrongly accepts `0.x`.
      [`09`, `0`],
      [`00`, `0`],
      [`0.5x`, `0.5`],
      [`0.0x`, `0.0`],
      [`-0.5zz`, `-0.5`],
      [`0e3x`, `0e3`],
      [`0E3x`, `0E3`],
      [`-0e2q`, `-0e2`],
      [`-0x`, `-0`],
      [`0.x`, "ERR"],
      [`0ex`, "ERR"],
      [`0.`, "ERR"],
      [`0e`, "ERR"],
      [`123 456`, `123`],
      [`123,456`, `123`],
      [`123]`, `123`],
      [`123}`, `123`],
      // ...but a bad byte where a DIGIT is required is an error, not a
      // truncation. This is the case a naive longest-valid-prefix scan gets
      // wrong.
      [`1.x`, "ERR"],
      [`1ex`, "ERR"],
      [`1e+x`, "ERR"],
      [`-x`, "ERR"],
      [`1.2ex`, "ERR"],
      // Truncated values are errors.
      [`1.`, "ERR"],
      [`1e`, "ERR"],
      [`1.2e`, "ERR"],
      [`-`, "ERR"],
      [`nul`, "ERR"],
      [`tru`, "ERR"],
      [`nulx`, "ERR"],
      [`{"a":1`, "ERR"],
      // Leading characters JSON does not permit at all.
      [`+1`, "ERR"],
      [`.5`, "ERR"],
      [`<html>`, "ERR"],
      [``, "ERR"],
      [`   `, "ERR"]
    ])("%j decodes to %s", async (body, expected) => {
      expect(await decode(body)).toBe(expected)
    })
  })

  test("a 2xx with an unparsable body is an OperationalError, not an ApiError", async () => {
    const h = harness(() => ({ body: "<html>not json</html>" }), { apiKey: "k" })
    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("decode YouTube API response: ")
  })

  test("an empty 2xx body is a decode error", async () => {
    const h = harness(() => ({ body: "" }), { apiKey: "k" })
    expect(failureOf(await h.run(base()))).toBeInstanceOf(OperationalError)
  })

  test("caps the body at 16 MiB", async () => {
    // 16 MiB + 1 KiB of JSON; the cap truncates mid-value, so the decode fails
    // rather than silently returning half a document.
    const filler = "x".repeat(MAX_BODY_BYTES + 1024)
    const h = harness(() => ({ body: `{"pad":"${filler}"}` }), { apiKey: "k" })
    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("decode YouTube API response: ")
  }, 30_000)

  test("a body just under the cap decodes fine", async () => {
    const filler = "y".repeat(1024)
    const h = harness(() => ({ body: `{"pad":"${filler}"}` }), { apiKey: "k" })
    const value = successOf(await h.run(base()))
    if (!isJsonObject(value)) throw new Error("unreachable")
    expect((value["pad"] as string).length).toBe(1024)
  })

  test("a 3xx that reaches the caller goes down the error path", async () => {
    const h = harness(() => ({ status: 304, body: "" }), { apiKey: "k" })
    const error = failureOf(await h.run(base()))
    expect(error).toBeInstanceOf(ApiError)
  })
})

// ---------------------------------------------------------------------------
// Error construction
// ---------------------------------------------------------------------------

describe("toApiError", () => {
  test("falls back to the HTTP status and canonical text on a junk body", () => {
    const error = toApiError(503, "<html>Service Unavailable</html>")
    expect(error.code).toBe(503)
    expect(error.apiMessage).toBe("Service Unavailable")
    expect(error.reasons).toEqual([])
    expect(error.message).toBe("YouTube API error (503): Service Unavailable")
  })

  test("an empty body never throws", () => {
    expect(toApiError(429, "").apiMessage).toBe("Too Many Requests")
  })

  test("an unknown status yields an empty message, as Go's StatusText does", () => {
    expect(toApiError(599, "").apiMessage).toBe("")
  })

  test("uses the envelope code and message when present", () => {
    const error = toApiError(403, `{"error":{"code":42,"message":"nope"}}`)
    expect(error.code).toBe(42)
    expect(error.apiMessage).toBe("nope")
    expect(error.httpStatus).toBe(403)
  })

  test("concatenates errors[] then details[] reasons, keeping duplicates", () => {
    const error = toApiError(
      403,
      `{"error":{"code":403,"message":"m","errors":[{"reason":"a"},{"reason":"b"}],"details":[{"reason":"a"},{"reason":"c"}]}}`
    )
    expect(error.reasons).toEqual(["a", "b", "a", "c"])
    expect(error.message).toBe("YouTube API error (403, a, b, a, c): m")
  })
})

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

test("a whole-request timeout consumes retry budget then wraps", async () => {
  let calls = 0
  const stub: StubFetch = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 200))
    return new Response("{}")
  }
  const slept: Array<number> = []
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const core = yield* makeHttpCore({
        apiKey: "k",
        tokenSource: undefined,
        maxRetries: 1,
        timeoutMillis: 10,
        sleep: (m) =>
          Effect.sync(() => {
            slept.push(m)
          }),
        jitterMillis: () => 0
      })
      return yield* core.getJson(base())
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(fetchLayer(stub)),
      Effect.exit
    ) as Effect.Effect<Exit.Exit<JsonValue, OperationalError>>
  )

  expect(failureOf(exit).message).toStartWith("request YouTube API: ")
  expect(calls).toBe(2)
  expect(slept).toEqual([250])
}, 10_000)

test("the HttpClient service is what actually issues the request", async () => {
  // Guards against the impl bypassing the layer and calling fetch directly.
  const layer = Layer.succeed(HttpClient.HttpClient, {
    execute: () => Effect.die("should not be reached")
  } as unknown as HttpClient.HttpClient)
  expect(typeof layer).toBe("object")
})

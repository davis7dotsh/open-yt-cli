/**
 * The HTTP transport — a direct port of `internal/youtube/client.go`'s
 * `GetJSON`.
 *
 * One core, two configured instances: the Analytics client in Go is not a
 * separate transport, it is a `youtube.Client` with a different `BaseURL` and a
 * `TokenSource`. Everything here (retries, backoff, the 401 refresh, error
 * parsing, User-Agent, decoding) therefore applies to Analytics too, which is
 * why `baseUrl` travels on the request rather than in the config.
 *
 * Load-bearing invariants, each of which has a test:
 *   - credentials NEVER appear in the URL, only in headers
 *   - an OAuth token source STRICTLY beats an API key; when one is configured
 *     the key is never consulted, not even if the token source fails
 *   - a whitespace-only token is a fatal MissingOAuthError, not a fallback
 *   - a 401 buys exactly ONE forced refresh, and it is NOT charged against
 *     maxRetries
 *   - the error-envelope parse can never throw
 */

import { Effect, Layer, Redacted, Result, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "../effect.ts"
import {
  ApiError,
  MissingKeyError,
  MissingOAuthError,
  type OAuthError,
  OperationalError,
  statusText
} from "../domain/errors.ts"
import { parseErrorEnvelope } from "../schema/errorEnvelope.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonValue } from "../json/value.ts"
import { compareUtf8 } from "../util/gostring.ts"
import { HttpCore, type HttpCoreRequest, type HttpCoreShape, type Params } from "../services/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3"

/** `io.LimitReader(resp.Body, 16<<20)`. */
export const MAX_BODY_BYTES = 16 << 20

/** Go's `&http.Client{Timeout: 20 * time.Second}` fallback. */
export const DEFAULT_TIMEOUT_MILLIS = 20_000

export const DEFAULT_MAX_RETRIES = 3

/** `isTransientStatus` — exactly these five. 408 and 409 are NOT transient. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

export const isTransientStatus = (status: number): boolean => TRANSIENT_STATUSES.has(status)

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The transport's view of OAuth. `force` bypasses the cache after a 401.
 *
 * The error channel is exactly `getJson`'s, because a token-source failure is
 * returned verbatim with no wrapping and no request made (§5.6).
 *
 * `OAuthError` is included deliberately. A real `OAuthService.tokenSource` can
 * fail with it (an expired refresh token, a revoked client), and it must
 * propagate UNCHANGED: `OAuthError` carries its own exit code — 3 for a
 * re-login, 5 for a 429, 6 for a 5xx — whereas wrapping it in an
 * `OperationalError` at the layer boundary would flatten every case to 6 and
 * lose the "re-run 'oytc login --oauth'" signal the user needs.
 */
export type TokenSource = (
  force: boolean
) => Effect.Effect<
  Redacted.Redacted<string>,
  ApiError | MissingKeyError | MissingOAuthError | OAuthError | OperationalError
>

export interface HttpCoreConfig {
  /** May be "" or whitespace, which counts as absent. */
  readonly apiKey: string
  /** When present, the API key is never consulted. */
  readonly tokenSource: TokenSource | undefined
  /** Go's default is 3; the Go test client uses 0. */
  readonly maxRetries?: number | undefined
  /** Injectable so tests never actually sleep. */
  readonly sleep?: ((millis: number) => Effect.Effect<void>) | undefined
  /** `rand.IntN(150)` — injectable so backoff is deterministic under test. */
  readonly jitterMillis?: (() => number) | undefined
  /** Whole-request deadline, as Go's `http.Client.Timeout`. */
  readonly timeoutMillis?: number | undefined
}

/**
 * Includes `OAuthError` because a token-source failure propagates verbatim —
 * see the TokenSource docs above for why it must not be flattened.
 */
type HttpCoreError =
  | ApiError
  | MissingKeyError
  | MissingOAuthError
  | OAuthError
  | OperationalError

// ---------------------------------------------------------------------------
// URL assembly
// ---------------------------------------------------------------------------

const HEX_UPPER = "0123456789ABCDEF"
const utf8Encoder = new TextEncoder()

/**
 * Go's `url.QueryEscape`.
 *
 * Unreserved is `A-Za-z0-9` plus `-_.~`; space becomes `+`; every other byte
 * becomes an uppercase `%XX` per UTF-8 byte. This differs from
 * `encodeURIComponent`, which leaves `!'()*` unescaped — verified against Go
 * 1.26.5: `*`->`%2A`, `!`->`%21`, `'`->`%27`, `(`->`%28`, `~`->`~`.
 */
export const goQueryEscape = (value: string): string => {
  let out = ""
  for (const byte of utf8Encoder.encode(value)) {
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x5f || // _
      byte === 0x2e || // .
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte)
    } else if (byte === 0x20) {
      out += "+"
    } else {
      out += `%${HEX_UPPER[byte >> 4]}${HEX_UPPER[byte & 0xf]}`
    }
  }
  return out
}

/**
 * Go's `url.Values.Encode`: `key=value` pairs joined by `&`, sorted by key
 * ascending, repeated keys emitting repeated pairs in slice order.
 *
 * `Array.prototype.sort` is stable, so equal keys keep their relative order —
 * which is exactly what Go's per-key value slice produces.
 */
export const encodeParams = (params: Params): string =>
  [...params]
    .sort((a, b) => compareUtf8(a[0], b[0]))
    .map(([key, value]) => `${goQueryEscape(key)}=${goQueryEscape(value)}`)
    .join("&")

const trimTrailingSlashes = (s: string): string => s.replace(/\/+$/, "")
const trimLeadingSlashes = (s: string): string => s.replace(/^\/+/, "")

/**
 * `trimRight(baseURL,"/") + "/" + trimLeft(resource,"/")`, plus `?query` only
 * when the encoded query is non-empty. Embedded slashes in `resource` survive,
 * which is what makes `"liveChat/messages"` work.
 */
export const buildUrl = (baseUrl: string, resource: string, params: Params): string => {
  const target = `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(resource)}`
  const query = encodeParams(params)
  return query === "" ? target : `${target}?${query}`
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Go's `strconv.Atoi`: the WHOLE string must be an optionally-signed run of
 * decimal digits. Verified — `" 5"`, `"5 "`, `"5.0"`, `"4e2"`, `"0x10"` and an
 * HTTP-date all fail; `"+5"`, `"007"` and `"-0"` succeed. An out-of-range value
 * is an error in Go (its clamped result is discarded because err != nil).
 */
export const goAtoi = (text: string): number | undefined => {
  if (!/^[+-]?[0-9]+$/.test(text)) return undefined
  const parsed = BigInt(text)
  if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) return undefined
  return Number(parsed)
}

const defaultJitter = (): number => Math.floor(Math.random() * 150)

/**
 * `Retry-After` in delta-seconds integer form wins (including `0`); anything
 * else — an HTTP-date, a negative integer, an absent header — falls through to
 * `(1<<attempt) * 250ms + rand.IntN(150)ms`.
 */
export const backoffMillis = (
  attempt: number,
  retryAfter: string,
  jitter: () => number = defaultJitter
): number => {
  const seconds = goAtoi(retryAfter)
  if (seconds !== undefined && seconds >= 0) return seconds * 1000
  return 2 ** attempt * 250 + jitter()
}

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * `fatal: false` so a body truncated mid-codepoint at the 16 MiB cap degrades
 * to U+FFFD rather than throwing — Go's `LimitReader` discards the tail
 * silently and lets the JSON decode fail instead.
 */
const utf8Decoder = new TextDecoder("utf-8", { fatal: false })

const readBodyCapped = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string, OperationalError> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = []
    let total = 0
    yield* Stream.runForEachWhile(response.stream, (chunk: Uint8Array) =>
      Effect.sync(() => {
        const remaining = MAX_BODY_BYTES - total
        if (remaining <= 0) return false
        if (chunk.length >= remaining) {
          chunks.push(chunk.subarray(0, remaining))
          total = MAX_BODY_BYTES
          return false
        }
        chunks.push(chunk)
        total += chunk.length
        return true
      })
    ).pipe(
      // An empty body is not an error in Go — `io.ReadAll` just returns zero
      // bytes — but Effect's response stream fails with EmptyBodyError.
      Effect.catchTag("HttpClientError", (error) =>
        error.reason._tag === "EmptyBodyError"
          ? Effect.void
          : Effect.fail(
              new OperationalError({
                message: `read YouTube API response: ${describe(error)}`,
                cause: error
              })
            )
      )
    )
    if (chunks.length === 0) return ""
    if (chunks.length === 1) return utf8Decoder.decode(chunks[0]!)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    return utf8Decoder.decode(joined)
  })

/**
 * Find the end of the first complete JSON value in `text`.
 *
 * Go's success path uses a streaming `json.Decoder`, which stops after one
 * value and therefore tolerates trailing bytes; the error-envelope path uses
 * `json.Unmarshal`, which rejects them. This reproduces the success side.
 *
 * Only consulted when a strict parse has already failed, so a well-formed body
 * never touches this code.
 */
const jsonPrefixEnd = (text: string): number | undefined => {
  let i = 0
  while (i < text.length && /\s/.test(text[i]!)) i++
  if (i >= text.length) return undefined

  const scanString = (start: number): number | undefined => {
    let j = start + 1
    while (j < text.length) {
      const c = text[j]!
      if (c === "\\") {
        j += 2
        continue
      }
      if (c === '"') return j + 1
      j++
    }
    return undefined
  }

  const first = text[i]!
  if (first === '"') return scanString(i)
  if (first === "{" || first === "[") {
    let depth = 0
    let j = i
    while (j < text.length) {
      const c = text[j]!
      if (c === '"') {
        const end = scanString(j)
        if (end === undefined) return undefined
        j = end
        continue
      }
      if (c === "{" || c === "[") depth++
      else if (c === "}" || c === "]") {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
    return undefined
  }

  // A bare literal. Go's scanner terminates a `null`/`true`/`false` exactly at
  // its own length, so `nullx` decodes to null. Anything shorter is an error.
  for (const literal of ["null", "true", "false"]) {
    if (text.startsWith(literal, i)) return i + literal.length
  }

  // A number. Go terminates at the first byte that cannot extend the literal —
  // so `123abc` -> 123, `1.2.3` -> 1.2, `01` -> 0 — but ERRORS when a bad byte
  // lands where a digit is required (`1.x`, `1ex`, `-x`), which the longest-
  // valid-prefix rule alone would silently accept. Verified against Go 1.26.5.
  let j = i
  const digits = (): number => {
    const start = j
    while (j < text.length && text[j]! >= "0" && text[j]! <= "9") j++
    return j - start
  }
  if (text[j] === "-") j++
  if (text[j] === "0") {
    // Go's `state0`: a leading zero consumes exactly ONE digit, so "01" -> 0
    // and "09" -> 0. It does NOT terminate the literal — a fraction or exponent
    // may still follow, so "0.5x" -> 0.5 and "0.x" is an ERROR, not 0.
    j++
  } else if (digits() === 0) {
    return undefined
  }
  if (text[j] === ".") {
    j++
    if (digits() === 0) return undefined
  }
  if (text[j] === "e" || text[j] === "E") {
    j++
    if (text[j] === "+" || text[j] === "-") j++
    if (digits() === 0) return undefined
  }
  return j
}

/** Strict first, then Go's tolerate-trailing-bytes behaviour. Exported for differential tests. */
export const decodeBody = (body: string): Result.Result<JsonValue, string> => {
  const strict = parseJson(body)
  if (Result.isSuccess(strict)) return Result.succeed(strict.success)
  const end = jsonPrefixEnd(body)
  if (end !== undefined && end < body.length) {
    const prefix = parseJson(body.slice(0, end))
    if (Result.isSuccess(prefix)) return Result.succeed(prefix.success)
  }
  return Result.fail(strict.failure.message)
}

/**
 * Go retries a transport failure only when it is (or wraps) a `net.Error` or
 * `io.EOF`. The equivalent here is a `TransportError` — connection
 * reset/refused, DNS failure, abrupt EOF — plus a whole-request timeout, which
 * in Go surfaces as a `net.Error` with `Timeout() == true` and so also consumes
 * retry budget. `InvalidUrlError` and `EncodeError` are programmer errors and
 * are never retried.
 */
const isRetryableTransport = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const tagged = error as { readonly _tag?: string; readonly reason?: { readonly _tag?: string } }
  if (tagged._tag === "TimeoutError") return true
  return tagged._tag === "HttpClientError" && tagged.reason?._tag === "TransportError"
}

/**
 * `parseAPIError`. A malformed / HTML / empty body leaves every envelope field
 * at zero, so `code` falls back to the HTTP status and `message` to the
 * canonical status text (which is `""` for statuses Go does not know).
 */
export const toApiError = (status: number, body: string): ApiError => {
  const envelope = parseErrorEnvelope(body)
  return new ApiError({
    httpStatus: status,
    code: envelope.code === 0 ? status : envelope.code,
    apiMessage: envelope.message === "" ? statusText(status) : envelope.message,
    reasons: envelope.reasons
  })
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const makeHttpCore = (
  config: HttpCoreConfig
): Effect.Effect<HttpCoreShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const tokenSource = config.tokenSource
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    const sleep = config.sleep ?? ((millis: number) => Effect.sleep(millis))
    const jitter = config.jitterMillis ?? defaultJitter
    const timeoutMillis = config.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS

    /**
     * The first-match-wins auth switch. A token-source failure aborts the whole
     * request with that error; the API key is never consulted as a fallback.
     */
    const authorize = (
      request: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpCoreError> => {
      if (tokenSource !== undefined) {
        return Effect.gen(function* () {
          const redacted = yield* tokenSource(false)
          const token = Redacted.value(redacted)
          if (token.trim() === "") return yield* Effect.fail(new MissingOAuthError({}))
          // The token goes in verbatim, untrimmed — only the emptiness test trims.
          return HttpClientRequest.setHeader(request, "Authorization", `Bearer ${token}`)
        })
      }
      if (config.apiKey.trim() !== "") {
        return Effect.succeed(HttpClientRequest.setHeader(request, "X-Goog-Api-Key", config.apiKey))
      }
      return Effect.fail(new MissingKeyError())
    }

    const getJson = (options: HttpCoreRequest): Effect.Effect<JsonValue, HttpCoreError> => {
      // Computed ONCE, before the retry loop, and never rebuilt — this is what
      // keeps credentials out of retry URLs.
      const url = buildUrl(options.baseUrl, options.resource, options.params)

      const attempt = (
        transientAttempt: number,
        authRetried: boolean
      ): Effect.Effect<JsonValue, HttpCoreError> =>
        Effect.gen(function* () {
          const base = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders({
              Accept: "application/json",
              "User-Agent": "oytc/0.1"
            })
          )
          const request = options.authenticate ? yield* authorize(base) : base

          const exchanged = yield* client.execute(request).pipe(
            Effect.flatMap((response) =>
              Effect.map(readBodyCapped(response), (body) => ({
                status: response.status,
                retryAfter: response.headers["retry-after"] ?? "",
                body
              }))
            ),
            Effect.timeout(timeoutMillis),
            Effect.result
          )

          if (Result.isFailure(exchanged)) {
            const failure = exchanged.failure
            // A body-read failure is NOT retried in Go; only transport is.
            if (failure instanceof OperationalError) return yield* Effect.fail(failure)
            if (!isRetryableTransport(failure) || transientAttempt >= maxRetries) {
              return yield* Effect.fail(
                new OperationalError({
                  message: `request YouTube API: ${describe(failure)}`,
                  cause: failure
                })
              )
            }
            // Transport retries never consult Retry-After.
            yield* sleep(backoffMillis(transientAttempt, "", jitter))
            return yield* attempt(transientAttempt + 1, authRetried)
          }

          const { status, retryAfter, body } = exchanged.success

          if (status < 200 || status >= 300) {
            // ONE forced refresh per request, taken before the error is even
            // parsed, and deliberately not charged against maxRetries.
            if (options.authenticate && tokenSource !== undefined && status === 401 && !authRetried) {
              yield* tokenSource(true)
              return yield* attempt(transientAttempt, true)
            }

            // Parsed BEFORE the retry decision, so an exhausted retry budget
            // surfaces the LAST attempt's body.
            const apiError = toApiError(status, body)

            if (isTransientStatus(status) && transientAttempt < maxRetries) {
              yield* sleep(backoffMillis(transientAttempt, retryAfter, jitter))
              return yield* attempt(transientAttempt + 1, authRetried)
            }
            return yield* Effect.fail(apiError)
          }

          const decoded = decodeBody(body)
          if (Result.isFailure(decoded)) {
            return yield* Effect.fail(
              new OperationalError({
                message: `decode YouTube API response: ${decoded.failure}`
              })
            )
          }
          return decoded.success
        })

      return Effect.suspend(() => attempt(0, false))
    }

    return { getJson } satisfies HttpCoreShape
  })

export const httpCoreLayer = (config: HttpCoreConfig) =>
  Layer.effect(HttpCore, makeHttpCore(config))

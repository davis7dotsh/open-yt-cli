/**
 * OAuth 2.0 loopback redirect flow (authorization code + PKCE S256).
 *
 * The Go implementation wraps `golang.org/x/oauth2`; this port reproduces the
 * WIRE behavior of that library rather than its API, because the wire behavior
 * is what Google sees and what the tests assert. In particular:
 *
 *   - `AuthStyle` is pinned to `AuthStyleInParams`: `client_id` and
 *     `client_secret` go in the POST body, never `Authorization: Basic`. Go
 *     pins this to avoid the library's two-request auto-detection probe.
 *   - Token responses are dispatched on `Content-Type` exactly as
 *     `x/oauth2/internal.doTokenRoundTrip` does — form/text-plain bodies are
 *     parsed as a query string, everything else as JSON — because the two
 *     branches produce *different* error descriptions for the same body, and
 *     `oauth_test.go` exercises both (`TestExchangeErrorWithoutContentType`
 *     reaches the form branch because Go's httptest server content-sniffs an
 *     unlabelled body to `text/plain`).
 *   - Expiry is stamped from `expires_in` against the clock, and both the stamp
 *     and the TokenSource skew check read the SAME clock. Go split these (real
 *     clock for stamping, `cfg.Now` for checks); using one Effect `Clock` is
 *     identical in production and strictly more coherent under a TestClock.
 *
 * Non-obvious invariants worth keeping:
 *   - `redirectURI` has NO trailing slash and NO path. It is sent byte-identical
 *     in the authorization request and the token exchange; Google compares them.
 *   - The 3-minute login timeout covers ONLY the wait for the browser callback.
 *     The token exchange that follows runs under the caller's timeout.
 */

import { Clock, Console, Effect, Layer, Redacted, Ref, type Scope, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "../effect.ts"
import { MissingOAuthError, OAuthError, OperationalError, statusText } from "../domain/errors.ts"
import {
  BrowserOpener,
  type BrowserOpenerShape,
  CredentialStore,
  type CredentialStoreShape,
  OAuthService,
  type OAuthLoginRequest,
  type OAuthServiceShape,
  type StoredOAuth
} from "../services/index.ts"
import { acquireLoopbackServer } from "./oauthServer.ts"
import { makeTokenSource, type TokenSourceHandle } from "./tokenSource.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const DEFAULT_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

/** `DefaultLoginTimeout`; the CLI also passes 3m explicitly. */
export const DEFAULT_LOGIN_TIMEOUT_MILLIS = 3 * 60 * 1000

/** Go's default `http.Client{Timeout: 20 * time.Second}` when none is injected. */
export const DEFAULT_HTTP_TIMEOUT_MILLIS = 20_000

/** `io.ReadAll(io.LimitReader(body, 1<<20))` — both in x/oauth2 and in `Revoke`. */
const BODY_LIMIT_BYTES = 1 << 20

/**
 * Scopes, in this exact order (internal/cli/auth.go). Analytics reports plus
 * read-only Data API access, so an OAuth-only setup can also run every
 * public-data command. `youtube.readonly` is classified *sensitive*: unverified
 * apps requesting it are hard-blocked for accounts with Advanced Protection or
 * restrictive Workspace policies.
 */
export const DEFAULT_SCOPES: ReadonlyArray<string> = [
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.readonly"
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthToken {
  readonly accessToken: string
  readonly refreshToken: string
  /** Millis since the epoch. `0` is Go's zero `time.Time` — "no expiry known". */
  readonly expiryMillis: number
  readonly scopes: ReadonlyArray<string>
}

export interface OAuthEndpoints {
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
}

export interface OAuthConfig extends OAuthEndpoints {
  readonly clientId: string
  readonly clientSecret: string
  readonly scopes: ReadonlyArray<string>
  readonly httpTimeoutMillis: number
  readonly loginTimeoutMillis: number
}

export const defaultEndpoints: OAuthEndpoints = {
  authorizationUrl: DEFAULT_AUTHORIZATION_URL,
  tokenUrl: DEFAULT_TOKEN_URL,
  revokeUrl: DEFAULT_REVOKE_URL
}

/** `withDefaults(cfg)` — empty strings and non-positive durations fall back. */
export const withDefaults = (config: Partial<OAuthConfig>): OAuthConfig => ({
  clientId: config.clientId ?? "",
  clientSecret: config.clientSecret ?? "",
  scopes: config.scopes ?? [],
  authorizationUrl:
    config.authorizationUrl === undefined || config.authorizationUrl === ""
      ? DEFAULT_AUTHORIZATION_URL
      : config.authorizationUrl,
  tokenUrl:
    config.tokenUrl === undefined || config.tokenUrl === ""
      ? DEFAULT_TOKEN_URL
      : config.tokenUrl,
  revokeUrl:
    config.revokeUrl === undefined || config.revokeUrl === ""
      ? DEFAULT_REVOKE_URL
      : config.revokeUrl,
  httpTimeoutMillis:
    config.httpTimeoutMillis === undefined || config.httpTimeoutMillis <= 0
      ? DEFAULT_HTTP_TIMEOUT_MILLIS
      : config.httpTimeoutMillis,
  loginTimeoutMillis:
    config.loginTimeoutMillis === undefined || config.loginTimeoutMillis <= 0
      ? DEFAULT_LOGIN_TIMEOUT_MILLIS
      : config.loginTimeoutMillis
})

/**
 * `OAuth authorization is expired or revoked; re-run 'oytc login --oauth': <err>`.
 *
 * Go wraps the `*oauth.Error` with `%w`, so `main.go`'s `errors.As` still finds
 * it and still exits 3. Subclassing keeps `_tag: "OAuthError"` and therefore the
 * same exit-code derivation, while replacing the rendered message.
 */
export class ExpiredAuthorizationError extends OAuthError {
  override get message(): string {
    const code = this.code === "" ? "unknown" : this.code
    const inner =
      this.description === ""
        ? `OAuth error (${code})`
        : `OAuth error (${code}): ${this.description}`
    return `OAuth authorization is expired or revoked; re-run 'oytc login --oauth': ${inner}`
  }
}

/**
 * `OAuth refresh token is missing; re-run 'oytc login --oauth'`.
 *
 * Go returns a bare `errors.New`, which `main.go` classifies as exit 3 purely by
 * the `re-run 'oytc login --oauth'` substring rule. Modelling it as an
 * `OAuthError` with an empty code lands on the same exit 3 through the
 * structured path, and keeps it inside the error union `refresh` declares.
 */
export class MissingRefreshTokenError extends OAuthError {
  constructor() {
    super({ httpStatus: 0, code: "", description: "" })
  }
  override get message(): string {
    return "OAuth refresh token is missing; re-run 'oytc login --oauth'"
  }
}

// ---------------------------------------------------------------------------
// Randomness, PKCE
// ---------------------------------------------------------------------------

const base64UrlNoPad = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

/**
 * `base64.RawURLEncoding.EncodeToString(rand(32))` — 43 characters.
 * Used for both `state` and the PKCE verifier (`oauth2.GenerateVerifier`).
 */
export const randomUrlSafe = (byteLength: number): Effect.Effect<string, OperationalError> =>
  Effect.try({
    try: () => base64UrlNoPad(crypto.getRandomValues(new Uint8Array(byteLength))),
    catch: (cause) =>
      new OperationalError({
        message: `generate OAuth random value: ${describe(cause)}`,
        cause
      })
  })

/** `code_challenge = base64url_nopad(sha256(verifier))`, method `S256`. */
export const pkceChallenge = (verifier: string): Effect.Effect<string, OperationalError> =>
  Effect.tryPromise({
    try: async () =>
      base64UrlNoPad(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
      ),
    catch: (cause) =>
      new OperationalError({
        message: `generate OAuth PKCE challenge: ${describe(cause)}`,
        cause
      })
  })

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

/**
 * Go's `url.Values.Encode()` sorts keys before joining. Percent-encoding is
 * byte-identical to `URLSearchParams` for every value this flow produces
 * (base64url state/challenge, an `https://` scope list, a loopback redirect URI,
 * a Google client id): the two disagree only on `~ ! * ( ) '`, none of which
 * occur. Sorting keeps the emitted URL byte-comparable with the Go binary.
 */
const encodeForm = (pairs: ReadonlyArray<readonly [string, string]>): string => {
  const sorted = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(sorted as Array<[string, string]>).toString()
}

export const authorizationUrl = (
  config: OAuthConfig,
  redirectUri: string,
  state: string,
  challenge: string
): string => {
  const params: Array<readonly [string, string]> = [
    ["response_type", "code"],
    ["client_id", config.clientId]
  ]
  if (redirectUri !== "") params.push(["redirect_uri", redirectUri])
  if (config.scopes.length > 0) params.push(["scope", config.scopes.join(" ")])
  if (state !== "") params.push(["state", state])
  params.push(["access_type", "offline"])
  params.push(["code_challenge_method", "S256"])
  params.push(["code_challenge", challenge])
  // Forces the consent screen so Google ALWAYS returns a refresh token, not
  // only on the first authorization.
  params.push(["prompt", "consent"])

  const separator = config.authorizationUrl.includes("?") ? "&" : "?"
  return `${config.authorizationUrl}${separator}${encodeForm(params)}`
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const decodeBody = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes.subarray(0, BODY_LIMIT_BYTES))

/** `mime.ParseMediaType` reduced to what the dispatch needs. */
const mediaType = (contentType: string | undefined): string =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

/** `expirationTime.UnmarshalJSON` — numbers or numeric strings, clamped to int32. */
const asExpiresIn = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.trunc(n), 2147483647)
}

interface TokenPayload {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresInSeconds: number
  readonly scope: string
  readonly errorCode: string
  readonly errorDescription: string
  /** The body could not be decoded in the branch its content type selected. */
  readonly undecodable: boolean
}

const parseFormPayload = (body: string): TokenPayload => {
  const values = new URLSearchParams(body)
  return {
    accessToken: values.get("access_token") ?? "",
    refreshToken: values.get("refresh_token") ?? "",
    expiresInSeconds: asExpiresIn(values.get("expires_in") ?? ""),
    scope: values.get("scope") ?? "",
    errorCode: values.get("error") ?? "",
    errorDescription: values.get("error_description") ?? "",
    undecodable: false
  }
}

const parseJsonPayload = (body: string): TokenPayload => {
  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    return {
      accessToken: "",
      refreshToken: "",
      expiresInSeconds: 0,
      scope: "",
      errorCode: "",
      errorDescription: "",
      undecodable: true
    }
  }
  const record = (
    typeof decoded === "object" && decoded !== null ? decoded : {}
  ) as Record<string, unknown>
  return {
    accessToken: asString(record["access_token"]),
    refreshToken: asString(record["refresh_token"]),
    expiresInSeconds: asExpiresIn(record["expires_in"]),
    scope: asString(record["scope"]),
    errorCode: asString(record["error"]),
    errorDescription: asString(record["error_description"]),
    undecodable: false
  }
}

/**
 * `doTokenRoundTrip`'s content-type dispatch. Form/text-plain bodies are read as
 * a query string — which is why an unlabelled JSON error body yields an EMPTY
 * error code there and has to be re-parsed by {@link parseErrorBody}.
 */
const parseTokenPayload = (contentType: string | undefined, body: string): TokenPayload => {
  const type = mediaType(contentType)
  return type === "application/x-www-form-urlencoded" || type === "text/plain"
    ? parseFormPayload(body)
    : parseJsonPayload(body)
}

/**
 * `parseError(status, body)`: JSON-decode `{error, error_description}`; an empty
 * code falls back to the HTTP status text, an empty description to the trimmed
 * raw body.
 */
export const parseErrorBody = (status: number, body: string): OAuthError => {
  const payload = parseJsonPayload(body)
  return new OAuthError({
    httpStatus: status,
    code: payload.errorCode === "" ? statusText(status) : payload.errorCode,
    description: payload.errorDescription === "" ? body.trim() : payload.errorDescription
  })
}

interface RetrievedToken {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiryMillis: number
  readonly scope: string
}

const postForm = (
  action: string,
  url: string,
  form: ReadonlyArray<readonly [string, string]>,
  headers: ReadonlyArray<readonly [string, string]>,
  timeoutMillis: number
): Effect.Effect<
  { readonly status: number; readonly contentType: string | undefined; readonly body: string },
  OperationalError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    // Sorted, so the emitted body is byte-identical to Go's url.Values.Encode.
    let request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(encodeForm(form), "application/x-www-form-urlencoded")
    )
    for (const [name, value] of headers) {
      request = HttpClientRequest.setHeader(request, name, value)
    }
    const response = yield* client.execute(request)
    const buffer = yield* response.arrayBuffer
    return {
      status: response.status,
      contentType: response.headers["content-type"],
      body: decodeBody(new Uint8Array(buffer))
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () =>
        Effect.fail(
          new OperationalError({
            message: `${action}: Client.Timeout exceeded while awaiting headers`
          })
        )
    }),
    // translateError: a *url.Error is unwrapped to `<action>: <underlying>`.
    Effect.catch((cause) =>
      cause instanceof OperationalError
        ? Effect.fail(cause)
        : Effect.fail(
            new OperationalError({ message: `${action}: ${describe(cause)}`, cause })
          )
    )
  )

/** `retrieveToken` + `translateError`, collapsed. */
const retrieveToken = (
  action: string,
  config: OAuthConfig,
  form: ReadonlyArray<readonly [string, string]>
): Effect.Effect<RetrievedToken, OAuthError | OperationalError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // AuthStyleInParams: credentials in the POST body, never Basic auth.
    const body: Array<readonly [string, string]> = [...form]
    if (config.clientId !== "") body.push(["client_id", config.clientId])
    if (config.clientSecret !== "") body.push(["client_secret", config.clientSecret])

    const response = yield* postForm(action, config.tokenUrl, body, [], config.httpTimeoutMillis)
    const failureStatus = response.status < 200 || response.status > 299
    const payload = parseTokenPayload(response.contentType, response.body)

    if (payload.undecodable) {
      return yield* Effect.fail(
        failureStatus
          ? parseErrorBody(response.status, response.body)
          : new OperationalError({ message: `oauth2: cannot parse json: ${response.body}` })
      )
    }

    if (failureStatus || payload.errorCode !== "") {
      return yield* Effect.fail(
        payload.errorCode === ""
          ? parseErrorBody(response.status, response.body)
          : new OAuthError({
              httpStatus: response.status,
              code: payload.errorCode,
              description: payload.errorDescription
            })
      )
    }

    if (payload.accessToken === "") {
      return yield* Effect.fail(
        new OperationalError({ message: "oauth2: server response missing access_token" })
      )
    }

    const now = yield* Clock.currentTimeMillis
    // Don't overwrite an empty RefreshToken on a refresh_token grant.
    const requested = body.find(([key]) => key === "refresh_token")?.[1] ?? ""
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken === "" ? requested : payload.refreshToken,
      expiryMillis:
        payload.expiresInSeconds === 0 ? 0 : now + payload.expiresInSeconds * 1000,
      scope: payload.scope
    }
  })

/**
 * `fromLibrary`: inherit the refresh token and the scopes when the response
 * omits them, falling back to the configured scopes only as a last resort.
 */
const normalizeToken = (
  retrieved: RetrievedToken,
  config: OAuthConfig,
  current: OAuthToken
): OAuthToken => {
  // strings.Fields: split on any whitespace run, no empty elements.
  const granted = retrieved.scope.split(/\s+/).filter((part) => part !== "")
  const scopes =
    granted.length > 0 ? granted : current.scopes.length > 0 ? [...current.scopes] : [...config.scopes]
  return {
    accessToken: retrieved.accessToken,
    refreshToken: retrieved.refreshToken === "" ? current.refreshToken : retrieved.refreshToken,
    expiryMillis: retrieved.expiryMillis,
    scopes
  }
}

const emptyToken: OAuthToken = {
  accessToken: "",
  refreshToken: "",
  expiryMillis: 0,
  scopes: []
}

// ---------------------------------------------------------------------------
// Exchange / refresh / revoke
// ---------------------------------------------------------------------------

export const exchange = (
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  verifier: string
): Effect.Effect<OAuthToken, OAuthError | OperationalError, HttpClient.HttpClient> => {
  const form: Array<readonly [string, string]> = [
    ["grant_type", "authorization_code"],
    ["code", code]
  ]
  if (redirectUri !== "") form.push(["redirect_uri", redirectUri])
  form.push(["code_verifier", verifier])
  return Effect.map(retrieveToken("request OAuth token", config, form), (retrieved) =>
    normalizeToken(retrieved, config, emptyToken)
  )
}

export const refresh = (
  config: OAuthConfig,
  current: OAuthToken
): Effect.Effect<OAuthToken, OAuthError | OperationalError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (current.refreshToken.trim() === "") {
      return yield* Effect.fail(new MissingRefreshTokenError())
    }
    const retrieved = yield* retrieveToken("refresh OAuth token", config, [
      ["grant_type", "refresh_token"],
      ["refresh_token", current.refreshToken]
    ])
    return normalizeToken(retrieved, config, current)
  })

/**
 * Best-effort revocation. An empty/whitespace token is a no-op that succeeds,
 * matching Go; a non-2xx response becomes a structured `OAuthError` that the
 * caller downgrades to a warning.
 */
export const revoke = (
  config: OAuthConfig,
  token: string
): Effect.Effect<void, OAuthError | OperationalError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (token.trim() === "") return
    const response = yield* postForm(
      "revoke OAuth token",
      config.revokeUrl,
      [["token", token]],
      [
        ["Content-Type", "application/x-www-form-urlencoded"],
        ["Accept", "application/json"]
      ],
      config.httpTimeoutMillis
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(parseErrorBody(response.status, response.body))
    }
  })

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginHooks {
  /** Receives the authorization URL; stderr in production. */
  readonly announce: (message: string) => Effect.Effect<void>
  /** Best-effort browser launch; failures are reported by the opener itself. */
  readonly openBrowser: (url: string) => Effect.Effect<void>
}

/**
 * The full loopback flow. The 3-minute timeout wraps ONLY the wait for the
 * callback — the exchange that follows inherits the caller's deadline, so a
 * user who authorizes at 2m59s still gets a token.
 */
export const login = (
  config: OAuthConfig,
  hooks: LoginHooks
): Effect.Effect<
  OAuthToken,
  OAuthError | OperationalError,
  HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    if (config.clientId.trim() === "") {
      return yield* Effect.fail(new OperationalError({ message: "OAuth client ID cannot be empty" }))
    }
    if (config.clientSecret.trim() === "") {
      return yield* Effect.fail(
        new OperationalError({ message: "OAuth client secret cannot be empty" })
      )
    }

    const state = yield* randomUrlSafe(32)
    const verifier = yield* randomUrlSafe(32)
    const challenge = yield* pkceChallenge(verifier)

    const server = yield* acquireLoopbackServer(state)
    const target = authorizationUrl(config, server.redirectUri, state, challenge)

    yield* hooks.announce(`Open this URL to authorize oytc:\n${target}`)
    yield* hooks.openBrowser(target)

    const code = yield* server.awaitCode.pipe(
      Effect.timeoutOrElse({
        duration: config.loginTimeoutMillis,
        orElse: () =>
          Effect.fail(
            new OperationalError({ message: "timed out waiting for OAuth authorization" })
          )
      })
    )

    return yield* exchange(config, code, server.redirectUri, verifier)
  })

// ---------------------------------------------------------------------------
// Expiry serialization
// ---------------------------------------------------------------------------

/** The layout string Go names `time.RFC3339`; it appears verbatim in errors. */
const RFC3339_LAYOUT = "2006-01-02T15:04:05Z07:00"

/**
 * Go's `time` package has its OWN quoting, which is NOT `strconv.Quote` (and so
 * NOT `goQuote` from resolveChannel.ts), and is not the JS JSON string encoder
 * either. Per `time/format.go`'s `quote`, every byte `>= 0x80` or
 * `< 0x20` is emitted as `\xNN` over its UTF-8 BYTES — so `café` renders as
 * `caf\xc3\xa9`, a tab as `\x09` (not `\t`), and 🎉 as four `\xNN` escapes.
 * Only `"` and `\` get a backslash; everything else printable-ASCII is literal.
 * Verified against Go 1.26 for `café`, `日本`, `a"b`, `a\b`, `a\tb`, `a\x01b`
 * and an emoji.
 */
const timeQuote = (value: string): string => {
  const bytes = new TextEncoder().encode(value)
  let out = '"'
  for (const byte of bytes) {
    if (byte >= 0x80 || byte < 0x20) {
      out += `\\x${byte.toString(16).padStart(2, "0")}`
    } else {
      if (byte === 0x22 || byte === 0x5c) out += "\\"
      out += String.fromCharCode(byte)
    }
  }
  return `${out}"`
}

/** `cannot parse <valueElem> as <layoutElem>` — ParseError with an empty Message. */
const cannotParse = (value: string, valueElem: string, layoutElem: string): string =>
  `parsing time ${timeQuote(value)} as ${timeQuote(RFC3339_LAYOUT)}: ` +
  `cannot parse ${timeQuote(valueElem)} as ${timeQuote(layoutElem)}`

/** `parsing time <value>: <message>` — ParseError with a non-empty Message. */
const parseMessage = (value: string, message: string): string =>
  `parsing time ${timeQuote(value)}: ${message}`

const isDigit = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i)
  return c >= 48 && c <= 57
}

/** Days in a Gregorian month, with Go's leap rule (`isLeap`). */
const daysIn = (month: number, year: number): number => {
  if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) return 29
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
}

/**
 * `time.Parse(time.RFC3339, value)`, reproduced closely enough that the
 * accept/reject verdict, the resulting instant, and the error text all match.
 *
 * Go tries a strict fast path (`parseRFC3339`) and, when that fails, falls back
 * to the GENERAL layout parser, which is meaningfully laxer. That fallback is
 * why several inputs a hand-rolled regex would reject are actually accepted:
 *
 *   - a ONE-digit hour: `2026-01-02T5:04:05Z` parses (only the hour is lax;
 *     `getnum(value, false)` is non-fixed for `15`, while minute/second use the
 *     zero-padded `04`/`05` verbs and stay fixed at two digits)
 *   - a COMMA sub-second separator: `...05,5Z` parses (`commaOrPeriod`)
 *   - zone offsets up to ±24:60 — Go's own comment says the range tests use `>`
 *     rather than `>=` "as some people do write offsets of 24 hours or 60
 *     minutes", so `+24:00` and `+12:60` are ACCEPTED and only `+25:00` /
 *     `+00:99` are rejected
 *
 * And why several a `Date.parse` shortcut would accept are rejected:
 *
 *   - `2026-02-30`, `2026-06-31`, `2026-02-29` — JS silently rolls these over
 *     into the next month; Go validates against `daysIn` and fails with
 *     `day out of range`
 *   - `2026-01-02T24:00:00Z` — JS accepts hour 24 as the next midnight; Go's
 *     `stdHour` rejects `24 <= hour`
 *
 * Error precedence follows `parse`'s loop: a range error for an element beats a
 * syntax error in a LATER element, `extra text` is reported after the whole
 * layout is consumed, and the day-of-month check runs last of all.
 */
const parseRfc3339 = (value: string): { readonly millis: number } | { readonly message: string } => {
  // Elements are consumed left to right, so a truncated input naturally fails on
  // the first element that runs past the end and reports `cannot parse "" as X`,
  // exactly as Go's layout walk does. No length pre-check is needed (or correct).

  // --- year "2006": exactly four digits, no sign ---
  if (!/^\d{4}$/.test(value.slice(0, 4))) {
    return { message: cannotParse(value, value, "2006") }
  }
  const year = Number(value.slice(0, 4))
  let i = 4

  const literal = (ch: string, elem: string): string | undefined =>
    value[i] === ch ? void (i += 1) : cannotParse(value, value.slice(i), elem)

  let bad = literal("-", "-")
  if (bad !== undefined) return { message: bad }

  // --- month "01": FIXED two digits, range 1..12 ---
  if (!isDigit(value, i) || !isDigit(value, i + 1)) {
    return { message: cannotParse(value, value.slice(i), "01") }
  }
  const month = Number(value.slice(i, i + 2))
  const monthElem = value.slice(i + 2)
  i += 2
  if (month <= 0 || month > 12) {
    return { message: parseMessage(value, "month out of range") }
  }
  void monthElem

  bad = literal("-", "-")
  if (bad !== undefined) return { message: bad }

  // --- day "02": FIXED two digits; the value range is validated at the end ---
  if (!isDigit(value, i) || !isDigit(value, i + 1)) {
    return { message: cannotParse(value, value.slice(i), "02") }
  }
  const day = Number(value.slice(i, i + 2))
  i += 2

  bad = literal("T", "T")
  if (bad !== undefined) return { message: bad }

  // --- hour "15": NON-fixed, so one OR two digits; range 0..23 ---
  if (!isDigit(value, i)) {
    return { message: cannotParse(value, value.slice(i), "15") }
  }
  const hourWidth = isDigit(value, i + 1) ? 2 : 1
  const hour = Number(value.slice(i, i + hourWidth))
  i += hourWidth
  if (hour < 0 || hour >= 24) {
    return { message: parseMessage(value, "hour out of range") }
  }

  bad = literal(":", ":")
  if (bad !== undefined) return { message: bad }

  // --- minute "04": FIXED two digits; range 0..59 ---
  if (!isDigit(value, i) || !isDigit(value, i + 1)) {
    return { message: cannotParse(value, value.slice(i), "04") }
  }
  const minute = Number(value.slice(i, i + 2))
  i += 2
  if (minute < 0 || minute >= 60) {
    return { message: parseMessage(value, "minute out of range") }
  }

  bad = literal(":", ":")
  if (bad !== undefined) return { message: bad }

  // --- second "05": FIXED two digits; range 0..59 (no leap second) ---
  if (!isDigit(value, i) || !isDigit(value, i + 1)) {
    return { message: cannotParse(value, value.slice(i), "05") }
  }
  const second = Number(value.slice(i, i + 2))
  i += 2
  if (second < 0 || second >= 60) {
    return { message: parseMessage(value, "second out of range") }
  }

  // --- fractional second: `.` OR `,` followed by at least one digit ---
  // Only the first 9 digits contribute to nanoseconds; we need milliseconds,
  // so the first 3 suffice and the rest are truncated (never rounded).
  let millisFraction = 0
  if ((value[i] === "." || value[i] === ",") && isDigit(value, i + 1)) {
    let n = i + 1
    while (n < value.length && isDigit(value, n)) n += 1
    const digits = value.slice(i + 1, n)
    millisFraction = Number(`${digits.slice(0, 3)}${"0".repeat(Math.max(0, 3 - digits.length))}`)
    i = n
  }

  // --- zone "Z07:00": literal `Z`, or ±hh:mm with Go's LAX `>` range tests ---
  let offsetMinutes = 0
  if (value[i] === "Z") {
    i += 1
  } else {
    const zone = value.slice(i, i + 6)
    const sign = zone[0]
    // Go splits the field FIRST (length and the `:` at index 3 are all it checks
    // structurally), then reads the two numbers, then range-tests them, and only
    // afterwards validates the sign. So a bad SIGN with an out-of-range hour —
    // `...05x25:00` — reports "time zone offset hour out of range", not a parse
    // error. Order matters here and is verified against Go.
    if (zone.length !== 6 || zone[3] !== ":") {
      return { message: cannotParse(value, value.slice(i), "Z07:00") }
    }
    const hourDigits = /^\d{2}$/.test(zone.slice(1, 3))
    const minuteDigits = /^\d{2}$/.test(zone.slice(4, 6))
    const zoneHour = hourDigits ? Number(zone.slice(1, 3)) : 0
    const zoneMinute = minuteDigits ? Number(zone.slice(4, 6)) : 0
    // Go: "The range test use > rather than >=, as some people do write offsets
    // of 24 hours or 60 minutes or 60 seconds." Both tests assign to the SAME
    // `rangeErrString`, so when both are out of range the MINUTE message wins.
    let rangeError = ""
    if (hourDigits && zoneHour > 24) rangeError = "time zone offset hour out of range"
    if (minuteDigits && zoneMinute > 60) rangeError = "time zone offset minute out of range"
    if (rangeError !== "") return { message: parseMessage(value, rangeError) }
    if (!hourDigits || !minuteDigits || (sign !== "+" && sign !== "-")) {
      return { message: cannotParse(value, value.slice(i), "Z07:00") }
    }
    offsetMinutes = (sign === "-" ? -1 : 1) * (zoneHour * 60 + zoneMinute)
    i += 6
  }

  // --- trailing junk, reported once the layout is fully consumed ---
  if (i !== value.length) {
    const extra = value.slice(i)
    return { message: parseMessage(value, `extra text: ${timeQuote(extra)}`) }
  }

  // --- day-of-month, validated last, exactly as Go does ---
  if (day < 1 || day > daysIn(month, year)) {
    return { message: parseMessage(value, "day out of range") }
  }

  // Date.UTC maps years 0..99 into 1900..1999; setUTCFullYear undoes that so
  // year 0 stays year 0 (Go accepts "0000-01-01T00:00:00Z").
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisFraction)
  return { millis: date.getTime() - offsetMinutes * 60_000 }
}

/** `ParseExpiry` — blank is the zero time (0 millis) and is NOT an error. */
export const parseExpiry = (value: string): Effect.Effect<number, OperationalError> =>
  Effect.gen(function* () {
    if (value.trim() === "") return 0
    const parsed = parseRfc3339(value)
    if ("message" in parsed) {
      return yield* Effect.fail(
        new OperationalError({ message: `parse OAuth token expiry: ${parsed.message}` })
      )
    }
    return parsed.millis
  })

/** `FormatExpiry` — the zero time is `""`; otherwise UTC RFC 3339, second precision. */
export const formatExpiry = (millis: number): string => {
  if (millis === 0) return ""
  return `${new Date(millis).toISOString().slice(0, 19)}Z`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const configFor = (
  clientId: string,
  clientSecret: string,
  endpoints: Partial<OAuthEndpoints>
): OAuthConfig =>
  withDefaults({
    clientId,
    clientSecret,
    scopes: DEFAULT_SCOPES,
    ...endpoints
  })

export const storedFrom = (
  clientId: string,
  clientSecret: string,
  token: OAuthToken
): StoredOAuth => ({
  clientId,
  clientSecret,
  accessToken: token.accessToken,
  refreshToken: token.refreshToken,
  expiry: formatExpiry(token.expiryMillis),
  scopes: [...token.scopes]
})

const tokenFrom = (stored: StoredOAuth, expiryMillis: number): OAuthToken => ({
  accessToken: stored.accessToken,
  refreshToken: stored.refreshToken,
  expiryMillis,
  scopes: [...stored.scopes]
})

/**
 * `endpoints` exists purely so tests can point the flow at a local server, the
 * same role `App.OAuthTokenURL` plays in Go.
 */
export const makeOAuthService = (
  endpoints: Partial<OAuthEndpoints> = {}
): Effect.Effect<
  OAuthServiceShape,
  never,
  HttpClient.HttpClient | CredentialStoreShape | BrowserOpenerShape
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const credentials = yield* CredentialStore
    const browser = yield* BrowserOpener
    const cached = yield* Ref.make<TokenSourceHandle | undefined>(undefined)
    // Guards construction: two concurrent requests must share ONE handle, or
    // they would each hold their own skew cache and CAS snapshot.
    const buildGate = yield* Semaphore.make(1)

    const withClient = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, HttpClient.HttpClient, client)

    /**
     * Built lazily and reused: `HttpCore` asks for a token on every request and
     * forces a refresh after a 401, so the skew cache and the CAS snapshot have
     * to survive across calls.
     */
    const source = Semaphore.withPermit(
      buildGate,
      Effect.gen(function* () {
        const existing = yield* Ref.get(cached)
        if (existing !== undefined) return existing

        const loaded = yield* credentials.load
        const stored = loaded.oauth
        if (stored === undefined) return yield* Effect.fail(new MissingOAuthError({}))

        const config = configFor(stored.clientId, stored.clientSecret, endpoints)
        const expiryMillis = yield* parseExpiry(stored.expiry)
        // The CAS snapshot only advances when the store reports a real write, so
        // a refresh racing a `logout` cannot resurrect removed credentials.
        const persisted = yield* Ref.make<StoredOAuth>(stored)
        const handle = makeTokenSource({
          token: tokenFrom(stored, expiryMillis),
          refresh: (current) => withClient(refresh(config, current)),
          onUpdate: (updated) =>
            Effect.gen(function* () {
              const expected = yield* Ref.get(persisted)
              const next = storedFrom(stored.clientId, stored.clientSecret, updated)
              const saved = yield* credentials.saveRefreshedOAuth(expected, next)
              if (saved) yield* Ref.set(persisted, next)
            }).pipe(
              Effect.catch((cause) =>
                Effect.fail(
                  cause instanceof OperationalError
                    ? cause
                    : new OperationalError({ message: cause.message, cause })
                )
              )
            )
        })
        yield* Ref.set(cached, handle)
        return handle
      })
    )

    return {
      login: (request: OAuthLoginRequest) =>
        Effect.gen(function* () {
          const clientId = request.clientId
          const clientSecret = Redacted.value(request.clientSecret)
          const config = configFor(clientId, clientSecret, endpoints)
          const token = yield* withClient(
            login(config, {
              // Go writes this to cfg.Out, which the CLI wires to stderr.
              announce: Console.error,
              openBrowser: browser.open
            })
          )
          return storedFrom(clientId, clientSecret, token)
        }).pipe(Effect.scoped),

      refresh: (stored: StoredOAuth) =>
        Effect.gen(function* () {
          const config = configFor(stored.clientId, stored.clientSecret, endpoints)
          const expiryMillis = yield* parseExpiry(stored.expiry)
          const token = yield* withClient(refresh(config, tokenFrom(stored, expiryMillis)))
          return storedFrom(stored.clientId, stored.clientSecret, token)
        }),

      revoke: (stored: StoredOAuth) => {
        const config = configFor(stored.clientId, stored.clientSecret, endpoints)
        const token = stored.refreshToken === "" ? stored.accessToken : stored.refreshToken
        return withClient(revoke(config, token)).pipe(Effect.ignore)
      },

      tokenSource: (force: boolean) =>
        Effect.map(
          Effect.flatMap(source, (handle) => handle.accessToken(force)),
          Redacted.make
        )
    }
  })

export const OAuthServiceLive = Layer.effect(OAuthService, makeOAuthService())

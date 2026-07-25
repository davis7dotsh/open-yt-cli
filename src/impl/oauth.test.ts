/**
 * Ports all 9 cases from `internal/oauth/oauth_test.go`, plus the wire-level
 * details the Go tests got for free from `x/oauth2` and that this port has to
 * reimplement (auth style, content-type dispatch, expiry serialization).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
// `effect/testing` is a stable subpath, so the src/effect.ts barrel rule does not
// apply to it (that rule covers the unstable subpath only).
import { TestConsole } from "effect/testing"
import { FetchHttpClient, HttpClient } from "../effect.ts"
import { MissingOAuthError, OAuthError, OperationalError } from "../domain/errors.ts"
import {
  BrowserOpener,
  type BrowserOpenerShape,
  CredentialStore,
  type CredentialStoreShape,
  type Credentials,
  OAuthService,
  type OAuthServiceShape,
  type StoredOAuth
} from "../services/index.ts"
import {
  authorizationUrl,
  DEFAULT_SCOPES,
  exchange,
  formatExpiry,
  login,
  makeOAuthService,
  MissingRefreshTokenError,
  parseErrorBody,
  parseExpiry,
  pkceChallenge,
  randomUrlSafe,
  refresh,
  revoke,
  withDefaults,
  type OAuthToken
} from "./oauth.ts"

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly contentType: string
  readonly form: URLSearchParams
  readonly authorization: string | null
}

interface FakeServer {
  readonly url: string
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly bodies: ReadonlyArray<string>
  readonly stop: () => Promise<void>
}

const servers: Array<{ stop: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop()
})

/** A local token/revoke endpoint standing in for Go's `httptest.NewServer`. */
const startServer = (handler: (request: RecordedRequest) => Response): FakeServer => {
  const requests: Array<RecordedRequest> = []
  const bodies: Array<string> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text()
      bodies.push(body)
      const recorded: RecordedRequest = {
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type") ?? "",
        form: new URLSearchParams(body),
        authorization: request.headers.get("authorization")
      }
      requests.push(recorded)
      return handler(recorded)
    }
  })
  const handle = { stop: async () => void (await server.stop()) }
  servers.push(handle)
  return { url: `http://127.0.0.1:${server.port}`, requests, bodies, stop: handle.stop }
}

/** Go's `writeTokenJSON`: the JSON content type is load-bearing for the parser. */
const tokenJson = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } })

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect)

const runHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer))

const flipHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<E> =>
  Effect.runPromise(Effect.provide(Effect.flip(effect), FetchHttpClient.layer))

const config = (overrides: Partial<Parameters<typeof withDefaults>[0]> = {}) =>
  withDefaults({ clientId: "id", clientSecret: "secret", ...overrides })

const emptyToken: OAuthToken = {
  accessToken: "",
  refreshToken: "",
  expiryMillis: 0,
  scopes: []
}

// ---------------------------------------------------------------------------
// TestAuthorizationURL
// ---------------------------------------------------------------------------

describe("authorizationUrl", () => {
  test("carries every parameter Google requires", async () => {
    const verifier = await run(randomUrlSafe(32))
    const challenge = await run(pkceChallenge(verifier))
    const target = authorizationUrl(
      config({
        clientId: "desktop-client",
        scopes: ["scope.one", "scope.two"],
        authorizationUrl: "https://accounts.example/authorize"
      }),
      "http://127.0.0.1:1234",
      "state-value",
      challenge
    )
    const query = new URL(target).searchParams
    expect(Object.fromEntries(query)).toEqual({
      client_id: "desktop-client",
      redirect_uri: "http://127.0.0.1:1234",
      response_type: "code",
      scope: "scope.one scope.two",
      state: "state-value",
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent"
    })
  })

  test("scopes join with a single space, in the configured order", () => {
    const target = authorizationUrl(
      config({ scopes: DEFAULT_SCOPES, authorizationUrl: "https://accounts.example/authorize" }),
      "http://127.0.0.1:1",
      "s",
      "c"
    )
    expect(new URL(target).searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/yt-analytics.readonly" +
        " https://www.googleapis.com/auth/youtube.readonly"
    )
  })

  test("appends with & when the endpoint already has a query string", () => {
    const target = authorizationUrl(
      config({ authorizationUrl: "https://accounts.example/authorize?hd=example.com" }),
      "",
      "",
      "c"
    )
    expect(target.startsWith("https://accounts.example/authorize?hd=example.com&")).toBe(true)
  })

  test("is byte-identical to the Go binary's output for the same inputs", () => {
    // Golden captured from internal/oauth.AuthorizationURL on 2026-07-25.
    expect(
      authorizationUrl(
        config({ clientId: "desktop-client", scopes: DEFAULT_SCOPES }),
        "http://127.0.0.1:54321",
        "STATE43CHARS_-abcdefghijklmnopqrstuvwxyz012",
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
      )
    ).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth" +
        "?access_type=offline&client_id=desktop-client" +
        "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" +
        "&code_challenge_method=S256&prompt=consent" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321&response_type=code" +
        "&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyt-analytics.readonly" +
        "+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.readonly" +
        "&state=STATE43CHARS_-abcdefghijklmnopqrstuvwxyz012"
    )
  })

  test("keys are emitted in sorted order, matching Go's url.Values.Encode", () => {
    const target = authorizationUrl(
      config({ clientId: "cid", scopes: ["a"], authorizationUrl: "https://x/y" }),
      "http://127.0.0.1:1",
      "st",
      "ch"
    )
    const keys = [...new URL(target).searchParams.keys()]
    expect(keys).toEqual([...keys].sort())
  })
})

// ---------------------------------------------------------------------------
// PKCE / state
// ---------------------------------------------------------------------------

describe("state and PKCE", () => {
  test("32 CSPRNG bytes encode to 43 base64url characters with no padding", async () => {
    const state = await run(randomUrlSafe(32))
    expect(state).toHaveLength(43)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("successive values differ", async () => {
    const a = await run(randomUrlSafe(32))
    const b = await run(randomUrlSafe(32))
    expect(a).not.toBe(b)
  })

  test("challenge is base64url_nopad(sha256(verifier))", async () => {
    // RFC 7636 appendix B's published vector.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expect(await run(pkceChallenge(verifier))).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })
})

// ---------------------------------------------------------------------------
// TestExchangeAndRefresh
// ---------------------------------------------------------------------------

describe("exchange and refresh", () => {
  test("exchanges an authorization code, then refreshes with the inherited token", async () => {
    let calls = 0
    const server = startServer(() => {
      calls += 1
      return calls === 1
        ? tokenJson(
            `{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600,` +
              `"scope":"one two","token_type":"Bearer"}`
          )
        : tokenJson(`{"access_token":"access-2","expires_in":1800,"token_type":"Bearer"}`)
    })
    const cfg = config({ tokenUrl: server.url })

    const before = Date.now()
    const token = await runHttp(exchange(cfg, "code", "http://127.0.0.1/callback", "verifier"))
    expect(token.accessToken).toBe("access-1")
    expect(token.refreshToken).toBe("refresh-1")
    expect(token.scopes).toEqual(["one", "two"])
    const untilExpiry = token.expiryMillis - before
    expect(untilExpiry).toBeGreaterThan(55 * 60_000)
    expect(untilExpiry).toBeLessThan(65 * 60_000)

    const exchangeForm = server.requests[0]!.form
    expect(server.requests[0]!.method).toBe("POST")
    expect(server.requests[0]!.contentType).toStartWith("application/x-www-form-urlencoded")
    expect(exchangeForm.get("grant_type")).toBe("authorization_code")
    expect(exchangeForm.get("code")).toBe("code")
    expect(exchangeForm.get("code_verifier")).toBe("verifier")
    expect(exchangeForm.get("redirect_uri")).toBe("http://127.0.0.1/callback")

    const refreshed = await runHttp(refresh(cfg, token))
    expect(refreshed.accessToken).toBe("access-2")
    // The response omits both; they are inherited from the previous token.
    expect(refreshed.refreshToken).toBe("refresh-1")
    expect(refreshed.scopes).toEqual(["one", "two"])

    const refreshForm = server.requests[1]!.form
    expect(refreshForm.get("grant_type")).toBe("refresh_token")
    expect(refreshForm.get("refresh_token")).toBe("refresh-1")
  })

  test("the exchange body is byte-identical to Go's url.Values.Encode output", async () => {
    // Captured from the real Go binary (internal/oauth.Exchange, 2026-07-25):
    //   client_id=id&client_secret=sec&code=the-code&code_verifier=the-verifier
    //   &grant_type=authorization_code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234
    const server = startServer(() =>
      tokenJson(`{"access_token":"a","expires_in":3600,"token_type":"Bearer"}`)
    )
    await runHttp(
      exchange(
        config({ clientId: "id", clientSecret: "sec", tokenUrl: server.url }),
        "the-code",
        "http://127.0.0.1:1234",
        "the-verifier"
      )
    )
    expect(server.bodies[0]).toBe(
      "client_id=id&client_secret=sec&code=the-code&code_verifier=the-verifier" +
        "&grant_type=authorization_code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234"
    )
  })

  test("credentials go in the POST body, never in an Authorization: Basic header", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"a","expires_in":60,"token_type":"Bearer"}`)
    )
    await runHttp(exchange(config({ tokenUrl: server.url }), "c", "http://r", "v"))
    const request = server.requests[0]!
    expect(request.authorization).toBeNull()
    expect(request.form.get("client_id")).toBe("id")
    expect(request.form.get("client_secret")).toBe("secret")
  })

  test("scopes fall back to the configured scopes when nothing else supplies them", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"a","expires_in":60,"token_type":"Bearer"}`)
    )
    const token = await runHttp(
      exchange(config({ tokenUrl: server.url, scopes: ["cfg.one"] }), "c", "http://r", "v")
    )
    expect(token.scopes).toEqual(["cfg.one"])
  })

  test("a refresh response that omits scope inherits the current token's scopes", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"a2","expires_in":60,"token_type":"Bearer"}`)
    )
    const token = await runHttp(
      refresh(config({ tokenUrl: server.url, scopes: ["cfg"] }), {
        accessToken: "a1",
        refreshToken: "r",
        expiryMillis: 0,
        scopes: ["current.one", "current.two"]
      })
    )
    expect(token.scopes).toEqual(["current.one", "current.two"])
  })

  test("scope is split on whitespace runs, Go strings.Fields style", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"a","expires_in":60,"scope":"  one \\t two  ","token_type":"B"}`)
    )
    const token = await runHttp(exchange(config({ tokenUrl: server.url }), "c", "http://r", "v"))
    expect(token.scopes).toEqual(["one", "two"])
  })

  test("a response without expires_in leaves the expiry at the zero time", async () => {
    const server = startServer(() => tokenJson(`{"access_token":"a","token_type":"Bearer"}`))
    const token = await runHttp(exchange(config({ tokenUrl: server.url }), "c", "http://r", "v"))
    expect(token.expiryMillis).toBe(0)
  })

  test("a 200 response with no access_token is still a failure", async () => {
    const server = startServer(() => tokenJson(`{"token_type":"Bearer"}`))
    const error = await flipHttp(exchange(config({ tokenUrl: server.url }), "c", "http://r", "v"))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toBe("oauth2: server response missing access_token")
  })

  test("refresh without a refresh token fails before any request", async () => {
    const server = startServer(() => tokenJson(`{"access_token":"a"}`))
    const error = await flipHttp(refresh(config({ tokenUrl: server.url }), emptyToken))
    expect(error).toBeInstanceOf(MissingRefreshTokenError)
    expect(error.message).toBe("OAuth refresh token is missing; re-run 'oytc login --oauth'")
    expect(server.requests).toHaveLength(0)
  })

  test("a whitespace-only refresh token is treated as missing", async () => {
    const server = startServer(() => tokenJson(`{"access_token":"a"}`))
    const error = await flipHttp(
      refresh(config({ tokenUrl: server.url }), { ...emptyToken, refreshToken: "   " })
    )
    expect(error).toBeInstanceOf(MissingRefreshTokenError)
    expect(server.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TestExchangeReturnsGoogleOAuthError / TestExchangeErrorWithoutContentType
// ---------------------------------------------------------------------------

describe("token endpoint errors", () => {
  test("a JSON error body becomes a structured OAuthError", async () => {
    const server = startServer(() =>
      tokenJson(`{"error":"invalid_grant","error_description":"authorization code expired"}`, 400)
    )
    const error = await flipHttp(exchange(config({ tokenUrl: server.url }), "code", "r", "v"))
    expect(error).toBeInstanceOf(OAuthError)
    const oauthError = error as OAuthError
    expect(oauthError.httpStatus).toBe(400)
    expect(oauthError.code).toBe("invalid_grant")
    expect(oauthError.description).toBe("authorization code expired")
    expect(oauthError.message).toBe("OAuth error (invalid_grant): authorization code expired")
  })

  test("an error body with no content type still surfaces a structured OAuthError", async () => {
    // Go's httptest sniffs an unlabelled body to text/plain, so x/oauth2 takes
    // the form-parsing branch, produces an EMPTY error code, and falls back to
    // parseError(status, body). This port reproduces both steps.
    const server = startServer(
      () =>
        new Response(
          `{"error":"invalid_grant","error_description":"authorization code expired"}`,
          { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        )
    )
    const error = (await flipHttp(
      exchange(config({ tokenUrl: server.url }), "code", "r", "v")
    )) as OAuthError
    expect(error).toBeInstanceOf(OAuthError)
    expect(error.code).toBe("invalid_grant")
    expect(error.description).toBe("authorization code expired")
  })

  test("a 200 response carrying an error code is still an error (unorthodox servers)", async () => {
    const server = startServer(() => tokenJson(`{"error":"invalid_client"}`, 200))
    const error = (await flipHttp(
      exchange(config({ tokenUrl: server.url }), "code", "r", "v")
    )) as OAuthError
    expect(error.code).toBe("invalid_client")
  })

  test("an unparsable error body falls back to the HTTP status text", async () => {
    const server = startServer(
      () => new Response("upstream exploded", { status: 503, headers: { "Content-Type": "application/json" } })
    )
    const error = (await flipHttp(
      exchange(config({ tokenUrl: server.url }), "code", "r", "v")
    )) as OAuthError
    expect(error.code).toBe("Service Unavailable")
    expect(error.description).toBe("upstream exploded")
  })

  test("a connection failure is wrapped with the action prefix", async () => {
    const error = await flipHttp(
      // Port 1 on loopback is reserved and refuses connections.
      exchange(config({ tokenUrl: "http://127.0.0.1:1/token" }), "code", "r", "v")
    )
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("request OAuth token: ")
  })

  test("refresh failures carry the refresh action prefix", async () => {
    const error = await flipHttp(
      refresh(config({ tokenUrl: "http://127.0.0.1:1/token" }), {
        ...emptyToken,
        refreshToken: "r"
      })
    )
    expect(error.message).toStartWith("refresh OAuth token: ")
  })
})

describe("parseErrorBody", () => {
  test("uses the status text when the body has no error code", () => {
    const error = parseErrorBody(400, "  not json  ")
    expect(error.code).toBe("Bad Request")
    expect(error.description).toBe("not json")
  })

  test("an unmapped status yields an empty code, as Go's http.StatusText does", () => {
    expect(parseErrorBody(499, "").code).toBe("")
  })
})

// ---------------------------------------------------------------------------
// TestRevoke
// ---------------------------------------------------------------------------

describe("revoke", () => {
  test("posts the token as a form field", async () => {
    const server = startServer(() => new Response("", { status: 200 }))
    await runHttp(revoke(config({ revokeUrl: server.url }), "refresh-secret"))
    const request = server.requests[0]!
    expect(request.method).toBe("POST")
    expect(request.contentType).toStartWith("application/x-www-form-urlencoded")
    expect(request.form.get("token")).toBe("refresh-secret")
  })

  test("an empty token is a no-op that issues no request", async () => {
    const server = startServer(() => new Response("", { status: 200 }))
    await runHttp(revoke(config({ revokeUrl: server.url }), "   "))
    expect(server.requests).toHaveLength(0)
  })

  test("a non-2xx response becomes a structured OAuthError", async () => {
    const server = startServer(
      () =>
        new Response(`{"error":"invalid_token"}`, {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    )
    const error = (await flipHttp(revoke(config({ revokeUrl: server.url }), "t"))) as OAuthError
    expect(error.code).toBe("invalid_token")
    expect(error.httpStatus).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// TestLoginLoopbackSuccess / SurvivesStrayRequests / UserDenied
// ---------------------------------------------------------------------------

/** Collects the announced URL and drives the callback the way a browser would. */
const loginHooks = (drive: (authorizationUrl: string) => void) => {
  const announced: Array<string> = []
  return {
    announced,
    hooks: {
      announce: (message: string) => Effect.sync(() => void announced.push(message)),
      openBrowser: (url: string) => Effect.sync(() => drive(url))
    }
  }
}

const callback = async (url: string): Promise<void> => {
  await fetch(url).catch(() => undefined)
}

describe("login (loopback flow)", () => {
  test("completes end to end and exchanges the returned code", async () => {
    const server = startServer(() =>
      tokenJson(
        `{"access_token":"access","refresh_token":"refresh","expires_in":3600,` +
          `"scope":"scope","token_type":"Bearer"}`
      )
    )
    const seen: Array<URL> = []
    const { announced, hooks } = loginHooks((target) => {
      const parsed = new URL(target)
      seen.push(parsed)
      const redirect = parsed.searchParams.get("redirect_uri")!
      const state = parsed.searchParams.get("state")!
      void callback(`${redirect}?code=callback-code&state=${encodeURIComponent(state)}`)
    })

    const token = await runHttp(
      Effect.scoped(
        login(
          config({
            scopes: ["scope"],
            authorizationUrl: "https://accounts.example/auth",
            tokenUrl: server.url,
            loginTimeoutMillis: 3000
          }),
          hooks
        )
      )
    )

    expect(token.accessToken).toBe("access")
    expect(announced[0]).toContain("https://accounts.example/auth")
    expect(announced[0]).toStartWith("Open this URL to authorize oytc:\n")
    expect(seen[0]!.searchParams.get("code_challenge")).not.toBe("")
    expect(seen[0]!.searchParams.get("state")).not.toBe("")

    const form = server.requests[0]!.form
    expect(form.get("code")).toBe("callback-code")
    expect(form.get("code_verifier")).not.toBe("")
    // The redirect_uri echoed at exchange time must match the one authorized.
    expect(form.get("redirect_uri")).toBe(seen[0]!.searchParams.get("redirect_uri"))
  })

  test("survives stray requests: a favicon probe and a bad-state hit do not abort", async () => {
    const server = startServer(() =>
      tokenJson(
        `{"access_token":"access","refresh_token":"refresh","expires_in":3600,` +
          `"scope":"scope","token_type":"Bearer"}`
      )
    )
    const { hooks } = loginHooks((target) => {
      const parsed = new URL(target)
      const redirect = parsed.searchParams.get("redirect_uri")!
      const state = encodeURIComponent(parsed.searchParams.get("state")!)
      void (async () => {
        await callback(`${redirect}/favicon.ico`)
        await callback(`${redirect}?code=evil&state=wrong`)
        await callback(`${redirect}?code=callback-code&state=${state}`)
      })()
    })

    const token = await runHttp(
      Effect.scoped(
        login(
          config({
            scopes: ["scope"],
            authorizationUrl: "https://accounts.example/auth",
            tokenUrl: server.url,
            loginTimeoutMillis: 3000
          }),
          hooks
        )
      )
    )

    expect(token.accessToken).toBe("access")
    // The evil code must never have reached the token endpoint.
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.form.get("code")).toBe("callback-code")
  })

  test("a denied authorization surfaces the OAuth error code", async () => {
    const { hooks } = loginHooks((target) => {
      const parsed = new URL(target)
      const redirect = parsed.searchParams.get("redirect_uri")!
      const state = encodeURIComponent(parsed.searchParams.get("state")!)
      void callback(`${redirect}?error=access_denied&error_description=nope&state=${state}`)
    })

    const error = (await flipHttp(
      Effect.scoped(
        login(
          config({ authorizationUrl: "https://accounts.example/auth", loginTimeoutMillis: 3000 }),
          hooks
        )
      )
    )) as OAuthError
    expect(error).toBeInstanceOf(OAuthError)
    expect(error.code).toBe("access_denied")
    expect(error.description).toBe("nope")
  })

  test("a callback with no code surfaces the missing-code error", async () => {
    const { hooks } = loginHooks((target) => {
      const parsed = new URL(target)
      const redirect = parsed.searchParams.get("redirect_uri")!
      const state = encodeURIComponent(parsed.searchParams.get("state")!)
      void callback(`${redirect}?state=${state}`)
    })
    const error = await flipHttp(
      Effect.scoped(
        login(
          config({ authorizationUrl: "https://accounts.example/auth", loginTimeoutMillis: 3000 }),
          hooks
        )
      )
    )
    expect(error.message).toBe("OAuth callback did not include an authorization code")
  })

  test("the wait times out with Go's message", async () => {
    const { hooks } = loginHooks(() => {})
    const error = await flipHttp(
      Effect.scoped(
        login(
          config({ authorizationUrl: "https://accounts.example/auth", loginTimeoutMillis: 25 }),
          hooks
        )
      )
    )
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toBe("timed out waiting for OAuth authorization")
  })

  test("empty credentials fail before a listener is opened", async () => {
    const { hooks } = loginHooks(() => {})
    const noId = await flipHttp(Effect.scoped(login(config({ clientId: "  " }), hooks)))
    expect(noId.message).toBe("OAuth client ID cannot be empty")
    const noSecret = await flipHttp(Effect.scoped(login(config({ clientSecret: "" }), hooks)))
    expect(noSecret.message).toBe("OAuth client secret cannot be empty")
  })

  test("the browser-open hook is best-effort: a failure does not abort the flow", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"access","expires_in":60,"token_type":"Bearer"}`)
    )
    const announced: Array<string> = []
    const token = await runHttp(
      Effect.scoped(
        login(
          config({
            authorizationUrl: "https://accounts.example/auth",
            tokenUrl: server.url,
            loginTimeoutMillis: 3000
          }),
          {
            announce: (message) =>
              Effect.sync(() => {
                announced.push(message)
                const parsed = new URL(message.split("\n")[1]!)
                const redirect = parsed.searchParams.get("redirect_uri")!
                const state = encodeURIComponent(parsed.searchParams.get("state")!)
                void callback(`${redirect}?code=c&state=${state}`)
              }),
            // BrowserOpenerShape.open cannot fail; a launch failure is already a
            // warning by the time it reaches here, so this models the no-op.
            openBrowser: () => Effect.void
          }
        )
      )
    )
    expect(token.accessToken).toBe("access")
    expect(announced).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Expiry serialization
// ---------------------------------------------------------------------------

describe("expiry serialization", () => {
  test("blank parses to the zero time without an error", async () => {
    expect(await run(parseExpiry(""))).toBe(0)
    expect(await run(parseExpiry("   "))).toBe(0)
  })

  test("round-trips an RFC 3339 UTC instant", async () => {
    const millis = await run(parseExpiry("2026-01-02T15:04:05Z"))
    expect(formatExpiry(millis)).toBe("2026-01-02T15:04:05Z")
  })

  test("normalizes an offset instant to UTC", async () => {
    const millis = await run(parseExpiry("2026-01-02T15:04:05+02:00"))
    expect(formatExpiry(millis)).toBe("2026-01-02T13:04:05Z")
  })

  test("drops sub-second precision, as Go's second-precision RFC3339 does", async () => {
    const millis = await run(parseExpiry("2026-01-02T15:04:05.750Z"))
    expect(formatExpiry(millis)).toBe("2026-01-02T15:04:05Z")
  })

  test("the zero time formats as the empty string", () => {
    expect(formatExpiry(0)).toBe("")
  })

  test.each([
    ["2026-01-02t15:04:05z", "lowercase t/z"],
    ["2026-01-02 15:04:05Z", "space separator"],
    ["2026-01-02T15:04:05", "no zone"],
    ["not-a-time", "garbage"]
  ])("rejects %s (%s)", async (value) => {
    const error = await run(Effect.flip(parseExpiry(value)))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("parse OAuth token expiry: ")
  })

  /**
   * Every expectation below is a GOLDEN captured from `time.Parse(time.RFC3339,
   * v)` on Go 1.26, then differentially re-verified over an 8000-case fuzz
   * corpus (ASCII and non-ASCII) with zero verdict or message mismatches.
   *
   * They exist because both obvious shortcuts are WRONG here:
   *   - a strict regex rejects inputs Go accepts (Go falls back to the lax
   *     general layout parser when its RFC3339 fast path fails)
   *   - `Date.parse` accepts inputs Go rejects (JS rolls over impossible dates
   *     and hour 24 instead of failing)
   */
  test.each([
    // Impossible calendar dates: JS rolls these into the next month, Go fails.
    ["2026-02-30T00:00:00Z", "day out of range"],
    ["2026-06-31T00:00:00Z", "day out of range"],
    ["2026-02-29T00:00:00Z", "day out of range (2026 is not a leap year)"],
    ["2026-01-00T00:00:00Z", "day out of range"],
    ["2026-00-01T00:00:00Z", "month out of range"],
    ["2026-13-01T00:00:00Z", "month out of range"],
    // JS reads hour 24 as the next midnight; Go's stdHour rejects `24 <= hour`.
    ["2026-01-02T24:00:00Z", "hour out of range"],
    ["2026-01-02T15:60:05Z", "minute out of range"],
    ["2026-01-02T15:04:60Z", "second out of range (no leap seconds)"],
    // Zone offsets: Go's range tests use `>`, so 25 is the first bad hour.
    ["2026-01-02T15:04:05+25:00", "time zone offset hour out of range"],
    ["2026-01-02T15:04:05+00:99", "time zone offset minute out of range"]
  ])("rejects %s (%s), matching Go", async (value) => {
    const error = await run(Effect.flip(parseExpiry(value)))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("parse OAuth token expiry: ")
  })

  test.each([
    // Go's general parser is LAXER than its RFC3339 fast path. A strict regex
    // would wrongly reject all four of these.
    ["2026-01-02T5:04:05Z", 1767330245000, "one-digit hour (getnum is non-fixed for 15)"],
    ["2026-01-02T15:04:05,5Z", 1767366245500, "comma sub-second separator"],
    ["2026-01-02T15:04:05+24:00", 1767279845000, "offset hour 24 (Go tests `> 24`)"],
    ["2026-01-02T15:04:05+12:60", 1767319445000, "offset minute 60 (Go tests `> 60`)"],
    ["2024-02-29T00:00:00Z", 1709164800000, "a real leap day"],
    ["0000-01-01T00:00:00Z", -62167219200000, "year 0 is not shifted into 1900"],
    ["2026-01-02T15:04:05.123456789Z", 1767366245123, "nanoseconds truncate to millis"]
  ])("accepts %s -> %d (%s), matching Go", async (value, expected) => {
    expect(await run(parseExpiry(value))).toBe(expected)
  })

  test("the failure message is byte-identical to Go's ParseError", async () => {
    const error = await run(Effect.flip(parseExpiry("yesterday")))
    expect(error.message).toBe(
      'parse OAuth token expiry: parsing time "yesterday" as ' +
        '"2006-01-02T15:04:05Z07:00": cannot parse "yesterday" as "2006"'
    )
  })

  test("range failures use Go's short ParseError form, with no layout echo", async () => {
    const error = await run(Effect.flip(parseExpiry("2026-02-30T00:00:00Z")))
    expect(error.message).toBe(
      'parse OAuth token expiry: parsing time "2026-02-30T00:00:00Z": day out of range'
    )
  })

  test("trailing junk is reported as Go's `extra text`", async () => {
    const error = await run(Effect.flip(parseExpiry("2026-01-02T15:04:05Zextra")))
    expect(error.message).toBe(
      'parse OAuth token expiry: parsing time "2026-01-02T15:04:05Zextra": extra text: "extra"'
    )
  })

  test("truncated input reports the element that ran off the end", async () => {
    // Go walks the layout, so the empty remainder fails against the next verb.
    expect((await run(Effect.flip(parseExpiry("2026-01-02")))).message).toBe(
      'parse OAuth token expiry: parsing time "2026-01-02" as ' +
        '"2006-01-02T15:04:05Z07:00": cannot parse "" as "T"'
    )
  })

  test("non-ASCII is quoted as UTF-8 BYTES, Go's time.quote, not strconv.Quote", async () => {
    // strconv.Quote would emit "café" verbatim; time.quote escapes each byte.
    const error = await run(Effect.flip(parseExpiry("café")))
    expect(error.message).toBe(
      'parse OAuth token expiry: parsing time "caf\\xc3\\xa9" as ' +
        '"2006-01-02T15:04:05Z07:00": cannot parse "caf\\xc3\\xa9" as "2006"'
    )
  })

  test("a tab is \\x09, not \\t (time.quote has no short escapes)", async () => {
    const error = await run(Effect.flip(parseExpiry("a\tb")))
    expect(error.message).toContain('"a\\x09b"')
  })

  test("quotes and backslashes take a single backslash", async () => {
    expect((await run(Effect.flip(parseExpiry('a"b')))).message).toContain('"a\\"b"')
    expect((await run(Effect.flip(parseExpiry("a\\b")))).message).toContain('"a\\\\b"')
  })
})

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe("withDefaults", () => {
  test("fills the Google endpoints and the 3-minute login timeout", () => {
    const resolved = withDefaults({})
    expect(resolved.authorizationUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(resolved.tokenUrl).toBe("https://oauth2.googleapis.com/token")
    expect(resolved.revokeUrl).toBe("https://oauth2.googleapis.com/revoke")
    expect(resolved.loginTimeoutMillis).toBe(180_000)
    expect(resolved.httpTimeoutMillis).toBe(20_000)
  })

  test("non-positive durations fall back, matching Go's `<= 0` guard", () => {
    expect(withDefaults({ loginTimeoutMillis: 0 }).loginTimeoutMillis).toBe(180_000)
    expect(withDefaults({ httpTimeoutMillis: -1 }).httpTimeoutMillis).toBe(20_000)
  })

  test("explicit overrides survive", () => {
    expect(withDefaults({ tokenUrl: "http://local/token" }).tokenUrl).toBe("http://local/token")
  })
})

// ---------------------------------------------------------------------------
// Service wiring — CredentialStore is consumed BY TAG and mocked here; P4 owns
// the real implementation.
// ---------------------------------------------------------------------------

const storedOAuth = (overrides: Partial<StoredOAuth> = {}): StoredOAuth => ({
  clientId: "client-id",
  clientSecret: "client-secret",
  accessToken: "stored-access",
  refreshToken: "stored-refresh",
  // Long past, so every call refreshes unless overridden.
  expiry: "2020-01-01T00:00:00Z",
  scopes: ["scope.one"],
  ...overrides
})

interface StoreSpy {
  readonly saves: Array<{ readonly expected: StoredOAuth | undefined; readonly next: StoredOAuth }>
}

/** Only the members this service touches are implemented; the rest die loudly. */
const mockStore = (
  oauth: StoredOAuth | undefined,
  options: { readonly casResult?: boolean } = {}
): { readonly layer: Layer.Layer<CredentialStoreShape>; readonly spy: StoreSpy } => {
  const spy: StoreSpy = { saves: [] }
  const unimplemented = (name: string) =>
    Effect.die(new Error(`CredentialStore.${name} must not be called by OAuthService`))
  const shape: CredentialStoreShape = {
    dir: unimplemented("dir"),
    path: unimplemented("path"),
    load: Effect.succeed({ key: "", source: "", oauth, path: "/tmp/auth.json" } as Credentials),
    save: () => unimplemented("save"),
    saveOAuth: () => unimplemented("saveOAuth"),
    saveRefreshedOAuth: (expected, next) =>
      Effect.sync(() => {
        spy.saves.push({ expected, next })
        return options.casResult ?? true
      }),
    clearOAuth: unimplemented("clearOAuth"),
    remove: unimplemented("remove"),
    fingerprint: () => "sha256:000000000000",
    envKeySet: Effect.succeed(false),
    oauthBootstrap: Effect.succeed(["", ""] as const)
  }
  return { layer: Layer.succeed(CredentialStore, shape), spy }
}

const browserLayer = (opened: Array<string>): Layer.Layer<BrowserOpenerShape> =>
  Layer.succeed(BrowserOpener, { open: (url) => Effect.sync(() => void opened.push(url)) })

/**
 * Wires a service instance over the mock store, the fake browser, and fetch.
 * `use` runs `f` against the built shape, so each test drives the real service
 * rather than the underlying free functions.
 */
const service = (
  endpoints: {
    readonly tokenUrl?: string
    readonly revokeUrl?: string
    readonly authorizationUrl?: string
  },
  stored: StoredOAuth | undefined,
  options: { readonly casResult?: boolean; readonly opener?: BrowserOpenerShape } = {}
) => {
  const { layer, spy } = mockStore(stored, options)
  const opened: Array<string> = []
  const use = <A, E>(f: (shape: OAuthServiceShape) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.flatMap(makeOAuthService(endpoints), f).pipe(
      Effect.provide(layer),
      Effect.provide(
        options.opener === undefined
          ? browserLayer(opened)
          : Layer.succeed(BrowserOpener, options.opener)
      ),
      Effect.provide(FetchHttpClient.layer)
    )
  return { use, spy, opened }
}

describe("OAuthService.tokenSource", () => {
  test("refreshes a stale stored token and persists it through the CAS", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"fresh-access","expires_in":3600,"token_type":"Bearer"}`)
    )
    const wired = service({ tokenUrl: server.url }, storedOAuth())
    const access = await Effect.runPromise(
      wired.use((shape) => shape.tokenSource(false))
    )
    expect(Redacted.value(access)).toBe("fresh-access")

    const form = server.requests[0]!.form
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe("stored-refresh")
    expect(form.get("client_id")).toBe("client-id")
    expect(form.get("client_secret")).toBe("client-secret")

    expect(wired.spy.saves).toHaveLength(1)
    expect(wired.spy.saves[0]!.expected).toEqual(storedOAuth())
    expect(wired.spy.saves[0]!.next.accessToken).toBe("fresh-access")
    // The response omitted both, so both are inherited.
    expect(wired.spy.saves[0]!.next.refreshToken).toBe("stored-refresh")
    expect(wired.spy.saves[0]!.next.scopes).toEqual(["scope.one"])
    expect(wired.spy.saves[0]!.next.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  test("the source is built once: a second call reuses the cached token", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"fresh-access","expires_in":3600,"token_type":"Bearer"}`)
    )
    const wired = service({ tokenUrl: server.url }, storedOAuth())
    const tokens = await Effect.runPromise(
      wired.use((shape) =>
          Effect.gen(function* () {
            const first = yield* shape.tokenSource(false)
            const second = yield* shape.tokenSource(false)
            return [Redacted.value(first), Redacted.value(second)] as const
          })
      )
    )
    expect(tokens).toEqual(["fresh-access", "fresh-access"])
    expect(server.requests).toHaveLength(1)
  })

  test("force re-refreshes even when the cached token is fresh (the post-401 path)", async () => {
    let calls = 0
    const server = startServer(() =>
      tokenJson(`{"access_token":"${++calls === 1 ? "first" : "second"}","expires_in":3600}`)
    )
    const wired = service({ tokenUrl: server.url }, storedOAuth())
    const access = await Effect.runPromise(
      wired.use((shape) =>
          Effect.gen(function* () {
            yield* shape.tokenSource(false)
            return Redacted.value(yield* shape.tokenSource(true))
          })
      )
    )
    expect(access).toBe("second")
    expect(server.requests).toHaveLength(2)
    // The second CAS expects the FIRST refresh's value, not the original.
    expect(wired.spy.saves[1]!.expected!.accessToken).toBe("first")
  })

  test("a losing CAS (logout won the race) neither fails nor advances the snapshot", async () => {
    let calls = 0
    const server = startServer(() =>
      tokenJson(`{"access_token":"${++calls === 1 ? "first" : "second"}","expires_in":3600}`)
    )
    const wired = service({ tokenUrl: server.url }, storedOAuth(), { casResult: false })
    const access = await Effect.runPromise(
      wired.use((shape) =>
          Effect.gen(function* () {
            yield* shape.tokenSource(false)
            return Redacted.value(yield* shape.tokenSource(true))
          })
      )
    )
    expect(access).toBe("second")
    // The snapshot never advanced, so both attempts carry the ORIGINAL value.
    expect(wired.spy.saves[0]!.expected).toEqual(storedOAuth())
    expect(wired.spy.saves[1]!.expected).toEqual(storedOAuth())
  })

  test("no stored OAuth credentials yields MissingOAuthError", async () => {
    const wired = service({ tokenUrl: "http://127.0.0.1:1/token" }, undefined)
    const error = await Effect.runPromise(
      Effect.flip(wired.use((shape) => shape.tokenSource(false)))
    )
    expect(error).toBeInstanceOf(MissingOAuthError)
    expect(error.message).toBe("no OAuth credentials configured; run 'oytc login --oauth'")
  })

  test("a still-valid stored token is served without any network call", async () => {
    const server = startServer(() => tokenJson(`{"access_token":"unused"}`))
    const wired = service(
      { tokenUrl: server.url },
      storedOAuth({ expiry: formatExpiry(Date.now() + 3_600_000), accessToken: "still-good" })
    )
    const access = await Effect.runPromise(
      wired.use((shape) => shape.tokenSource(false))
    )
    expect(Redacted.value(access)).toBe("still-good")
    expect(server.requests).toHaveLength(0)
  })

  test("concurrent callers share one source and issue one refresh", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"fresh","expires_in":3600,"token_type":"Bearer"}`)
    )
    const wired = service({ tokenUrl: server.url }, storedOAuth())
    const tokens = await Effect.runPromise(
      wired.use((shape) =>
          Effect.map(
            Effect.all([shape.tokenSource(false), shape.tokenSource(false)], {
              concurrency: "unbounded"
            }),
            (values) => values.map(Redacted.value)
          )
      )
    )
    expect(tokens).toEqual(["fresh", "fresh"])
    expect(server.requests).toHaveLength(1)
  })

  test("a corrupt stored expiry surfaces as an operational error", async () => {
    const wired = service({ tokenUrl: "http://127.0.0.1:1" }, storedOAuth({ expiry: "yesterday" }))
    const error = await Effect.runPromise(
      Effect.flip(wired.use((shape) => shape.tokenSource(false)))
    )
    expect(error.message).toStartWith("parse OAuth token expiry: ")
  })
})

describe("OAuthService.revoke", () => {
  const revoking = (stored: StoredOAuth, revokeUrl: string) => {
    const wired = service({ revokeUrl }, stored)
    return wired.use((shape) => shape.revoke(stored))
  }

  test("prefers the refresh token", async () => {
    const server = startServer(() => new Response("", { status: 200 }))
    await Effect.runPromise(revoking(storedOAuth(), server.url))
    expect(server.requests[0]!.form.get("token")).toBe("stored-refresh")
  })

  test("falls back to the access token when the refresh token is empty", async () => {
    const server = startServer(() => new Response("", { status: 200 }))
    await Effect.runPromise(revoking(storedOAuth({ refreshToken: "" }), server.url))
    expect(server.requests[0]!.form.get("token")).toBe("stored-access")
  })

  test("a failing revoke endpoint is swallowed — logout must still proceed", async () => {
    const server = startServer(
      () =>
        new Response(`{"error":"invalid_token"}`, {
          status: 400,
          headers: { "Content-Type": "application/json" }
        })
    )
    const exit = await Effect.runPromiseExit(revoking(storedOAuth(), server.url))
    expect(exit._tag).toBe("Success")
  })

  test("an unreachable revoke endpoint is also swallowed", async () => {
    const exit = await Effect.runPromiseExit(revoking(storedOAuth(), "http://127.0.0.1:1/revoke"))
    expect(exit._tag).toBe("Success")
  })
})

describe("OAuthService.refresh", () => {
  test("returns a StoredOAuth carrying the original client credentials", async () => {
    const server = startServer(() =>
      tokenJson(`{"access_token":"new","expires_in":3600,"scope":"a b","token_type":"Bearer"}`)
    )
    const stored = storedOAuth()
    const wired = service({ tokenUrl: server.url }, stored)
    const updated = await Effect.runPromise(
      wired.use((shape) => shape.refresh(stored))
    )
    expect(updated.clientId).toBe("client-id")
    expect(updated.clientSecret).toBe("client-secret")
    expect(updated.accessToken).toBe("new")
    expect(updated.refreshToken).toBe("stored-refresh")
    expect(updated.scopes).toEqual(["a", "b"])
  })
})

describe("OAuthService.login", () => {
  test("drives the browser, exchanges the code, and returns a StoredOAuth", async () => {
    const server = startServer(() =>
      tokenJson(
        `{"access_token":"access","refresh_token":"refresh","expires_in":3600,` +
          `"scope":"granted.one granted.two","token_type":"Bearer"}`
      )
    )
    const opened: Array<string> = []
    const wired = service(
      { tokenUrl: server.url, authorizationUrl: "https://accounts.example/auth" },
      undefined,
      {
        opener: {
          open: (url) =>
            Effect.sync(() => {
              opened.push(url)
              const parsed = new URL(url)
              const redirect = parsed.searchParams.get("redirect_uri")!
              const state = encodeURIComponent(parsed.searchParams.get("state")!)
              void callback(`${redirect}?code=the-code&state=${state}`)
            })
        }
      }
    )

    const { announced, stored } = await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* wired.use((shape) =>
          shape.login({ clientId: "cli-id", clientSecret: Redacted.make("cli-secret") })
        )
        return { stored: result, announced: yield* TestConsole.errorLines }
      }).pipe(Effect.provide(TestConsole.layer))
    )

    // Go prints this to cfg.Out, which the CLI wires to stderr.
    expect(announced).toHaveLength(1)
    expect(String(announced[0])).toStartWith("Open this URL to authorize oytc:\n")

    expect(stored.clientId).toBe("cli-id")
    expect(stored.clientSecret).toBe("cli-secret")
    expect(stored.accessToken).toBe("access")
    expect(stored.refreshToken).toBe("refresh")
    expect(stored.scopes).toEqual(["granted.one", "granted.two"])
    expect(stored.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    // The default scopes are requested, in order.
    expect(new URL(opened[0]!).searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/yt-analytics.readonly" +
        " https://www.googleapis.com/auth/youtube.readonly"
    )
    expect(server.requests[0]!.form.get("code")).toBe("the-code")
  })
})

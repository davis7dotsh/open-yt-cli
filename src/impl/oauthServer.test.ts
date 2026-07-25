import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import {
  acquireLoopbackServer,
  MISSING_CODE_BODY,
  MISSING_CODE_MESSAGE,
  NOT_GRANTED_BODY,
  STATE_MISMATCH_BODY,
  SUCCESS_BODY
} from "./oauthServer.ts"
import { OAuthError, OperationalError } from "../domain/errors.ts"

const STATE = "state-value"

/**
 * Runs `body` with a live loopback server, tearing it down afterwards. The
 * whole thing is scoped so a failing assertion still releases the port.
 */
const withServer = <A>(
  body: (server: {
    readonly redirectUri: string
    readonly awaitCode: Effect.Effect<string, OAuthError | OperationalError>
  }) => Promise<A>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* acquireLoopbackServer(STATE)
      return yield* Effect.promise(() => body(server))
    }).pipe(Effect.scoped)
  )

describe("loopback callback server", () => {
  test("redirect URI has no trailing slash and no path", () =>
    withServer(async (server) => {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    }))

  test("success responds with the byte-exact HTML page and resolves the code", () =>
    withServer(async (server) => {
      const response = await fetch(`${server.redirectUri}/?code=callback-code&state=${STATE}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(await response.text()).toBe(SUCCESS_BODY)
      expect(await Effect.runPromise(server.awaitCode)).toBe("callback-code")
    }))

  test("the handler answers on EVERY path, not just /", () =>
    withServer(async (server) => {
      const response = await fetch(`${server.redirectUri}/deep/nested/path?code=abc&state=${STATE}`)
      expect(response.status).toBe(200)
      expect(await Effect.runPromise(server.awaitCode)).toBe("abc")
    }))

  test("state mismatch responds 400 and does NOT resolve the flow", () =>
    withServer(async (server) => {
      const response = await fetch(`${server.redirectUri}/?code=evil&state=wrong`)
      expect(response.status).toBe(400)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(await response.text()).toBe(STATE_MISMATCH_BODY)

      // Still unresolved: a later, valid callback must be the one that wins.
      const pending = await Effect.runPromise(
        Effect.exit(Effect.timeout(server.awaitCode, 50))
      )
      expect(Exit.isFailure(pending)).toBe(true)

      await fetch(`${server.redirectUri}/?code=real&state=${STATE}`)
      expect(await Effect.runPromise(server.awaitCode)).toBe("real")
    }))

  test("a missing state also fails to match and keeps the flow alive", () =>
    withServer(async (server) => {
      const response = await fetch(`${server.redirectUri}/favicon.ico`)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe(STATE_MISMATCH_BODY)
      const pending = await Effect.runPromise(Effect.exit(Effect.timeout(server.awaitCode, 50)))
      expect(Exit.isFailure(pending)).toBe(true)
    }))

  test("an error param resolves the flow with a structured OAuthError", () =>
    withServer(async (server) => {
      const response = await fetch(
        `${server.redirectUri}/?error=access_denied&error_description=nope&state=${STATE}`
      )
      expect(response.status).toBe(400)
      expect(await response.text()).toBe(NOT_GRANTED_BODY)

      const error = await Effect.runPromise(Effect.flip(server.awaitCode))
      expect(error).toBeInstanceOf(OAuthError)
      expect((error as OAuthError).code).toBe("access_denied")
      expect((error as OAuthError).description).toBe("nope")
    }))

  test("a blank code resolves the flow with the missing-code error", () =>
    withServer(async (server) => {
      const response = await fetch(`${server.redirectUri}/?code=%20%20&state=${STATE}`)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe(MISSING_CODE_BODY)
      const error = await Effect.runPromise(Effect.flip(server.awaitCode))
      expect(error).toBeInstanceOf(OperationalError)
      expect(error.message).toBe(MISSING_CODE_MESSAGE)
    }))

  test("an absent code param is treated the same as a blank one", () =>
    withServer(async (server) => {
      const response = await fetch(`${server.redirectUri}/?state=${STATE}`)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe(MISSING_CODE_BODY)
      const error = await Effect.runPromise(Effect.flip(server.awaitCode))
      expect(error.message).toBe(MISSING_CODE_MESSAGE)
    }))

  test("only the FIRST resolution wins; later callbacks are ignored", () =>
    withServer(async (server) => {
      await fetch(`${server.redirectUri}/?code=first&state=${STATE}`)
      await fetch(`${server.redirectUri}/?error=access_denied&state=${STATE}`)
      await fetch(`${server.redirectUri}/?code=third&state=${STATE}`)
      expect(await Effect.runPromise(server.awaitCode)).toBe("first")
    }))

  test("the code is trimmed, matching Go's strings.TrimSpace", () =>
    withServer(async (server) => {
      await fetch(`${server.redirectUri}/?code=%20padded%20&state=${STATE}`)
      expect(await Effect.runPromise(server.awaitCode)).toBe("padded")
    }))

  test("the port is released when the scope closes", async () => {
    const uri = await Effect.runPromise(
      Effect.map(acquireLoopbackServer(STATE), (server) => server.redirectUri).pipe(Effect.scoped)
    )
    // A closed listener refuses connections rather than answering.
    const result = await fetch(`${uri}/?state=${STATE}&code=x`).then(
      () => "answered",
      () => "refused"
    )
    expect(result).toBe("refused")
  })

  test("Deferred.doneUnsafe reports false on a second completion (channel semantics)", () => {
    const deferred = Deferred.makeUnsafe<string, never>()
    expect(Deferred.doneUnsafe(deferred, Effect.succeed("a"))).toBe(true)
    expect(Deferred.doneUnsafe(deferred, Effect.succeed("b"))).toBe(false)
  })
})

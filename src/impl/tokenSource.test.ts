/**
 * Ports `TestTokenSourceRefreshAndOnUpdate` plus the skew/persistence/re-hint
 * behavior the Go code specifies but does not directly test.
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
// `effect/testing` is a stable subpath, so the src/effect.ts barrel rule does not
// apply to it (that rule covers the unstable subpath only).
import { TestClock } from "effect/testing"
import { OAuthError, OperationalError } from "../domain/errors.ts"
import { ExpiredAuthorizationError, type OAuthToken } from "./oauth.ts"
import { EXPIRY_SKEW_MILLIS, makeTokenSource } from "./tokenSource.ts"

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0)

const token = (overrides: Partial<OAuthToken> = {}): OAuthToken => ({
  accessToken: "old-access",
  refreshToken: "refresh",
  expiryMillis: NOW + 3_600_000,
  scopes: ["scope"],
  ...overrides
})

/**
 * Runs against a controlled clock pinned to NOW, so the 1-minute skew window is
 * exercised at exact boundaries rather than by sleeping.
 */
const atNow = <A, E>(effect: Effect.Effect<A, E, TestClock.TestClock>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      return yield* effect
    }).pipe(Effect.provide(TestClock.layer()))
  )

interface Recorder {
  readonly refreshes: Array<OAuthToken>
  readonly persisted: Array<OAuthToken>
}

const sourceWith = (
  options: {
    readonly token?: OAuthToken
    readonly refreshed?: OAuthToken
    readonly refreshFails?: OAuthError | OperationalError
    readonly persistFails?: OperationalError
  } = {}
) => {
  const recorder: Recorder = { refreshes: [], persisted: [] }
  const handle = makeTokenSource({
    token: options.token ?? token({ expiryMillis: NOW - 60_000 }),
    refresh: (current) =>
      Effect.gen(function* () {
        recorder.refreshes.push(current)
        if (options.refreshFails !== undefined) return yield* Effect.fail(options.refreshFails)
        return (
          options.refreshed ?? {
            accessToken: "new-access",
            refreshToken: current.refreshToken,
            expiryMillis: NOW + 3_600_000,
            scopes: current.scopes
          }
        )
      }),
    onUpdate: (updated) =>
      Effect.gen(function* () {
        if (options.persistFails !== undefined) return yield* Effect.fail(options.persistFails)
        recorder.persisted.push(updated)
      })
  })
  return { handle, recorder }
}

describe("TokenSource", () => {
  test("refreshes an expired token and persists the result before returning it", async () => {
    const { handle, recorder } = sourceWith()
    const access = await atNow(handle.accessToken(false))
    expect(access).toBe("new-access")
    expect(recorder.persisted).toHaveLength(1)
    expect(recorder.persisted[0]!.accessToken).toBe("new-access")
    expect(recorder.persisted[0]!.refreshToken).toBe("refresh")
    expect((await atNow(handle.current)).accessToken).toBe("new-access")
  })

  test("reuses a token that expires comfortably beyond the skew window", async () => {
    const { handle, recorder } = sourceWith({ token: token({ expiryMillis: NOW + 600_000 }) })
    expect(await atNow(handle.accessToken(false))).toBe("old-access")
    expect(recorder.refreshes).toHaveLength(0)
  })

  test("refreshes proactively inside the 1-minute skew window", async () => {
    // Go: reuse iff expiry > now + time.Minute. 30s out is inside the window.
    const { handle, recorder } = sourceWith({ token: token({ expiryMillis: NOW + 30_000 }) })
    expect(await atNow(handle.accessToken(false))).toBe("new-access")
    expect(recorder.refreshes).toHaveLength(1)
  })

  test("the skew boundary is strict: exactly now+1m refreshes, one millisecond later does not", async () => {
    const exactly = sourceWith({ token: token({ expiryMillis: NOW + EXPIRY_SKEW_MILLIS }) })
    expect(await atNow(exactly.handle.accessToken(false))).toBe("new-access")

    const beyond = sourceWith({ token: token({ expiryMillis: NOW + EXPIRY_SKEW_MILLIS + 1 }) })
    expect(await atNow(beyond.handle.accessToken(false))).toBe("old-access")
  })

  test("an empty cached access token forces a refresh regardless of expiry", async () => {
    const { handle, recorder } = sourceWith({
      token: token({ accessToken: "   ", expiryMillis: NOW + 3_600_000 })
    })
    expect(await atNow(handle.accessToken(false))).toBe("new-access")
    expect(recorder.refreshes).toHaveLength(1)
  })

  test("force bypasses a perfectly valid cached token (the post-401 path)", async () => {
    const { handle, recorder } = sourceWith({ token: token({ expiryMillis: NOW + 3_600_000 }) })
    expect(await atNow(handle.accessToken(true))).toBe("new-access")
    expect(recorder.refreshes).toHaveLength(1)
  })

  test("persistence failure keeps the in-memory token unchanged", async () => {
    const { handle, recorder } = sourceWith({
      persistFails: new OperationalError({ message: "disk full" })
    })
    const error = await atNow(Effect.flip(handle.accessToken(false)))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toBe("persist refreshed OAuth token: disk full")
    // The refresh happened, but memory did NOT advance past the failed write.
    expect(recorder.refreshes).toHaveLength(1)
    expect((await atNow(handle.current)).accessToken).toBe("old-access")
  })

  test.each([["invalid_grant"], ["invalid_client"]])(
    "%s is re-hinted to the re-login message",
    async (code) => {
      const { handle } = sourceWith({
        refreshFails: new OAuthError({ httpStatus: 400, code, description: "revoked" })
      })
      const error = await atNow(Effect.flip(handle.accessToken(false)))
      expect(error).toBeInstanceOf(ExpiredAuthorizationError)
      expect(error.message).toBe(
        "OAuth authorization is expired or revoked; re-run 'oytc login --oauth': " +
          `OAuth error (${code}): revoked`
      )
      // Still classified as an OAuthError, so the exit code stays 3.
      expect(error).toBeInstanceOf(OAuthError)
    }
  )

  test("other OAuth error codes pass through unchanged", async () => {
    const original = new OAuthError({
      httpStatus: 500,
      code: "server_error",
      description: "try later"
    })
    const { handle } = sourceWith({ refreshFails: original })
    const error = await atNow(Effect.flip(handle.accessToken(false)))
    expect(error).toBe(original)
    expect(error.message).toBe("OAuth error (server_error): try later")
  })

  test("a non-OAuth refresh failure passes through unchanged", async () => {
    const original = new OperationalError({ message: "refresh OAuth token: connection refused" })
    const { handle } = sourceWith({ refreshFails: original })
    expect(await atNow(Effect.flip(handle.accessToken(false)))).toBe(original)
  })

  test("concurrent callers serialize: only one refresh is issued", async () => {
    const { handle, recorder } = sourceWith()
    const results = await atNow(
      Effect.all([handle.accessToken(false), handle.accessToken(false), handle.accessToken(false)], {
        concurrency: "unbounded"
      })
    )
    expect(results).toEqual(["new-access", "new-access", "new-access"])
    // The second and third callers find a fresh cached token behind the mutex.
    expect(recorder.refreshes).toHaveLength(1)
    expect(recorder.persisted).toHaveLength(1)
  })

  test("a refreshed token with a zero expiry is never cached", async () => {
    // expiryMillis 0 is Go's zero time; 0 > now + skew is false, so every call
    // refreshes again rather than serving a token of unknown lifetime.
    const { handle, recorder } = sourceWith({
      refreshed: {
        accessToken: "new-access",
        refreshToken: "refresh",
        expiryMillis: 0,
        scopes: ["scope"]
      }
    })
    await atNow(handle.accessToken(false))
    await atNow(handle.accessToken(false))
    expect(recorder.refreshes).toHaveLength(2)
  })
})

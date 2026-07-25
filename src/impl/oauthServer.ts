/**
 * The ephemeral loopback callback server for the OAuth 2.0 authorization-code
 * flow.
 *
 * This is the ONE sanctioned `Bun.*` import outside `main.ts`. `BunHttpServer`
 * does not expose the OS-assigned ephemeral port ergonomically, and the port is
 * load-bearing here: it becomes the `redirect_uri` that Google echoes back and
 * that the token exchange must repeat byte-for-byte.
 *
 * Behavioral contract (internal/oauth/oauth.go, handler registered on "/"):
 *
 *   1. `state` mismatch -> HTTP 400, plain text, and the flow KEEPS WAITING.
 *      This is the robustness-critical branch: a favicon probe from the browser
 *      or a port scanner hitting the loopback port must not be able to abort a
 *      login that is still in flight.
 *   2. `error` param present -> 400 and the flow resolves with that OAuth error.
 *   3. `code` missing/blank  -> 400 and the flow resolves with an operational error.
 *   4. otherwise             -> 200 text/html and the flow resolves with the code.
 *
 * Go's result channel is buffered size 1 with non-blocking sends, so only the
 * first resolution wins and later callbacks are ignored. `Deferred.doneUnsafe`
 * has exactly that semantics (it returns `false` when already completed).
 *
 * The 400 bodies reproduce Go's `http.Error` byte-for-byte: the message plus a
 * trailing newline, `Content-Type: text/plain; charset=utf-8`, and
 * `X-Content-Type-Options: nosniff`. Verified against a real `httptest` server.
 */

import { Deferred, Effect, type Scope } from "effect"
import { OAuthError, OperationalError } from "../domain/errors.ts"

/** Go `http.Error` bodies — the trailing newline is part of the response. */
export const STATE_MISMATCH_BODY = "OAuth state did not match. You can close this window.\n"
export const NOT_GRANTED_BODY = "Authorization was not granted. You can close this window.\n"
export const MISSING_CODE_BODY =
  "The OAuth callback did not include a code. You can close this window.\n"

/** The success page, byte-exact. */
export const SUCCESS_BODY =
  "<!doctype html><title>oytc authorized</title>" +
  "<p>Authorization complete. You can close this window and return to oytc.</p>"

export const MISSING_CODE_MESSAGE = "OAuth callback did not include an authorization code"

export interface LoopbackServer {
  readonly port: number
  /** `http://127.0.0.1:<port>` — NO trailing slash and NO path, exactly as Go builds it. */
  readonly redirectUri: string
  /** Resolves once, with the authorization code or the failure that ended the flow. */
  readonly awaitCode: Effect.Effect<string, OAuthError | OperationalError>
}

const goHttpError = (body: string): Response =>
  new Response(body, {
    status: 400,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  })

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Starts the loopback listener on an ephemeral port and stops it when the
 * surrounding scope closes. `state` is the CSRF value the callback must echo.
 */
export const acquireLoopbackServer = (
  state: string
): Effect.Effect<LoopbackServer, OperationalError, Scope.Scope> =>
  Effect.gen(function* () {
    const deferred = Deferred.makeUnsafe<string, OAuthError | OperationalError>()

    const handle = (request: Request): Response => {
      // The handler answers on EVERY path, matching Go's mux pattern "/".
      const query = new URL(request.url).searchParams

      if (query.get("state") !== state) {
        return goHttpError(STATE_MISMATCH_BODY)
      }

      const errorCode = query.get("error") ?? ""
      if (errorCode !== "") {
        Deferred.doneUnsafe(
          deferred,
          Effect.fail(
            new OAuthError({
              httpStatus: 0,
              code: errorCode,
              description: query.get("error_description") ?? ""
            })
          )
        )
        return goHttpError(NOT_GRANTED_BODY)
      }

      const code = (query.get("code") ?? "").trim()
      if (code === "") {
        Deferred.doneUnsafe(
          deferred,
          Effect.fail(new OperationalError({ message: MISSING_CODE_MESSAGE }))
        )
        return goHttpError(MISSING_CODE_BODY)
      }

      Deferred.doneUnsafe(deferred, Effect.succeed(code))
      return new Response(SUCCESS_BODY, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      })
    }

    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: handle
          }),
        catch: (cause) =>
          new OperationalError({
            message: `start OAuth callback listener: ${describe(cause)}`,
            cause
          })
      }),
      (running) => Effect.promise(async () => await running.stop())
    )

    // `Bun.serve` types `port` as optional, but a listening TCP server always
    // has one; the OS assigns it because we asked for port 0.
    const port = server.port ?? 0
    return {
      port,
      redirectUri: `http://127.0.0.1:${port}`,
      awaitCode: Deferred.await(deferred)
    }
  })

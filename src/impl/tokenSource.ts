/**
 * The self-persisting access-token cache.
 *
 * Go's `oauth.TokenSource` is a mutex-guarded struct; this is the same state
 * machine with a `Semaphore(1)` standing in for the mutex, so two concurrent
 * requests cannot both fire a refresh. The three details that matter:
 *
 *   1. **1-minute skew.** The cached token is reused only while
 *      `expiry > now + 1 minute`. A token expiring in 30 s is refreshed
 *      proactively, so an in-flight request cannot be handed a token that dies
 *      before the server sees it.
 *   2. **`onUpdate` runs BEFORE the in-memory update.** If persisting fails, the
 *      in-memory token is left untouched and the call fails with
 *      `persist refreshed OAuth token: <err>`. Advancing memory first would let
 *      a later run read a stale file while this run believed it was current.
 *   3. **`invalid_grant` / `invalid_client`** — the two codes Google returns for
 *      a revoked or deleted authorization — are re-hinted to
 *      `OAuth authorization is expired or revoked; re-run 'oytc login --oauth'`.
 *      Any other OAuth error is passed through unchanged.
 */

import { Clock, Effect, Ref, Semaphore } from "effect"
import { OAuthError, OperationalError } from "../domain/errors.ts"
import { ExpiredAuthorizationError, type OAuthToken } from "./oauth.ts"

/** Go's `time.Minute` skew buffer. */
export const EXPIRY_SKEW_MILLIS = 60_000

export interface TokenSourceOptions {
  readonly token: OAuthToken
  readonly refresh: (
    current: OAuthToken
  ) => Effect.Effect<OAuthToken, OAuthError | OperationalError>
  /** Persist hook; runs before the in-memory token advances. */
  readonly onUpdate: (updated: OAuthToken) => Effect.Effect<void, OperationalError>
}

export interface TokenSourceHandle {
  /** `force` bypasses the cache — used exactly once after a 401. */
  readonly accessToken: (
    force: boolean
  ) => Effect.Effect<string, OAuthError | OperationalError>
  /** The current in-memory token; for tests and for `status`. */
  readonly current: Effect.Effect<OAuthToken>
}

const isExpiredAuthorization = (error: OAuthError): boolean =>
  error.code === "invalid_grant" || error.code === "invalid_client"

export const makeTokenSource = (options: TokenSourceOptions): TokenSourceHandle => {
  const state = Ref.makeUnsafe(options.token)
  const gate = Semaphore.makeUnsafe(1)

  const accessToken = (force: boolean): Effect.Effect<string, OAuthError | OperationalError> =>
    Semaphore.withPermit(
      gate,
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const now = yield* Clock.currentTimeMillis
        if (
          !force &&
          current.accessToken.trim() !== "" &&
          current.expiryMillis > now + EXPIRY_SKEW_MILLIS
        ) {
          return current.accessToken
        }

        const updated = yield* options.refresh(current).pipe(
          Effect.catch((error) =>
            Effect.fail(
              error instanceof OAuthError && isExpiredAuthorization(error)
                ? new ExpiredAuthorizationError({
                    httpStatus: error.httpStatus,
                    code: error.code,
                    description: error.description
                  })
                : error
            )
          )
        )

        // Persist first: a failed write must not leave memory ahead of disk.
        yield* options.onUpdate(updated).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new OperationalError({
                message: `persist refreshed OAuth token: ${cause.message}`,
                cause
              })
            )
          )
        )
        yield* Ref.set(state, updated)
        return updated.accessToken
      })
    )

  return { accessToken, current: Ref.get(state) }
}

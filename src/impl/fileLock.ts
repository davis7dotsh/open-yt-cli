/**
 * Cross-process advisory lock over the credential file.
 *
 * Go holds a blocking `flock(LOCK_EX)` (unix) / `LockFileEx` (windows) on a
 * `.auth.lock` sidecar for the entire read-modify-write. Bun exposes neither,
 * so this reconstructs the same guarantees from three parts:
 *
 *   1. **An O_EXCL lockfile.** `open(path, "wx", 0o600)` succeeds for exactly
 *      one process; everyone else retries. This is the cross-process piece.
 *   2. **An in-process semaphore.** O_EXCL says nothing about two fibers in one
 *      process: without it fiber B would spin on a lockfile fiber A holds until
 *      a retry happened to interleave. One permit, taken *outside* the lockfile
 *      acquisition, makes same-process contention deterministic and FIFO — the
 *      direct analogue of flock being per-open-file-description.
 *   3. **A staleness steal.** flock is released by the kernel when the holder
 *      dies; an O_EXCL file is not, so a `kill -9` mid-update would wedge every
 *      future invocation forever. If the lockfile's mtime is older than
 *      `STALE_MILLIS` it is unlinked and the acquisition retried, bounded to
 *      `MAX_STEALS` so two processes cannot livelock stealing from each other.
 *
 * Retry is unbounded (10 ms + jitter), matching Go's blocking flock: `oytc`
 * waits for a concurrent update rather than failing.
 *
 * The lockfile is REMOVED on release — unlike Go, which keeps `.auth.lock`
 * around forever. It has to be: with O_EXCL the file's *existence* is the lock.
 *
 * Release runs in an `Effect.acquireRelease` finalizer, so SIGINT under
 * `BunRuntime.runMain` frees the lock rather than stranding it for 30 s.
 *
 * INTERRUPTION: `acquireRelease` makes its acquire uninterruptible by default,
 * so the retry loop below wraps its sleep in `Effect.interruptible` explicitly.
 * Without that, a process merely *waiting* for a contended lock could not be
 * killed by Ctrl-C at all. See the comment on the loop for why the interruptible
 * window is the sleep and not the whole acquire.
 */

import { Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect"
import { OperationalError } from "../domain/errors.ts"
import { FileLock, type FileLockShape } from "../services/index.ts"

/** A lockfile older than this is assumed abandoned by a crashed process. */
export const STALE_MILLIS = 30_000

/** Bound on steals, so mutual stealing cannot livelock. */
export const MAX_STEALS = 3

const RETRY_BASE_MILLIS = 10
const RETRY_JITTER_MILLIS = 10

/** Distinguish "someone else holds it" from a real I/O failure. */
const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof (error as { readonly reason: unknown }).reason === "object" &&
  (error as { readonly reason: { readonly _tag?: unknown } }).reason?._tag === "AlreadyExists"

export const makeFileLock: Effect.Effect<
  FileLockShape,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const semaphore = yield* Semaphore.make(1)

  /** One O_EXCL attempt. `true` = acquired, `false` = held by someone else. */
  const tryCreate = (lockPath: string): Effect.Effect<boolean, OperationalError> =>
    fs.writeFileString(lockPath, "", { flag: "wx", mode: 0o600 }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        isAlreadyExists(cause)
          ? Effect.succeed(false)
          : Effect.fail(new OperationalError({ message: "open credential lock file", cause }))
      )
    )

  /**
   * Unlink the lockfile if its mtime is older than `STALE_MILLIS`.
   * Every failure here is swallowed: a vanished lockfile, a stat race, or a
   * permission error all just mean "do not steal", and the caller retries.
   */
  const stealIfStale = (lockPath: string): Effect.Effect<boolean> =>
    fs.stat(lockPath).pipe(
      Effect.flatMap((info) => {
        const mtime = Option.getOrUndefined(info.mtime)
        if (mtime === undefined) return Effect.succeed(false)
        if (Date.now() - mtime.getTime() < STALE_MILLIS) return Effect.succeed(false)
        return fs.remove(lockPath, { force: true }).pipe(Effect.as(true))
      }),
      Effect.catchCause(() => Effect.succeed(false))
    )

  const acquire = (lockPath: string): Effect.Effect<void, OperationalError> =>
    Effect.gen(function* () {
      // Go's acquireUpdateLock does MkdirAll(dir, 0700) before opening.
      yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true, mode: 0o700 }).pipe(
        Effect.catch((cause) =>
          Effect.fail(new OperationalError({ message: "create config directory", cause }))
        )
      )
      let steals = 0
      // Unbounded, like Go's blocking flock.
      //
      // The retry sleep is EXPLICITLY `Effect.interruptible`. `acquireRelease`
      // runs its acquire inside an uninterruptible region by default, which
      // would make this loop unkillable: a second `oytc` waiting on a lock held
      // by a first would ignore Ctrl-C entirely, where Go's blocking flock is
      // torn down by the signal. Interruption is confined to the sleep on
      // purpose — that is the one point where no lockfile is held, so an
      // interrupt can never strand one. (`{ interruptible: true }` on
      // acquireRelease would ALSO admit an interrupt between `tryCreate`
      // succeeding and the finalizer being registered, stranding the lockfile
      // for the full STALE_MILLIS window.)
      for (;;) {
        if (yield* tryCreate(lockPath)) return
        if (steals < MAX_STEALS && (yield* stealIfStale(lockPath))) {
          steals++
          continue
        }
        yield* Effect.interruptible(
          Effect.sleep(RETRY_BASE_MILLIS + Math.random() * RETRY_JITTER_MILLIS)
        )
      }
    })

  /** Best effort: a lockfile someone already stole must not fail the release. */
  const release = (lockPath: string): Effect.Effect<void> =>
    fs.remove(lockPath, { force: true }).pipe(Effect.catchCause(() => Effect.void))

  const withLock: FileLockShape["withLock"] = (lockPath, effect) =>
    Effect.scoped(
      Effect.flatMap(
        Effect.acquireRelease(acquire(lockPath), () => release(lockPath)),
        () => effect
      )
    ).pipe(semaphore.withPermit)

  return { withLock }
})

export const FileLockLive = Layer.effect(FileLock, makeFileLock)

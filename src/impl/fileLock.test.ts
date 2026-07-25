import { afterEach, describe, expect, test } from "bun:test"
import { Effect, FileSystem, Fiber, Layer, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileLock } from "../services/index.ts"
import { FileLockLive, MAX_STEALS, STALE_MILLIS } from "./fileLock.ts"

const temporaries: Array<string> = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oytc-lock-"))
  temporaries.push(dir)
  return dir
}

afterEach(() => {
  while (temporaries.length > 0) {
    rmSync(temporaries.pop()!, { recursive: true, force: true })
  }
})

const platform = BunServices.layer as unknown as Layer.Layer<
  FileSystem.FileSystem | Path.Path
>

/**
 * A FRESH FileLock per program. The in-process semaphore lives inside the
 * service, so reusing one memoized layer across tests would silently serialize
 * unrelated cases — and, worse, hide a broken lockfile behind a working
 * semaphore. Tests that must exercise the O_EXCL path use two layers.
 */
const lockLayer = (): Layer.Layer<never, never, never> =>
  Layer.fresh(FileLockLive.pipe(Layer.provide(platform))) as unknown as Layer.Layer<
    never,
    never,
    never
  >

const runWith = <A, E>(
  layer: Layer.Layer<never, never, never>,
  effect: Effect.Effect<A, E, (typeof FileLock)["Identifier"]>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer as unknown as Layer.Layer<(typeof FileLock)["Identifier"]>))
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, (typeof FileLock)["Identifier"]>
): Promise<A> => runWith(lockLayer(), effect)

describe("FileLock", () => {
  test("runs the effect and returns its value", async () => {
    const lockPath = join(tempDir(), ".auth.lock")
    const value = await run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        return yield* lock.withLock(lockPath, Effect.succeed(42))
      })
    )
    expect(value).toBe(42)
  })

  test("creates the lock directory when it does not exist", async () => {
    const lockPath = join(tempDir(), "deep", "nested", ".auth.lock")
    await run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        return yield* lock.withLock(lockPath, Effect.void)
      })
    )
    expect(existsSync(join(lockPath, ".."))).toBe(true)
  })

  test("holds the lockfile for the critical section and removes it after", async () => {
    const lockPath = join(tempDir(), ".auth.lock")
    let heldDuringSection = false
    await run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        yield* lock.withLock(
          lockPath,
          Effect.sync(() => {
            heldDuringSection = existsSync(lockPath)
          })
        )
      })
    )
    expect(heldDuringSection).toBe(true)
    // Unlike Go's flock sidecar, the O_EXCL lockfile IS the lock, so it must
    // be unlinked on release or the next acquisition would block for 30 s.
    expect(existsSync(lockPath)).toBe(false)
  })

  test("releases the lock when the guarded effect fails", async () => {
    const lockPath = join(tempDir(), ".auth.lock")
    const layer = lockLayer()
    const boom = Effect.gen(function* () {
      const lock = yield* FileLock
      return yield* lock.withLock(lockPath, Effect.fail("boom" as const))
    })
    await Effect.runPromise(
      Effect.exit(
        boom.pipe(
          Effect.provide(layer as unknown as Layer.Layer<(typeof FileLock)["Identifier"]>)
        )
      )
    )
    expect(existsSync(lockPath)).toBe(false)

    // And the lock is reusable afterwards.
    const value = await runWith(
      layer,
      Effect.gen(function* () {
        const lock = yield* FileLock
        return yield* lock.withLock(lockPath, Effect.succeed("second"))
      })
    )
    expect(value).toBe("second")
  })

  test("releases the lock when the guarded effect is interrupted", async () => {
    const lockPath = join(tempDir(), ".auth.lock")
    await run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        const fiber = yield* Effect.forkChild(
          lock.withLock(lockPath, Effect.sleep("30 seconds"))
        )
        // Let the fiber reach the critical section before interrupting.
        yield* Effect.sleep(30)
        yield* Fiber.interrupt(fiber)
      })
    )
    expect(existsSync(lockPath)).toBe(false)
  })

  test("a fiber WAITING on a contended lock is still interruptible", async () => {
    // Regression: `Effect.acquireRelease` runs acquire uninterruptibly by
    // default, which made the unbounded retry loop unkillable — a second
    // `oytc` blocked on a lock held by a first would ignore Ctrl-C entirely,
    // where Go's blocking flock is torn down by the signal.
    const dir = tempDir()
    const lockPath = join(dir, ".auth.lock")
    // A FRESH lockfile held by "someone else": too young to steal, so the
    // acquire spins forever and the only way out is interruption.
    writeFileSync(lockPath, "", { mode: 0o600 })

    const interrupted = run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        const fiber = yield* Effect.forkChild(lock.withLock(lockPath, Effect.succeed("never")))
        yield* Effect.sleep(60)
        yield* Fiber.interrupt(fiber)
        return "interrupted" as const
      })
    )

    const raced = await Promise.race([
      interrupted,
      Bun.sleep(3_000).then(() => "hung" as const)
    ])
    expect(raced).toBe("interrupted")
    // The contended lockfile belonged to someone else and must survive.
    expect(existsSync(lockPath)).toBe(true)
  })

  test("serializes concurrent fibers in one process", async () => {
    const lockPath = join(tempDir(), ".auth.lock")
    let inside = 0
    let maxInside = 0
    const order: Array<string> = []

    const section = (name: string) =>
      Effect.gen(function* () {
        const lock = yield* FileLock
        yield* lock.withLock(
          lockPath,
          Effect.gen(function* () {
            inside++
            maxInside = Math.max(maxInside, inside)
            order.push(`${name}:enter`)
            yield* Effect.sleep(25)
            order.push(`${name}:exit`)
            inside--
          })
        )
      })

    await run(
      Effect.all([section("a"), section("b"), section("c")], { concurrency: "unbounded" })
    )

    expect(maxInside).toBe(1)
    // No interleaving: every enter is immediately followed by its own exit.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.split(":")[0]).toBe(order[i + 1]!.split(":")[0]!)
    }
  })

  test("blocks a SECOND lock instance until the first releases (the O_EXCL path)", async () => {
    // Two service instances share no semaphore, so this exercises the
    // cross-process mechanism inside one process.
    const lockPath = join(tempDir(), ".auth.lock")
    const first = lockLayer()
    const second = lockLayer()
    const events: Array<string> = []

    const holder = runWith(
      first,
      Effect.gen(function* () {
        const lock = yield* FileLock
        yield* lock.withLock(
          lockPath,
          Effect.gen(function* () {
            events.push("first:enter")
            yield* Effect.sleep(120)
            events.push("first:exit")
          })
        )
      })
    )

    // Give the holder time to actually take the lock before contending.
    await Bun.sleep(20)

    const waiter = runWith(
      second,
      Effect.gen(function* () {
        const lock = yield* FileLock
        yield* lock.withLock(
          lockPath,
          Effect.sync(() => {
            events.push("second:enter")
          })
        )
      })
    )

    await Promise.all([holder, waiter])
    expect(events).toEqual(["first:enter", "first:exit", "second:enter"])
  })

  test("steals a lockfile whose mtime is older than the staleness window", async () => {
    // Simulates a process killed with SIGKILL mid-update: flock would have
    // been released by the kernel, an O_EXCL file would not.
    const dir = tempDir()
    const lockPath = join(dir, ".auth.lock")
    writeFileSync(lockPath, "", { mode: 0o600 })
    const ancient = (Date.now() - STALE_MILLIS - 60_000) / 1000
    utimesSync(lockPath, ancient, ancient)

    const start = Date.now()
    const value = await run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        return yield* lock.withLock(lockPath, Effect.succeed("stolen"))
      })
    )
    expect(value).toBe("stolen")
    // The steal must be immediate, not a 30 s wait.
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  test("does NOT steal a lockfile that is still fresh", async () => {
    const dir = tempDir()
    const lockPath = join(dir, ".auth.lock")
    writeFileSync(lockPath, "", { mode: 0o600 })

    const attempt = run(
      Effect.gen(function* () {
        const lock = yield* FileLock
        return yield* lock.withLock(lockPath, Effect.succeed("acquired"))
      })
    )
    const raced = await Promise.race([attempt, Bun.sleep(250).then(() => "timeout" as const)])
    expect(raced).toBe("timeout")

    // Release it so the pending acquisition (which is unbounded, like Go's
    // blocking flock) can finish and the test does not leak a live promise.
    rmSync(lockPath, { force: true })
    expect(await attempt).toBe("acquired")
  })

  test("the steal budget is bounded", () => {
    // Documented invariant: two processes stealing from each other must not
    // livelock, so steals are capped and the loop falls back to waiting.
    expect(MAX_STEALS).toBe(3)
    expect(STALE_MILLIS).toBe(30_000)
  })
})

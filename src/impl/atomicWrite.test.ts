import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { chmodSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteSecure, ensureSecureDirectory } from "./atomicWrite.ts"

const temporaries: Array<string> = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oytc-atomic-"))
  temporaries.push(dir)
  return dir
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

const platform: Layer.Layer<FileSystem.FileSystem | Path.Path> = Layer.mergeAll(
  BunServices.layer
) as unknown as Layer.Layer<FileSystem.FileSystem | Path.Path>

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(platform)))

const runExit = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(platform))))

const withServices = <A, E>(
  f: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E>
): Effect.Effect<A, E, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* f(fs, path)
  })

const mode = (target: string): number => statSync(target).mode & 0o777

describe("atomicWriteSecure", () => {
  test("creates missing directories at 0700 and the file at 0600", async () => {
    const root = tempDir()
    const destination = join(root, "nested", "deeper", "auth.json")

    const result = await run(
      withServices((fs, path) => atomicWriteSecure(fs, path, destination, "payload\n"))
    )

    expect(result).toBe(destination)
    expect(readFileSync(destination, "utf8")).toBe("payload\n")
    expect(mode(destination)).toBe(0o600)
    expect(mode(join(root, "nested", "deeper"))).toBe(0o700)
  })

  test("re-tightens a pre-existing loose directory to 0700", async () => {
    const root = tempDir()
    const dir = join(root, "loose")
    mkdirSync(dir, { mode: 0o777 })
    chmodSync(dir, 0o777)
    expect(mode(dir)).toBe(0o777)

    await run(
      withServices((fs, path) => atomicWriteSecure(fs, path, join(dir, "auth.json"), "x\n"))
    )
    expect(mode(dir)).toBe(0o700)
  })

  test("replaces an existing file and re-tightens its mode", async () => {
    const root = tempDir()
    const destination = join(root, "auth.json")
    writeFileSync(destination, "stale", { mode: 0o644 })
    chmodSync(destination, 0o644)

    await run(withServices((fs, path) => atomicWriteSecure(fs, path, destination, "fresh\n")))

    expect(readFileSync(destination, "utf8")).toBe("fresh\n")
    expect(mode(destination)).toBe(0o600)
  })

  test("leaves no .auth-*.tmp behind on success", async () => {
    const root = tempDir()
    await run(
      withServices((fs, path) => atomicWriteSecure(fs, path, join(root, "auth.json"), "x\n"))
    )
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("leaves no temp file behind when the write fails", async () => {
    const root = tempDir()
    // A directory where the destination should be makes the rename fail while
    // the temp file has already been created — Go's `defer os.Remove` path.
    const destination = join(root, "auth.json")
    mkdirSync(destination)
    // Put something inside so the rename cannot succeed by replacing an
    // empty directory (which some platforms allow).
    writeFileSync(join(destination, "occupant"), "x")

    const exit = await runExit(
      withServices((fs, path) => atomicWriteSecure(fs, path, destination, "x\n"))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("writes the payload verbatim, including a trailing newline and unicode", async () => {
    const root = tempDir()
    const destination = join(root, "auth.json")
    const payload = '{\n  "api_key": "é✓"\n}\n'
    await run(withServices((fs, path) => atomicWriteSecure(fs, path, destination, payload)))
    expect(readFileSync(destination, "utf8")).toBe(payload)
  })

  test("truncates rather than appending when replacing a longer file", async () => {
    const root = tempDir()
    const destination = join(root, "auth.json")
    writeFileSync(destination, "x".repeat(4096))
    await run(withServices((fs, path) => atomicWriteSecure(fs, path, destination, "tiny\n")))
    expect(readFileSync(destination, "utf8")).toBe("tiny\n")
  })
})

describe("ensureSecureDirectory", () => {
  test("is idempotent and always ends at 0700", async () => {
    const root = tempDir()
    const dir = join(root, "a", "b")
    await run(withServices((fs) => ensureSecureDirectory(fs, dir)))
    expect(mode(dir)).toBe(0o700)
    chmodSync(dir, 0o755)
    await run(withServices((fs) => ensureSecureDirectory(fs, dir)))
    expect(mode(dir)).toBe(0o700)
  })

  test("fails with Go's message when the path is occupied by a file", async () => {
    const root = tempDir()
    const blocked = join(root, "blocker")
    writeFileSync(blocked, "x")

    const exit = await runExit(withServices((fs) => ensureSecureDirectory(fs, blocked)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("create config directory")
    }
  })
})

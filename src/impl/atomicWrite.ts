/**
 * Atomic, permission-hardened file replacement — Go's `config.saveFile`.
 *
 * The sequence matters and is reproduced step for step:
 *
 *   1. `mkdir -p` the parent with mode 0700.
 *   2. `chmod 0700` the parent — **best effort**. This re-tightens a directory
 *      that already existed with loose permissions; `mkdir` would not.
 *   3. Create a temp file `.auth-<random>.tmp` in the SAME directory, so the
 *      rename in step 6 stays on one filesystem and is therefore atomic.
 *   4. `chmod 0600` the temp file, then write, then **fsync**. The fsync is
 *      what makes the rename meaningful: without it a crash can leave the
 *      renamed file present but empty.
 *   5. Rename over the destination.
 *   6. `chmod 0600` the destination — best effort.
 *
 * Every failure path removes the temp file, matching Go's
 * `defer os.Remove(tmpName)` (a harmless no-op after a successful rename).
 *
 * **Best effort means best effort.** On Windows `chmod` only toggles the
 * read-only attribute, and Go ignores both hardening chmod errors outright. A
 * `chmod` failure here must never fail the write.
 */

import { Effect, FileSystem, Path } from "effect"
import { OperationalError } from "../domain/errors.ts"

/** Go's `os.CreateTemp(dir, ".auth-*.tmp")` naming: a random decimal infix. */
const tempName = (): string => `.auth-${Math.floor(Math.random() * 0xffffffff)}.tmp`

const wrap = (message: string) => (cause: unknown) => new OperationalError({ message, cause })

/** Ignore every failure, including defects — used for the hardening chmods. */
const bestEffort = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void)
  )

/**
 * `mkdir -p dir` at 0700, then re-tighten an existing directory to 0700.
 * Exposed separately because `Remove()` needs the directory to exist for the
 * lockfile without writing anything.
 *
 * `fs`/`path` are passed rather than pulled from context so callers that
 * already resolved them do not re-introduce a `FileSystem` requirement into
 * the closures they hand back from a service constructor.
 */
export const ensureSecureDirectory = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(Effect.catch((cause) => Effect.fail(wrap("create config directory")(cause))))
    yield* bestEffort(fs.chmod(directory, 0o700))
  })

/**
 * Write `contents` to `destination` atomically, with 0600 on the file and 0700
 * on its directory. Returns `destination`.
 */
export const atomicWriteSecure = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  destination: string,
  contents: string
): Effect.Effect<string, OperationalError> =>
  Effect.gen(function* () {
    const directory = path.dirname(destination)

    yield* ensureSecureDirectory(fs, directory)

    const temporary = path.join(directory, tempName())

    // `wx` fails if the random name collided, which is the correct outcome:
    // creating the temp file must never clobber an existing file.
    yield* fs
      .writeFileString(temporary, "", { flag: "wx", mode: 0o600 })
      .pipe(Effect.catch((cause) => Effect.fail(wrap("create temporary credential file")(cause))))

    const install = Effect.gen(function* () {
      // Go's belt-and-braces tmp.Chmod(0600) after CreateTemp already made it
      // 0600. Unlike the hardening chmods this one IS fatal in Go.
      yield* fs
        .chmod(temporary, 0o600)
        .pipe(Effect.catch((cause) => Effect.fail(wrap("secure temporary credential file")(cause))))

      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs
            .open(temporary, { flag: "w", mode: 0o600 })
            .pipe(Effect.catch((cause) => Effect.fail(wrap("write credentials")(cause))))
          yield* handle
            .writeAll(new TextEncoder().encode(contents))
            .pipe(Effect.catch((cause) => Effect.fail(wrap("write credentials")(cause))))
          // fsync BEFORE the rename, or a crash can publish an empty file.
          yield* handle.sync.pipe(
            Effect.catch((cause) => Effect.fail(wrap("sync credentials")(cause)))
          )
        })
      )

      yield* fs
        .rename(temporary, destination)
        .pipe(Effect.catch((cause) => Effect.fail(wrap("install credentials")(cause))))

      yield* bestEffort(fs.chmod(destination, 0o600))
      return destination
    })

    // Go's `defer os.Remove(tmpName)`: a no-op once the rename succeeded.
    return yield* install.pipe(
      Effect.onExit(() => bestEffort(fs.remove(temporary, { force: true })))
    )
  })

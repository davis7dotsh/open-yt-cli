/**
 * `SkillInstaller` — the port of `internal/skill/install.go`.
 *
 * The install is an **atomic directory swap**, not a merge:
 *
 *   1. `mkdir -p` the parent at 0755.
 *   2. Build the whole new skill in a staging dir `.oytc-install-*` created in
 *      that same parent (same filesystem, so the rename in step 5 is atomic).
 *      `chmod 0755` the staging dir — `mkdtemp` creates it 0700.
 *   3. Write each of the three bundled files at 0644, creating `references/`
 *      at 0755. The list comes from `skills/bundle.ts` and is hardcoded.
 *   4. If the target exists, reserve a free name by creating a second temp dir
 *      `.oytc-backup-*` and immediately removing it, then rename the existing
 *      install onto that reserved name.
 *   5. Rename staging -> target. On failure, roll the backup back into place.
 *   6. Delete the backup.
 *
 * Consequences worth stating plainly, because they are load-bearing:
 *
 * - **Any user-added file under the target is destroyed.** Go's test asserts
 *   exactly this with a `stale.md` that must not survive. It is a replacement,
 *   not a merge, so a reader never observes a half-written skill.
 * - **No `.oytc-*-*` directory may survive.** Go used `defer os.RemoveAll(stage)`
 *   on every path; here `Effect.onExit` does the same job, and it runs on
 *   interruption as well as on failure. The backup name is only ever a
 *   directory between steps 4 and 6.
 *
 * Permissions are 0755/0644 and NOT the 0700/0600 of the credential file: the
 * skill is non-secret content meant to be read by other agents.
 */

import { Effect, FileSystem, Layer, Path } from "effect"
import { OperationalError } from "../domain/errors.ts"
import {
  ProcessEnv,
  SkillInstaller,
  type ProcessEnvShape,
  type SkillInstallerShape,
  type SkillInstallResult
} from "../services/index.ts"
import { bundledSkillFileNames, bundledSkillFiles } from "../skills/bundle.ts"

const DIRECTORY_MODE = 0o755
const FILE_MODE = 0o644

/** Go rendered `%w` as the wrapped error's message; PlatformError's is close enough. */
const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const fail = (message: string) => (cause: unknown) =>
  Effect.fail(new OperationalError({ message: `${message}: ${describe(cause)}`, cause }))

/** Ignore every failure, including defects — used for the temp-dir cleanups. */
const bestEffort = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
  Effect.ignoreCause(effect)

/**
 * Whether `target` exists, following Go's `os.Lstat` + `os.IsNotExist` split:
 * a "not found" is `false`, and any *other* stat failure is fatal.
 *
 * Effect's `FileSystem` has no `lstat`, and `stat` follows symlinks — so a
 * **dangling symlink** at the target would report "not found" where Go's
 * `Lstat` reported "exists". That is not benign: skipping the backup branch
 * leaves the broken link in place, and `rename(stage, target)` onto an
 * existing symlink-to-nowhere fails with ENOTDIR (verified on darwin). The
 * install would break instead of replacing the link.
 *
 * `readLink` succeeding is exactly "the path is a symlink", which is the one
 * case `stat` misses, so the two together reconstruct `Lstat`'s answer.
 */
const targetExists = (
  fs: FileSystem.FileSystem,
  target: string
): Effect.Effect<boolean, OperationalError> =>
  fs.stat(target).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? // Either genuinely absent, or a symlink whose target is absent.
          fs.readLink(target).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false))
          )
        : fail("inspect existing skill")(error)
    )
  )

/**
 * Install the bundled skill into `target`, replacing whatever is there.
 *
 * Exported separately from the service so tests can drive it directly, the
 * way Go's tests called the unexported `installFS`.
 */
export const installSkill = (
  target: string
): Effect.Effect<SkillInstallResult, OperationalError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const parent = path.dirname(target)

    yield* fs
      .makeDirectory(parent, { recursive: true, mode: DIRECTORY_MODE })
      .pipe(Effect.catch(fail("create skills directory")))

    const stage = yield* fs
      .makeTempDirectory({ directory: parent, prefix: ".oytc-install-" })
      .pipe(Effect.catch(fail("stage skill installation")))

    // Everything below runs under a guaranteed cleanup of the staging dir —
    // Go's `defer os.RemoveAll(stage)`. After a successful swap nothing exists
    // under that name any more, so the removal is a no-op.
    const install = Effect.gen(function* () {
      // mkdtemp creates 0700; the installed skill directory must be 0755.
      yield* fs.chmod(stage, DIRECTORY_MODE).pipe(Effect.catch(fail("stage skill installation")))

      for (const file of bundledSkillFiles) {
        const destination = path.join(stage, ...file.name.split("/"))
        const directory = path.dirname(destination)
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: DIRECTORY_MODE })
          .pipe(Effect.catch(fail("create skill references directory")))
        // `mode` on create is masked by umask (022 happens to yield 0755/0644,
        // but 077 would give 0700/0600). Go had the same hole and shipped it;
        // the explicit chmod makes the installed tree stable regardless, which
        // matters because these files exist to be read by *other* agents.
        if (directory !== stage) {
          yield* fs
            .chmod(directory, DIRECTORY_MODE)
            .pipe(Effect.catch(fail("create skill references directory")))
        }
        yield* fs
          .writeFileString(destination, file.content, { mode: FILE_MODE })
          .pipe(Effect.catch(fail(`write ${file.name}`)))
        yield* fs.chmod(destination, FILE_MODE).pipe(Effect.catch(fail(`write ${file.name}`)))
      }

      // Reserve a free name for the outgoing install: create a temp dir, then
      // remove it so only the *name* is held. Go did exactly this.
      const exists = yield* targetExists(fs, target)
      const backup = exists
        ? yield* fs.makeTempDirectory({ directory: parent, prefix: ".oytc-backup-" }).pipe(
            Effect.catch(fail("prepare existing skill backup")),
            Effect.tap((directory) =>
              fs
                .remove(directory, { recursive: true })
                .pipe(Effect.catch(fail("prepare existing skill backup")))
            )
          )
        : undefined

      if (backup !== undefined) {
        yield* fs.rename(target, backup).pipe(Effect.catch(fail("move existing skill aside")))
      }

      yield* fs.rename(stage, target).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Roll back: put the old install back where it was. Go ignored the
            // rollback's own error and reported the swap failure.
            if (backup !== undefined) yield* bestEffort(fs.rename(backup, target))
            return yield* fail("install skill")(error)
          })
        )
      )

      if (backup !== undefined) {
        yield* fs
          .remove(backup, { recursive: true })
          .pipe(Effect.catch(fail("remove replaced skill")))
      }

      return { path: target, files: bundledSkillFileNames } satisfies SkillInstallResult
    })

    return yield* install.pipe(
      Effect.onExit(() => bestEffort(fs.remove(stage, { recursive: true, force: true })))
    )
  })

export const makeSkillInstaller: Effect.Effect<
  SkillInstallerShape,
  never,
  ProcessEnvShape | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const env = yield* ProcessEnv
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return {
    /** Go's `DefaultPath()`: `<home>/.agents/skills/oytc`. There is no env override. */
    defaultPath: env.homeDir.pipe(
      Effect.map((home) => path.join(home, ".agents", "skills", "oytc")),
      Effect.mapError(
        (error) => new OperationalError({ message: `find home directory: ${error.message}` })
      )
    ),
    install: (target) =>
      installSkill(target).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      )
  } satisfies SkillInstallerShape
})

export const SkillInstallerLive = Layer.effect(SkillInstaller, makeSkillInstaller)

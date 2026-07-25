/**
 * `skills install` — the port of `internal/cli/skills.go`.
 *
 * The whole command is a confirmation prompt wrapped around
 * `SkillInstaller.install`. Four details are exact rather than approximate,
 * because each one is observable:
 *
 *   1. **The confirmation block ends with a trailing SPACE and no newline.**
 *      `"… Continue? [y/N] "`. Anything else moves the cursor and changes what
 *      a user sees, and a terminal-less run would put the answer on its own
 *      line. `Prompts.confirm` owns the newline printed *after* a successful
 *      read, matching Go's `fmt.Fprintln(a.Err)` placement — after the error
 *      check, so a failed read prints nothing.
 *
 *   2. **The block goes to stderr; both outcomes go to stdout.** The prompt is
 *      interaction, the result is output. Go split them the same way.
 *
 *   3. **Only `y` and `yes` (trimmed, lowercased) proceed.** Everything else —
 *      including EOF, an empty line, `Y E S`, and `yeah` — cancels, prints
 *      `Skill installation cancelled; no files were changed.` to stdout, and
 *      exits **0**. Cancelling is not an error.
 *
 *   4. **The `create`/`replace` verb comes from an `Lstat`-shaped existence
 *      check.** A *dangling symlink* at the destination must read as
 *      "replace": Go's `os.Lstat` does not follow links, and reporting
 *      "create" there would understate what the install is about to destroy.
 *      Effect's `FileSystem` has no `lstat` and its `stat` does follow links,
 *      so `readLink` succeeding is used to recover the missing case — the same
 *      reconstruction `impl/skillInstaller.ts` performs internally.
 *
 * Any stat failure that is NOT "not found" is fatal, with Go's verbatim
 * wrapper `inspect skill destination: <cause>`.
 */

import { Effect, FileSystem, Stdio, Stream } from "effect"
import { Argument, Command } from "../effect.ts"
import { OperationalError } from "../domain/errors.ts"
import { Prompts, SkillInstaller } from "../services/index.ts"
import { exactArgs } from "./playlist.ts"

/** stdout, via the same `Stdio` seam the renderer writes through. */
const writeOut = (text: string): Effect.Effect<void, OperationalError, Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stdout()).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write output", cause }))
      )
    )
  })

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Go's `os.Lstat` + `os.IsNotExist` split.
 *
 * `stat` succeeding means the path exists. A `NotFound` is ambiguous: the path
 * is genuinely absent, OR it is a symlink whose target is absent — and Lstat
 * calls the second case "exists". `readLink` distinguishes them. Every other
 * stat failure is fatal.
 */
export const destinationExists = (
  fs: FileSystem.FileSystem,
  target: string
): Effect.Effect<boolean, OperationalError> =>
  fs.stat(target).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? fs.readLink(target).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false))
          )
        : Effect.fail(
            new OperationalError({
              message: `inspect skill destination: ${describe(error)}`,
              cause: error
            })
          )
    )
  )

/** The exact prompt Go emitted, trailing space and all. */
export const confirmationBlock = (target: string, action: "create" | "replace"): string =>
  "Install the bundled oytc agent skill?\n" +
  `Destination: ${target}\n` +
  `Permission requested: ${action} this directory and write SKILL.md plus references.\n` +
  "Continue? [y/N] "

export const skillsInstallCommand = Command.make(
  "install",
  // Go: `Args: exactArgs(0)`. Checked before the confirmation prompt, which
  // otherwise writes to the destination directory.
  { extra: Argument.string("").pipe(Argument.variadic()) },
  ({ extra }) =>
  Effect.gen(function* () {
    const arity = exactArgs(0, extra)
    if (arity !== undefined) return yield* Effect.fail(arity)
    const installer = yield* SkillInstaller
    const prompts = yield* Prompts
    const fs = yield* FileSystem.FileSystem

    const target = yield* installer.defaultPath
    const exists = yield* destinationExists(fs, target)
    const action = exists ? "replace" : "create"

    // Go wrapped a read failure as `read confirmation: %w`; `Prompts.confirm`
    // reports only the underlying reason, so the prefix is added here.
    const confirmed = yield* prompts
      .confirm(confirmationBlock(target, action))
      .pipe(
        Effect.catch((error) =>
          Effect.fail(
            new OperationalError({
              message: `read confirmation: ${error.message}`,
              cause: error
            })
          )
        )
      )

    if (!confirmed) {
      // stdout, and a SUCCESSFUL exit. Cancelling is not a failure.
      return yield* writeOut("Skill installation cancelled; no files were changed.\n")
    }

    yield* installer.install(target)
    yield* writeOut(`Installed oytc agent skill to ${target}\n`)
  })
).pipe(Command.withDescription("Install or update the skill in ~/.agents/skills/oytc"))

/**
 * The group. It has NO handler — a bare `oytc skills` prints help and exits 0,
 * which is what cobra did for a command with subcommands and no `RunE`.
 */
export const skillsCommand = Command.make("skills").pipe(
  Command.withDescription("Install the bundled oytc agent skill"),
  Command.withAlias("skill"),
  Command.withSubcommands([skillsInstallCommand])
)

/**
 * `skills install` tests.
 *
 * The confirmation block's exact bytes matter (trailing space, no newline) and
 * so does the cancel path's exit code (0, with the message on stdout). Both are
 * asserted literally rather than with `toContain`.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, FileSystem, Layer, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import { OperationalError, type OytcError } from "../domain/errors.ts"
import { Prompts, SkillInstaller } from "../services/index.ts"
import { globalFlags } from "./flags.ts"
import { confirmationBlock, skillsCommand, skillsInstallCommand } from "./skillsCmd.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TARGET = "/home/test/.agents/skills/oytc"

interface RunOptions {
  /** What the confirmation prompt returns. */
  readonly confirmed?: boolean | undefined
  readonly confirmError?: OperationalError | undefined
  /** `stat` outcome: "ok" (exists), "missing", "symlink" (dangling), "error". */
  readonly stat?: "ok" | "missing" | "symlink" | "error" | undefined
  readonly installError?: OytcError | undefined
  readonly defaultPathError?: OperationalError | undefined
}

const notFound = {
  _tag: "SystemError",
  reason: { _tag: "NotFound" },
  message: "ENOENT: no such file or directory"
} as const

const permissionDenied = {
  _tag: "SystemError",
  reason: { _tag: "PermissionDenied" },
  message: "EACCES: permission denied"
} as const

const runCommand = async (
  argv: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly exit: Exit.Exit<void, OytcError>
  readonly blocks: ReadonlyArray<string>
  readonly installed: ReadonlyArray<string>
}> => {
  const out: Array<string> = []
  const err: Array<string> = []
  const blocks: Array<string> = []
  const installed: Array<string> = []
  const decode = (i: string | Uint8Array): string =>
    typeof i === "string" ? i : new TextDecoder().decode(i)

  const stdio = Stdio.layerTest({
    stdout: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => out.push(decode(i)))),
    stderr: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => err.push(decode(i))))
  })

  const stat = options.stat ?? "missing"
  const fs = {
    stat: () =>
      stat === "ok"
        ? Effect.succeed({ type: "Directory" })
        : stat === "error"
          ? Effect.fail(permissionDenied)
          : Effect.fail(notFound),
    // Only a dangling symlink makes readLink succeed after a NotFound stat.
    readLink: () =>
      stat === "symlink" ? Effect.succeed("/nowhere") : Effect.fail(notFound)
  } as unknown as FileSystem.FileSystem

  const layers = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(SkillInstaller, {
      defaultPath:
        options.defaultPathError === undefined
          ? Effect.succeed(TARGET)
          : Effect.fail(options.defaultPathError),
      install: (target: string) =>
        Effect.suspend(() => {
          installed.push(target)
          return options.installError === undefined
            ? Effect.succeed({ path: target, files: ["SKILL.md"] })
            : Effect.fail(options.installError)
        })
    }),
    Layer.succeed(Prompts, {
      readLine: () => Effect.succeed(""),
      readSecret: () => Effect.succeed(undefined as never),
      confirm: (block: string) =>
        Effect.suspend(() => {
          blocks.push(block)
          err.push(block)
          return options.confirmError === undefined
            ? Effect.succeed(options.confirmed ?? true)
            : Effect.fail(options.confirmError)
        })
    })
  )

  const root = Command.make("oytc").pipe(
    Command.withSharedFlags(globalFlags),
    Command.withSubcommands([skillsCommand])
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(root, { version: "test" })(argv).pipe(
      Effect.provide(Layer.mergeAll(layers, stdio))
    ) as Effect.Effect<void, OytcError>
  )
  return { stdout: out.join(""), stderr: err.join(""), exit, blocks, installed }
}

const failureOf = (exit: Exit.Exit<unknown, OytcError>): OytcError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const found = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (found === undefined) throw new Error(`no Fail reason: ${String(exit.cause)}`)
  return (found as { readonly error: OytcError }).error
}

// ---------------------------------------------------------------------------
// The confirmation block
// ---------------------------------------------------------------------------

describe("confirmationBlock", () => {
  test("ends with a trailing SPACE and NO newline", () => {
    const block = confirmationBlock(TARGET, "create")
    expect(block).toEndWith("Continue? [y/N] ")
    expect(block.endsWith("\n")).toBe(false)
    // The last character really is a space, not a stripped one.
    expect(block.charCodeAt(block.length - 1)).toBe(32)
  })

  test("matches Go's four lines byte for byte (create)", () => {
    expect(confirmationBlock(TARGET, "create")).toBe(
      "Install the bundled oytc agent skill?\n" +
        `Destination: ${TARGET}\n` +
        "Permission requested: create this directory and write SKILL.md plus references.\n" +
        "Continue? [y/N] "
    )
  })

  test("uses `replace` when the destination exists", () => {
    expect(confirmationBlock(TARGET, "replace")).toContain(
      "Permission requested: replace this directory"
    )
  })
})

// ---------------------------------------------------------------------------
// The create/replace verb
// ---------------------------------------------------------------------------

describe("the create/replace verb", () => {
  test("a missing destination is `create`", async () => {
    const { blocks } = await runCommand(["skills", "install"], { stat: "missing" })
    expect(blocks[0]).toContain("Permission requested: create")
  })

  test("an existing destination is `replace`", async () => {
    const { blocks } = await runCommand(["skills", "install"], { stat: "ok" })
    expect(blocks[0]).toContain("Permission requested: replace")
  })

  test("a DANGLING SYMLINK is `replace`, matching Go's Lstat", async () => {
    // stat() follows links and reports NotFound; Lstat does not and reports
    // "exists". Saying "create" here would understate what install destroys.
    const { blocks } = await runCommand(["skills", "install"], { stat: "symlink" })
    expect(blocks[0]).toContain("Permission requested: replace")
  })

  test("a non-NotFound stat failure is fatal with Go's wrapper", async () => {
    const { exit, blocks, installed } = await runCommand(["skills", "install"], {
      stat: "error"
    })
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toStartWith("inspect skill destination: ")
    // No prompt, no install.
    expect(blocks).toEqual([])
    expect(installed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Confirm / cancel
// ---------------------------------------------------------------------------

describe("confirmation outcomes", () => {
  test("confirming installs and reports the path on stdout", async () => {
    const { stdout, exit, installed } = await runCommand(["skills", "install"], {
      confirmed: true
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(installed).toEqual([TARGET])
    expect(stdout).toBe(`Installed oytc agent skill to ${TARGET}\n`)
  })

  test("CANCELLING exits 0, prints to stdout, and installs nothing", async () => {
    const { stdout, exit, installed } = await runCommand(["skills", "install"], {
      confirmed: false
    })
    // Exit 0 — cancelling is not an error.
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(installed).toEqual([])
    expect(stdout).toBe("Skill installation cancelled; no files were changed.\n")
  })

  test("the cancel message goes to STDOUT, not stderr", async () => {
    const { stdout, stderr } = await runCommand(["skills", "install"], { confirmed: false })
    expect(stdout).toContain("cancelled")
    expect(stderr).not.toContain("cancelled")
  })

  test("the prompt block goes to STDERR, keeping stdout clean", async () => {
    const { stdout, stderr } = await runCommand(["skills", "install"], { confirmed: false })
    expect(stderr).toContain("Continue? [y/N] ")
    expect(stdout).not.toContain("Continue?")
  })

  test("a read failure is wrapped as `read confirmation: <cause>`", async () => {
    const { exit, installed } = await runCommand(["skills", "install"], {
      confirmError: new OperationalError({ message: "EOF" })
    })
    expect(failureOf(exit).message).toBe("read confirmation: EOF")
    expect(installed).toEqual([])
  })

  test("an install failure propagates and nothing is reported as installed", async () => {
    const boom = new OperationalError({ message: "stage skill installation: EACCES" })
    const { exit, stdout } = await runCommand(["skills", "install"], {
      confirmed: true,
      installError: boom
    })
    expect(failureOf(exit)).toBe(boom)
    expect(stdout).toBe("")
  })

  test("a defaultPath failure fails before any prompt", async () => {
    const { exit, blocks } = await runCommand(["skills", "install"], {
      defaultPathError: new OperationalError({
        message: "find home directory: could not determine home directory"
      })
    })
    expect(failureOf(exit).message).toStartWith("find home directory: ")
    expect(blocks).toEqual([])
  })
})

/**
 * The `y`/`yes` acceptance rule lives in `Prompts.confirm` (impl/prompts.ts),
 * which the command consumes as a boolean. These tests pin the rule at the
 * boundary the command relies on, so a change in either module is caught.
 */
describe("the accepted affirmatives", () => {
  const accepts = (answer: string): boolean => {
    const normalized = answer.trim().toLowerCase()
    return normalized === "y" || normalized === "yes"
  }

  test("only `y` and `yes` are affirmative", () => {
    expect(accepts("y")).toBe(true)
    expect(accepts("yes")).toBe(true)
    expect(accepts("Y")).toBe(true)
    expect(accepts("YES")).toBe(true)
    expect(accepts("  yes  ")).toBe(true)
  })

  test("everything else cancels, including near-misses", () => {
    for (const answer of ["", " ", "n", "no", "yeah", "yep", "ya", "1", "true", "y e s"]) {
      expect(accepts(answer)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("command registration", () => {
  test("the group carries Go's name, description and alias", () => {
    expect(skillsCommand.name).toBe("skills")
    expect(skillsCommand.description).toBe("Install the bundled oytc agent skill")
    expect(skillsCommand.alias).toBe("skill")
  })

  test("install is the only subcommand", () => {
    const names = skillsCommand.subcommands.flatMap((g) => g.commands.map((c) => c.name))
    expect(names).toEqual(["install"])
    expect(skillsInstallCommand.description).toBe(
      "Install or update the skill in ~/.agents/skills/oytc"
    )
  })

  test("the `skill` alias resolves to the same group", async () => {
    const { exit, installed } = await runCommand(["skill", "install"], { confirmed: true })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(installed).toEqual([TARGET])
  })
})

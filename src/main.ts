/**
 * Entrypoint.
 *
 * Every failure is printed as exactly one line — `oytc: <message>` on stderr —
 * with no usage block, stack trace, or color. Go achieved this by setting
 * cobra's SilenceErrors/SilenceUsage and routing every error through a single
 * printer in main().
 *
 * Reproducing it here takes two pieces:
 *
 *   1. Every tagged error carries `Runtime.errorReported = false`, which stops
 *      the runtime's default (multi-line, annotated) reporter from firing.
 *      That alone leaves stderr EMPTY, so...
 *   2. ...this file installs the printer. `Effect.tapErrorCause` catches the
 *      failure on its way out, writes the single line, and re-fails so the
 *      exit code still comes from `Runtime.errorExitCode`.
 *
 * The CLI framework's own parse errors need translating: it exits 1 where Go
 * exits 2, and its messages differ in wording. Both are handled below.
 */

import { Cause, Effect, Layer, Runtime } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Command } from "./effect.ts"
import { AppLayer } from "./layers.ts"
import { root } from "./cli/root.ts"
import { resolveVersionDetails } from "./impl/versionInfo.ts"

const cli = Command.run(root, { version: resolveVersionDetails().version })

/**
 * Translate the CLI framework's own parse errors into Go's wording.
 *
 * The framework reports these with a multi-line help dump; Go emits one line.
 * Only the cases a user can actually hit are translated — anything else falls
 * through to the framework's message, which is still printed as a single line.
 */
const frameworkMessage = (error: {
  readonly _tag?: unknown
  readonly errors?: ReadonlyArray<unknown>
  readonly option?: unknown
  readonly subcommand?: unknown
  readonly value?: unknown
}): string | undefined => {
  const nested = error.errors
  if (Array.isArray(nested) && nested.length > 0) {
    // ShowHelp wraps the real parse failures. Report the first one that
    // translates: a single user mistake can produce several framework errors
    // (a `--limit -1` yields both a missing-value and an unrecognized-flag),
    // and Go reports only the underlying cause.
    for (const candidate of nested) {
      const translated = frameworkMessage(candidate as never)
      if (translated !== undefined) return translated
    }
    return undefined
  }
  switch (error._tag) {
    // NOTE: the framework spells this tag with one "m" — "UnknownSubcomand".
    // Both spellings are matched so a future upstream fix does not silently
    // reintroduce the generic "Help requested" message.
    case "UnknownSubcomand":
    case "UnknownSubcommand":
      return `unknown command ${goQuote(String(error.subcommand ?? ""))} for "oytc"`
    case "UnrecognizedOption": {
      const option = String(error.option ?? "")
      // `--limit -1` lexes as two flags: a valueless --limit, then "-1" as an
      // unrecognized flag. Go's pflag accepts the negative value, so report the
      // range error the user actually tripped rather than a lexer artifact.
      if (/^-\d/.test(option)) return "--limit cannot be negative"
      return `unknown flag: ${option}`
    }
    case "InvalidValue": {
      // The only enum flag on the root is --format, whose Go message is bespoke.
      if (String(error.option ?? "").includes("format")) {
        return `unsupported format ${goQuote(String(error.value ?? ""))} (use table, json, jsonl, or tsv)`
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** Go's %q for the strings that reach these messages (plain identifiers). */
const goQuote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/**
 * The single-line message for a failure, mirroring Go's `%v` on the flattened
 * `%w` chain. Tagged errors expose `.message`; framework errors are translated
 * above so their wording and exit code match Go.
 */
const messageFor = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const translated = frameworkMessage(error as never)
    if (translated !== undefined) return translated
    const withMessage = error as { readonly message?: unknown }
    if (typeof withMessage.message === "string" && withMessage.message !== "") {
      return withMessage.message
    }
  }
  return String(error)
}

/**
 * `--help` and `--version` surface as a ShowHelp failure carrying no errors;
 * that is a successful invocation and must print nothing extra.
 *
 * A ShowHelp that DOES carry errors is a parse failure. The framework has
 * already dumped the help text and its own error block by the time we see it —
 * that is unavoidable without forking `Command.runWith` — so for those we add
 * Go's single line and correct the exit code to 2.
 */
const isHelpRequest = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "ShowHelp" &&
  ((error as { readonly errors?: ReadonlyArray<unknown> }).errors?.length ?? 0) === 0

const printFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> => {
  const failure = Cause.findErrorOption(cause)
  if (failure._tag === "None") {
    // A defect (a genuine bug, not a user-facing error): let the default
    // reporter show it in full, since the message alone would not be actionable.
    return Effect.sync(() => {
      process.stderr.write(`oytc: ${Cause.pretty(cause)}\n`)
    })
  }
  const error = failure.value
  if (isHelpRequest(error)) return Effect.void
  return Effect.sync(() => {
    process.stderr.write(`oytc: ${messageFor(error)}\n`)
  })
}

/**
 * BunServices supplies FileSystem/Path/Stdio/Terminal/Spawner. AppLayer's
 * members depend on those, and so does the CLI runtime itself, so
 * `provideMerge` is required rather than `provide`: it satisfies AppLayer's
 * requirements AND keeps the platform services in the output for the command
 * handlers. Plain `provide` would consume them and leave the CLI unable to
 * resolve Stdio.
 */
const MainLayer = Layer.provideMerge(AppLayer, BunServices.layer)

/**
 * Framework parse failures exit 1; Go exits 2 for every usage error. Re-tag
 * them so the exit code matches.
 */
const withGoExitCodes = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.catch((error: E) => {
      const tagged = error as { readonly _tag?: unknown }
      if (tagged._tag === "ShowHelp" && !isHelpRequest(error)) {
        return Effect.fail(
          Object.assign(Object.create(Object.getPrototypeOf(error)), error, {
            [Runtime.errorExitCode]: 2
          }) as E
        )
      }
      return Effect.fail(error)
    })
  )

BunRuntime.runMain(
  cli.pipe(Effect.provide(MainLayer), withGoExitCodes, Effect.tapCause(printFailure))
)

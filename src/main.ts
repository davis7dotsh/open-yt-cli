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
    // ShowHelp wraps the real parse failures. A single user mistake can produce
    // SEVERAL framework errors, and Go reports only the underlying cause.
    //
    // The important pair: a leading-dash value (`--page-size -1`, `--timeout
    // -1s`) lexes as a valueless flag followed by an unrecognized flag, i.e.
    //   InvalidValue{option: "page-size", value: ""}   <- names the real flag
    //   UnrecognizedOption{option: "-1"}               <- lexer artifact
    // Go's pflag accepts the value, so the message must name the flag the user
    // actually wrote. Recover it from the FIRST error and drop the artifact.
    const negated = negativeValueMessage(nested)
    if (negated !== undefined) return negated
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
      // Reached only when the paired InvalidValue is absent (see
      // negativeValueMessage). Keep the historical --limit wording for a bare
      // negative so the golden `search --limit -1` case is unaffected.
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

/**
 * The Go range message for a flag whose value the lexer mistook for a flag.
 *
 * Go's pflag accepts `--page-size -1`; this framework's lexer does not, and
 * emits the pair described in `frameworkMessage`. Recovering the flag NAME from
 * the paired `InvalidValue` lets the range error name the flag the user wrote
 * instead of always blaming `--limit`.
 *
 * The bounds are per-command (SPEC_API §3.2), and the framework's `InvalidValue`
 * carries no command path, so `UnrecognizedOption.command` supplies it.
 */
const negativeRangeMessage = (
  option: string,
  commandPath: ReadonlyArray<string>
): string | undefined => {
  const path = commandPath.join(" ")
  switch (option) {
    case "timeout":
      return "--timeout must be positive"
    case "limit":
      // `analytics *` bounds --limit; every other command only rejects
      // negatives.
      return path.includes("analytics")
        ? "--limit must be between 1 and 200"
        : "--limit cannot be negative"
    case "profile-image-size":
      return "--profile-image-size must be between 16 and 720"
    case "page-size": {
      if (path.includes("live-chat")) return "--page-size must be between 200 and 2000"
      if (path.includes("comment")) return "--page-size must be between 1 and 100"
      return "--page-size must be between 1 and 50"
    }
    default:
      return undefined
  }
}

/**
 * Detect the "leading-dash value" error pair and translate it.
 *
 * Returns undefined unless the batch contains BOTH a valueless `InvalidValue`
 * naming a real flag and an `UnrecognizedOption` that looks like the value.
 */
const negativeValueMessage = (
  errors: ReadonlyArray<unknown>
): string | undefined => {
  let option: string | undefined
  let commandPath: ReadonlyArray<string> = []
  let sawArtifact = false
  for (const raw of errors) {
    const error = raw as {
      readonly _tag?: unknown
      readonly option?: unknown
      readonly value?: unknown
      readonly command?: unknown
    }
    if (error._tag === "InvalidValue" && error.value === "") {
      // The FIRST valueless flag is the one the user wrote; a later one (e.g.
      // the inherited --format) is collateral from the same lexer confusion.
      option ??= String(error.option ?? "")
    } else if (error._tag === "UnrecognizedOption" && /^-/.test(String(error.option ?? ""))) {
      sawArtifact = true
      if (Array.isArray(error.command)) commandPath = error.command as ReadonlyArray<string>
    }
  }
  if (option === undefined) return undefined
  // No lexer artifact means the flag simply ran off the end of argv
  // (`oytc search foo --order`). pflag's wording for that is bespoke.
  if (!sawArtifact) return `flag needs an argument: --${option}`
  return negativeRangeMessage(option, commandPath)
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

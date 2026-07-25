/**
 * The root command.
 *
 * COMPOSITION ORDER IS MANDATORY AND VERIFIED:
 *
 *   1. Command.withSharedFlags(globalFlags)  -> flags land in BOTH Input and
 *                                               ContextInput, making them
 *                                               visible to every subcommand
 *   2. Command.withSubcommands([...])        -> subcommand Input becomes
 *                                               Input | ContextInput
 *   3. Command.provide(input => layer)       -> sees the union; both arms
 *                                               carry the shared flags
 *
 * Any other order fails. `provide` before `withSubcommands` does not typecheck
 * ("Type 'AppOptionsShape' is not assignable to type 'never'") and fails at
 * runtime with "Service not found: oytc/AppOptions". Declaring the globals via
 * `Command.make("oytc", {flags})` instead of withSharedFlags makes subcommands
 * reject them outright ("Unrecognized flag: --format").
 */

import { Effect, Layer, Result } from "effect"
import { Command } from "../effect.ts"
import { AppOptions, ProcessEnv } from "../services/index.ts"
import { globalFlags } from "./flags.ts"
import { resolveGlobals } from "./globals.ts"

const DESCRIPTION =
  "Read public YouTube data and your own channel analytics from the command line."

/**
 * Subcommands are registered here as they are implemented. Each entry comes
 * from its own module, so parallel packages never edit this list concurrently
 * beyond adding their own import.
 */
const subcommands: ReadonlyArray<never> = []

export const root = Command.make("oytc").pipe(
  Command.withDescription(DESCRIPTION),
  Command.withSharedFlags(globalFlags),
  Command.withSubcommands(subcommands),
  Command.provide((input) =>
    Layer.effect(
      AppOptions,
      Effect.gen(function* () {
        const env = yield* ProcessEnv
        const resolved = resolveGlobals(input, { isOutputTTY: env.isOutputTTY })
        if (Result.isFailure(resolved)) return yield* Effect.fail(resolved.failure)
        return resolved.success
      })
    )
  )
)

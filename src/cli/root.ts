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
import { ProcessEnvLive } from "../impl/processEnv.ts"
import { globalFlags } from "./flags.ts"
import { resolveGlobals } from "./globals.ts"
import { analyticsCommand } from "./analyticsCmd.ts"
import { authCommands } from "./auth.ts"
import { catalogCommands } from "./catalog.ts"
import { channelCommand } from "./channel.ts"
import { commentCommand } from "./comment.ts"
import { liveChatCommand } from "./livechat.ts"
import { playlistCommand } from "./playlist.ts"
import { searchCommand } from "./search.ts"
import { skillsCommand } from "./skillsCmd.ts"
import { subscriptionCommand } from "./subscription.ts"
import { versionUpdateCommands } from "./versionUpdate.ts"
import { videoCommand } from "./video.ts"

const DESCRIPTION =
  "Read public YouTube data and your own channel analytics from the command line."

/**
 * The full command tree: 12 group commands over 30 runnable leaves.
 *
 * Group commands (`analytics`, `channel`, …) carry no handler, so invoking one
 * bare prints help and exits 0 — matching cobra, where those commands had no
 * `RunE`.
 */
const subcommands = [
  ...authCommands,
  analyticsCommand,
  searchCommand,
  channelCommand,
  videoCommand,
  playlistCommand,
  commentCommand,
  subscriptionCommand,
  liveChatCommand,
  ...catalogCommands,
  ...versionUpdateCommands,
  skillsCommand
] as const

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
      // ProcessEnv is supplied here rather than left to main.ts's
      // `Effect.provide(AppLayer)`: this layer is constructed by
      // `Command.provide` during argument parsing, which happens before the
      // outer provide applies, so the requirement must be discharged locally.
    ).pipe(Layer.provide(ProcessEnvLive))
  )
)

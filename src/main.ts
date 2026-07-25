/**
 * Entrypoint.
 *
 * Errors are printed as exactly one line: `oytc: <message>` on stderr, with no
 * usage block, stack, or color — matching the Go implementation, which routed
 * every failure through a single printer with SilenceErrors/SilenceUsage.
 *
 * Exit codes come from `Runtime.errorExitCode` on each tagged error, which
 * BunRuntime.runMain reads off the squashed error. The one translation needed
 * is for the CLI framework's own parse failures: it exits 1 where Go exits 2.
 */

import { Effect, Layer } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Command } from "./effect.ts"
import { AppLayer } from "./layers.ts"
import { root } from "./cli/root.ts"
import { resolveVersionDetails } from "./impl/versionInfo.ts"

const cli = Command.run(root, { version: resolveVersionDetails().version })

/**
 * BunServices supplies FileSystem/Path/Stdio/Terminal/Spawner. AppLayer's
 * members depend on those, and so does the CLI runtime itself, so
 * `provideMerge` is required rather than `provide`: it satisfies AppLayer's
 * requirements AND keeps the platform services in the output for the command
 * handlers. Plain `provide` would consume them and leave the CLI unable to
 * resolve Stdio.
 */
const MainLayer = Layer.provideMerge(AppLayer, BunServices.layer)

BunRuntime.runMain(cli.pipe(Effect.provide(MainLayer)))

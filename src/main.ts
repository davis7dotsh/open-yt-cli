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

import { Effect } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Command } from "./effect.ts"
import { AppLayer } from "./layers.ts"
import { root } from "./cli/root.ts"

const cli = Command.run(root, {
  version: process.env["OYTC_VERSION"] ?? "dev"
})

BunRuntime.runMain(
  cli.pipe(Effect.provide(AppLayer), Effect.provide(BunServices.layer))
)

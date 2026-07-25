/**
 * The application Layer graph.
 *
 * Written once, in the foundation. Feature packages supply the `make*`
 * functions in `src/impl/`; this wiring does not change as they land.
 *
 * `AppOptions` is deliberately NOT here — it is per-invocation and supplied by
 * `Command.provide` in cli/root.ts, because it depends on parsed flags.
 */

import { Layer } from "effect"
import { ProcessEnvLive } from "./impl/processEnv.ts"

export const AppLayer = Layer.mergeAll(ProcessEnvLive)

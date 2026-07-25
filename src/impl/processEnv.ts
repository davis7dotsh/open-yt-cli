/**
 * ProcessEnv — the single seam through which the rest of the code sees the
 * host process. Keeping `process.*` here means everything else is testable
 * with a mock layer.
 */

import { Effect, Layer, Option } from "effect"
import { OperationalError } from "../domain/errors.ts"
import { ProcessEnv, type ProcessEnvShape } from "../services/index.ts"

export const makeProcessEnv: ProcessEnvShape = {
  env: (name) => Option.fromNullishOr(process.env[name]),
  platform: process.platform,
  arch: process.arch,
  argv: process.argv,
  executablePath: Effect.try({
    try: () => process.execPath,
    catch: (cause) =>
      new OperationalError({ message: "could not determine executable path", cause })
  }),
  isOutputTTY: process.stdout.isTTY === true,
  homeDir: Effect.gen(function* () {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"]
    if (home === undefined || home === "") {
      return yield* Effect.fail(
        new OperationalError({ message: "could not determine home directory" })
      )
    }
    return home
  })
}

export const ProcessEnvLive = Layer.succeed(ProcessEnv, makeProcessEnv)

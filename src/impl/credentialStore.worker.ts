/**
 * Test-only worker for the cross-process locking test.
 *
 * NOT part of the CLI — nothing imports it, so `bun build --compile` never
 * reaches it. It exists because the interesting half of the credential lock
 * cannot be observed from inside one process: Go's flock is per-open-file-
 * description, so two goroutines contend the same way two processes do, but
 * this port's in-process `Semaphore` would happily satisfy a same-process test
 * even if the O_EXCL lockfile were completely broken. Only real subprocesses
 * prove the cross-process guarantee.
 *
 * Usage: `bun run credentialStore.worker.ts <configDir> <mode> <iterations>`
 *
 *   key    — save "api-secret-<i>", i = 0..n-1
 *   oauth  — save an oauth block with accessToken "access-<i>"
 *   read   — load n times, asserting the file is never observed torn
 *
 * Exits 0 on success. Any failure is written to stderr and exits 1; the test
 * asserts stderr is empty, so a partial read or a lost update is loud.
 */

import { Effect, Layer, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import { OperationalError } from "../domain/errors.ts"
import {
  CredentialStore,
  ProcessEnv,
  type CredentialStoreShape,
  type ProcessEnvShape,
  type StoredOAuth
} from "../services/index.ts"
import { CredentialStoreLive } from "./credentialStore.ts"
import { FileLockLive } from "./fileLock.ts"

const [configDir, mode, iterationsText] = process.argv.slice(2)

if (configDir === undefined || mode === undefined || iterationsText === undefined) {
  process.stderr.write("usage: credentialStore.worker.ts <configDir> <mode> <iterations>\n")
  process.exit(1)
}

const iterations = Number.parseInt(iterationsText, 10)

const processEnv: ProcessEnvShape = {
  env: (name) => Option.fromNullishOr(name === "OYTC_CONFIG_DIR" ? configDir : undefined),
  platform: process.platform,
  arch: process.arch,
  argv: process.argv,
  executablePath: Effect.succeed(process.execPath),
  isOutputTTY: false,
  homeDir: Effect.fail(new OperationalError({ message: "could not determine home directory" }))
}

const platform = BunServices.layer as unknown as Layer.Layer<never>

const layer = CredentialStoreLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      platform,
      Layer.succeed(ProcessEnv, processEnv),
      FileLockLive.pipe(Layer.provide(platform))
    )
  )
) as unknown as Layer.Layer<(typeof CredentialStore)["Identifier"]>

const oauthFor = (index: number): StoredOAuth => ({
  clientId: "id",
  clientSecret: "secret",
  accessToken: `access-${index}`,
  refreshToken: "refresh",
  expiry: "2026-02-01T12:00:00Z",
  scopes: ["scope"]
})

const step = (store: CredentialStoreShape, index: number): Effect.Effect<void, unknown> => {
  switch (mode) {
    case "key":
      return Effect.asVoid(store.save(`api-secret-${index}`))
    case "oauth":
      return Effect.asVoid(store.saveOAuth(oauthFor(index)))
    case "read":
      // A torn read shows up as a parse error, which `load` surfaces as a
      // failure (there is no OYTC_API_KEY here to mask it).
      return Effect.asVoid(store.load)
    default:
      return Effect.fail(new Error(`unknown worker mode: ${mode}`))
  }
}

const program = Effect.gen(function* () {
  const store = yield* CredentialStore
  for (let index = 0; index < iterations; index++) {
    yield* step(store, index)
  }
})

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>
)

if (exit._tag === "Failure") {
  process.stderr.write(`worker ${mode} failed: ${String(exit.cause)}\n`)
  process.exit(1)
}

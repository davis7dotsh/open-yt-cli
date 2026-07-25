/**
 * `version` / `update` tests.
 *
 * The two things worth guarding hardest are the `update` field renames
 * (`assetName` -> `asset`, `executablePath` -> `executable`) and G4's
 * sorted-JSON / declaration-order-TSV split, because both are invisible until
 * a consumer's script breaks.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import { OperationalError, type OytcError } from "../domain/errors.ts"
import { makeRendererWith } from "../impl/renderer.ts"
import { updateColumns, versionColumns } from "../output/columns.ts"
import {
  AppOptions,
  Renderer,
  Updater,
  VersionInfo,
  type AppOptionsShape,
  type OutputFormat,
  type UpdateOptions,
  type UpdateResult,
  type VersionDetails
} from "../services/index.ts"
import { globalFlags } from "./flags.ts"
import {
  isUpToDate,
  updateCommand,
  versionCommand,
  versionUpdateCommands
} from "./versionUpdate.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const details: VersionDetails = {
  version: "v0.3.3",
  commit: "699879f7a454180ef4039d096ce2b898a96486f6",
  date: "2026-07-25T05:47:34Z",
  goVersion: "bun1.3.14",
  os: "darwin",
  arch: "arm64"
}

const updateResult = (overrides?: Partial<UpdateResult>): UpdateResult => ({
  currentVersion: "v0.3.0",
  latestVersion: "v0.4.0",
  updated: false,
  asset: "oytc_v0.4.0_darwin_arm64.tar.gz",
  executable: "/usr/local/bin/oytc",
  ...overrides
})

interface RunOptions {
  readonly format?: OutputFormat | undefined
  readonly columns?: ReadonlyArray<string> | undefined
  readonly noHeader?: boolean | undefined
  readonly result?: UpdateResult | undefined
  readonly error?: OytcError | undefined
  readonly version?: VersionDetails | undefined
}

const runCommand = async (
  argv: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<{
  readonly stdout: string
  readonly exit: Exit.Exit<void, OytcError>
  readonly updateCalls: ReadonlyArray<UpdateOptions>
}> => {
  const out: Array<string> = []
  const updateCalls: Array<UpdateOptions> = []
  const decode = (i: string | Uint8Array): string =>
    typeof i === "string" ? i : new TextDecoder().decode(i)

  const stdio = Stdio.layerTest({
    stdout: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => out.push(decode(i)))),
    stderr: () => Sink.forEach(() => Effect.void)
  })

  const appOptions: AppOptionsShape = {
    format: options.format ?? "table",
    columns: options.columns ?? [],
    noHeader: options.noHeader ?? false,
    quiet: false,
    timeoutMillis: 20_000,
    isOutputTTY: true
  }

  const layers = Layer.mergeAll(
    Layer.succeed(AppOptions, appOptions),
    Layer.succeed(VersionInfo, { get: Effect.succeed(options.version ?? details) }),
    Layer.succeed(Updater, {
      run: (opts: UpdateOptions) =>
        Effect.suspend(() => {
          updateCalls.push(opts)
          return options.error === undefined
            ? Effect.succeed(options.result ?? updateResult())
            : Effect.fail(options.error)
        })
    }),
    Layer.succeed(
      Renderer,
      makeRendererWith((text) => Effect.sync(() => void out.push(text)))
    )
  )

  const root = Command.make("oytc").pipe(
    Command.withSharedFlags(globalFlags),
    Command.withSubcommands([...versionUpdateCommands])
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(root, { version: "test" })(argv).pipe(
      Effect.provide(Layer.mergeAll(layers, stdio))
    ) as Effect.Effect<void, OytcError>
  )
  return { stdout: out.join(""), exit, updateCalls }
}

const failureOf = (exit: Exit.Exit<unknown, OytcError>): OytcError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const found = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (found === undefined) throw new Error(`no Fail reason: ${String(exit.cause)}`)
  return (found as { readonly error: OytcError }).error
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

describe("version", () => {
  test("the table rendering matches Go's four lines exactly", async () => {
    const { stdout, exit } = await runCommand(["version"], { format: "table" })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stdout).toBe(
      "oytc v0.3.3\n" +
        "commit: 699879f7a454180ef4039d096ce2b898a96486f6\n" +
        "built: 2026-07-25T05:47:34Z\n" +
        "go: bun1.3.14 (darwin/arm64)\n"
    )
  })

  test("G4: json keys are SORTED alphabetically", async () => {
    const { stdout } = await runCommand(["version"], { format: "json" })
    const keys = [...stdout.matchAll(/^ {2}"([^"]+)"/gm)].map((m) => m[1])
    expect(keys).toEqual(["arch", "commit", "date", "goVersion", "os", "version"])
  })

  test("G4: tsv headers are in DECLARATION order, not sorted", async () => {
    const { stdout } = await runCommand(["version"], { format: "tsv" })
    const header = stdout.split("\n")[0]!.split("\t")
    expect(header).toEqual(["VERSION", "COMMIT", "DATE", "GOVERSION", "OS", "ARCH"])
    // Explicitly NOT the sorted order the JSON form uses.
    expect(header).not.toEqual([...header].sort())
  })

  test("the tsv row carries the values in the same declaration order", async () => {
    const { stdout } = await runCommand(["version"], { format: "tsv" })
    expect(stdout.split("\n")[1]!.split("\t")).toEqual([
      "v0.3.3",
      "699879f7a454180ef4039d096ce2b898a96486f6",
      "2026-07-25T05:47:34Z",
      "bun1.3.14",
      "darwin",
      "arm64"
    ])
  })

  test("`goVersion` keeps its Go spelling — it is a documented column", async () => {
    const { stdout } = await runCommand(["version"], { format: "json" })
    expect(stdout).toContain('"goVersion"')
    expect(stdout).not.toContain('"bunVersion"')
    expect(stdout).not.toContain('"runtimeVersion"')
    expect(versionColumns).toContain("goVersion")
  })

  test("jsonl is a single compact line", async () => {
    const { stdout } = await runCommand(["version"], { format: "jsonl" })
    expect(stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(stdout).toStartWith('{"arch":"arm64"')
  })

  test("--no-header drops the tsv header row", async () => {
    const { stdout } = await runCommand(["version"], { format: "tsv", noHeader: true })
    expect(stdout).toStartWith("v0.3.3\t")
  })

  test("--columns overrides the default column list", async () => {
    const { stdout } = await runCommand(["version"], {
      format: "tsv",
      columns: ["os", "arch"]
    })
    expect(stdout).toBe("OS\tARCH\ndarwin\tarm64\n")
  })

  test("a default (unstamped) build reports dev/unknown/unknown", async () => {
    const { stdout } = await runCommand(["version"], {
      format: "table",
      version: { ...details, version: "dev", commit: "unknown", date: "unknown" }
    })
    expect(stdout).toStartWith("oytc dev\ncommit: unknown\nbuilt: unknown\n")
  })
})

// ---------------------------------------------------------------------------
// update — the field renames
// ---------------------------------------------------------------------------

describe("update field renames", () => {
  test("emits `asset` and `executable`, NOT assetName/executablePath", async () => {
    const { stdout } = await runCommand(["update", "--check"], { format: "json" })
    expect(stdout).toContain('"asset"')
    expect(stdout).toContain('"executable"')
    expect(stdout).not.toContain('"assetName"')
    expect(stdout).not.toContain('"executablePath"')
  })

  test("the renamed keys carry the right values", async () => {
    const { stdout } = await runCommand(["update", "--check"], { format: "json" })
    expect(stdout).toContain('"asset": "oytc_v0.4.0_darwin_arm64.tar.gz"')
    expect(stdout).toContain('"executable": "/usr/local/bin/oytc"')
  })

  test("the tsv column list uses the renamed keys in declaration order", async () => {
    const { stdout } = await runCommand(["update", "--check"], { format: "tsv" })
    expect(stdout.split("\n")[0]!.split("\t")).toEqual([
      "CURRENTVERSION",
      "TARGETVERSION",
      "UPDATED",
      "UPTODATE",
      "ASSET",
      "EXECUTABLE"
    ])
    expect(updateColumns).toEqual([
      "currentVersion",
      "targetVersion",
      "updated",
      "upToDate",
      "asset",
      "executable"
    ])
  })

  test("`latestVersion` is emitted under the key `targetVersion`", async () => {
    // The service contract calls it latestVersion; the CLI's output contract
    // calls it targetVersion. Both names must not appear.
    const { stdout } = await runCommand(["update", "--check"], { format: "json" })
    expect(stdout).toContain('"targetVersion": "v0.4.0"')
    expect(stdout).not.toContain('"latestVersion"')
  })
})

// ---------------------------------------------------------------------------
// update — up-to-date derivation and the three table sentences
// ---------------------------------------------------------------------------

describe("isUpToDate", () => {
  test("identical comparable versions are up to date", () => {
    expect(isUpToDate("v1.2.3", "v1.2.3")).toBe(true)
  })

  test("a newer remote is not up to date", () => {
    expect(isUpToDate("v1.3.0", "v1.2.3")).toBe(false)
  })

  test("an older remote is not up to date", () => {
    expect(isUpToDate("v1.0.0", "v1.2.3")).toBe(false)
  })

  test("an incomparable pair is not up to date", () => {
    expect(isUpToDate("v1.2.3", "dev")).toBe(false)
    expect(isUpToDate("", "")).toBe(false)
  })

  test("a `v` prefix difference still compares equal", () => {
    expect(isUpToDate("v1.2.3", "1.2.3")).toBe(true)
  })
})

describe("update table renderings", () => {
  test("up to date", async () => {
    const { stdout } = await runCommand(["update", "--check"], {
      format: "table",
      result: updateResult({ currentVersion: "v0.4.0", latestVersion: "v0.4.0" })
    })
    expect(stdout).toBe("oytc v0.4.0 is already the latest release.\n")
  })

  test("updated", async () => {
    const { stdout } = await runCommand(["update"], {
      format: "table",
      result: updateResult({ updated: true })
    })
    expect(stdout).toBe("Updated v0.3.0 -> v0.4.0 (/usr/local/bin/oytc)\n")
  })

  test("available but not installed (the --check case)", async () => {
    const { stdout } = await runCommand(["update", "--check"], { format: "table" })
    expect(stdout).toBe(
      "Update available: v0.4.0 (current: v0.3.0)\nRun 'oytc update' to install it.\n"
    )
  })

  test("up-to-date wins over updated when both could apply", async () => {
    const { stdout } = await runCommand(["update"], {
      format: "table",
      result: updateResult({ currentVersion: "v0.4.0", latestVersion: "v0.4.0", updated: true })
    })
    expect(stdout).toStartWith("oytc v0.4.0 is already the latest release.")
  })
})

// ---------------------------------------------------------------------------
// update — flags
// ---------------------------------------------------------------------------

describe("update flags", () => {
  test("--check is forwarded as checkOnly", async () => {
    const { updateCalls } = await runCommand(["update", "--check"])
    expect(updateCalls).toEqual([{ checkOnly: true, targetVersion: "" }])
  })

  test("without --check, checkOnly is false", async () => {
    const { updateCalls } = await runCommand(["update"])
    expect(updateCalls).toEqual([{ checkOnly: false, targetVersion: "" }])
  })

  test("--version takes a STRING tag, shadowing the built-in version flag", async () => {
    const { updateCalls, exit } = await runCommand(["update", "--version=v0.2.0"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(updateCalls).toEqual([{ checkOnly: false, targetVersion: "v0.2.0" }])
  })

  test("--version combines with --check", async () => {
    const { updateCalls } = await runCommand(["update", "--check", "--version=v0.2.0"])
    expect(updateCalls).toEqual([{ checkOnly: true, targetVersion: "v0.2.0" }])
  })

  test("an updater failure propagates and nothing is rendered", async () => {
    const boom = new OperationalError({ message: "release not found" })
    const { exit, stdout } = await runCommand(["update", "--check"], { error: boom })
    expect(failureOf(exit)).toBe(boom)
    expect(stdout).toBe("")
  })

  test("--columns overrides the default column list", async () => {
    const { stdout } = await runCommand(["update", "--check"], {
      format: "tsv",
      columns: ["asset"]
    })
    expect(stdout).toBe("ASSET\noytc_v0.4.0_darwin_arm64.tar.gz\n")
  })

  test("the `updated` boolean is a real JSON boolean, pretty-printed", async () => {
    const { stdout } = await runCommand(["update"], {
      format: "json",
      result: updateResult({ updated: true })
    })
    // Go's MarshalIndent emits `"updated": true` with a space after the colon.
    expect(stdout).toContain('"updated": true')
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("command registration", () => {
  test("both commands are exported with Go's names", () => {
    expect(versionUpdateCommands.map((c) => c.name)).toEqual(["version", "update"])
    expect(versionCommand.name).toBe("version")
    expect(updateCommand.name).toBe("update")
  })

  test("`upgrade` is registered as an alias of update", () => {
    expect(updateCommand.alias).toBe("upgrade")
  })

  test("version's description matches Go's Short string", () => {
    expect(versionCommand.description).toBe("Show version, commit, and build date")
  })

  test("update's description is Go's multi-paragraph Long text", () => {
    expect(updateCommand.description).toStartWith(
      "Downloads the matching release archive and checksums.txt from GitHub Releases,"
    )
    expect(updateCommand.description).toContain("'oytc upgrade' is an alias")
  })

  test("`oytc upgrade` resolves to the update command", async () => {
    const { updateCalls, exit } = await runCommand(["upgrade", "--check"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(updateCalls).toEqual([{ checkOnly: true, targetVersion: "" }])
  })
})

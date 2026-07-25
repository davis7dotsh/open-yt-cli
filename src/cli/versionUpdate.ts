/**
 * `version` and `update` — the port of `internal/cli/version_update.go`.
 *
 * Both commands share one shape: `--format table` renders a hand-written human
 * block, and every other format goes through `RenderObject` with an explicit
 * column list. Neither command ever touches the credential store.
 *
 * Three details are load-bearing:
 *
 *   - **`update` renames two fields.** The updater's `assetName` is emitted as
 *     the column `asset` and `executablePath` as `executable`. The rename IS
 *     the output contract, so a naive spread would emit the wrong keys in both
 *     JSON and TSV.
 *   - **`goVersion` keeps its Go spelling.** DEVIATIONS G4: `--format json`
 *     sorts keys alphabetically (arch, commit, date, goVersion, os, version)
 *     while `--format tsv` uses declaration order (VERSION, COMMIT, DATE,
 *     GOVERSION, OS, ARCH). The command must NOT re-sort the TSV columns; the
 *     divergence is real and golden-verified against the Go binary.
 *   - **`upToDate` is recomputed, not returned.** The frozen `UpdaterShape`
 *     contract exposes `latestVersion` and has no `upToDate` flag, but the
 *     table rendering needs it to choose between three sentences. It is
 *     recovered with `compareVersions(latestVersion, currentVersion)` being
 *     `{comparable: true, order: 0}` — the exact predicate `runUpdate` used to
 *     set the flag in the first place (see impl/updater.ts `toUpdateResult`).
 *
 * `update --version <tag>` shadows the framework's own `--version`, exactly as
 * cobra's local-flag lookup did: leaf flags are resolved before built-ins.
 */

import { Effect, Stdio, Stream } from "effect"
import { Command, Flag } from "../effect.ts"
import { OperationalError } from "../domain/errors.ts"
import type { JsonObject } from "../json/value.ts"
import { compareVersions } from "../impl/semver.ts"
import { updateColumns, versionColumns } from "../output/columns.ts"
import {
  AppOptions,
  Renderer,
  Updater,
  VersionInfo,
  type AppOptionsShape,
  type OutputFormat
} from "../services/index.ts"

/**
 * Raw stdout, for the human `table` renderings that bypass `Renderer`.
 *
 * Go wrote these with `fmt.Fprintf(a.Out, …)`, i.e. straight to the same
 * writer `output.Render` used, so both must land on the same stream in the
 * same order. Routing through `Stdio` rather than `Console.log` keeps that
 * true and keeps the text capturable by `Stdio.layerTest` in tests.
 */
const writeOut = (text: string): Effect.Effect<void, OperationalError, Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stdout()).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write output", cause }))
      )
    )
  })

/** `--columns` when the user supplied any, else the command's default list. */
const columnsFor = (
  options: AppOptionsShape,
  defaults: ReadonlyArray<string>
): ReadonlyArray<string> => (options.columns.length > 0 ? options.columns : defaults)

const isTable = (format: OutputFormat): boolean => format === "table"

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

export const versionCommand = Command.make("version", {}, () =>
  Effect.gen(function* () {
    const options = yield* AppOptions
    const versionInfo = yield* VersionInfo
    const info = yield* versionInfo.get

    if (!isTable(options.format)) {
      const state: JsonObject = {
        version: info.version,
        commit: info.commit,
        date: info.date,
        goVersion: info.goVersion,
        os: info.os,
        arch: info.arch
      }
      const renderer = yield* Renderer
      return yield* renderer.renderObject(state, {
        format: options.format,
        columns: columnsFor(options, versionColumns),
        noHeader: options.noHeader
      })
    }

    yield* writeOut(
      `oytc ${info.version}\n` +
        `commit: ${info.commit}\n` +
        `built: ${info.date}\n` +
        `go: ${info.goVersion} (${info.os}/${info.arch})\n`
    )
  })
).pipe(Command.withDescription("Show version, commit, and build date"))

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const UPDATE_DESCRIPTION =
  "Downloads the matching release archive and checksums.txt from GitHub Releases,\n" +
  "verifies the archive's SHA-256, and atomically replaces the current executable.\n" +
  "The updater never reads or transmits the YouTube API key.\n\n" +
  "'oytc upgrade' is an alias, and the installer also provides oytc_update and\n" +
  "oytc_upgrade shims that run the same operation."

/**
 * `result.UpToDate` recovered from the contract-shaped result.
 *
 * `runUpdate` sets the flag when `compareVersions(tag, current)` is comparable
 * and equal, and returns early — so an up-to-date run also has `updated: false`
 * and an empty `asset`. Recomputing the same predicate here is exact, not an
 * approximation.
 */
export const isUpToDate = (latestVersion: string, currentVersion: string): boolean => {
  const comparison = compareVersions(latestVersion, currentVersion)
  return comparison.comparable && comparison.order === 0
}

export const updateCommand = Command.make(
  "update",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("only report whether a newer release exists")
    ),
    /**
     * Shadows the framework's built-in `--version`. A plain string flag with an
     * empty default, so "not passed" and "passed empty" coincide — which is
     * what Go's zero-value string did.
     */
    targetVersion: Flag.string("version").pipe(
      Flag.withDefault(""),
      Flag.withDescription("install this exact release tag (e.g. v0.2.0) instead of the latest")
    )
  },
  ({ check, targetVersion }) =>
    Effect.gen(function* () {
      const options = yield* AppOptions
      const updater = yield* Updater
      const result = yield* updater.run({ checkOnly: check, targetVersion })
      const upToDate = isUpToDate(result.latestVersion, result.currentVersion)

      if (!isTable(options.format)) {
        // The two renames live here and nowhere else.
        const state: JsonObject = {
          currentVersion: result.currentVersion,
          targetVersion: result.latestVersion,
          updated: result.updated,
          upToDate,
          asset: result.asset,
          executable: result.executable
        }
        const renderer = yield* Renderer
        return yield* renderer.renderObject(state, {
          format: options.format,
          columns: columnsFor(options, updateColumns),
          noHeader: options.noHeader
        })
      }

      if (upToDate) {
        return yield* writeOut(`oytc ${result.currentVersion} is already the latest release.\n`)
      }
      if (result.updated) {
        return yield* writeOut(
          `Updated ${result.currentVersion} -> ${result.latestVersion} (${result.executable})\n`
        )
      }
      yield* writeOut(
        `Update available: ${result.latestVersion} (current: ${result.currentVersion})\n` +
          "Run 'oytc update' to install it.\n"
      )
    })
).pipe(Command.withDescription(UPDATE_DESCRIPTION), Command.withAlias("upgrade"))

/** Registered by the orchestrator in root.ts. */
export const versionUpdateCommands = [versionCommand, updateCommand] as const

/**
 * `VersionInfo` — the port of `internal/version/version.go`.
 *
 * Go injected three package variables with `-ldflags -X`. Bun's equivalent is
 * `--define`, which textually substitutes a bare identifier at build time:
 *
 *     bun build --compile \
 *       --define OYTC_VERSION='"v1.2.3"' \
 *       --define OYTC_COMMIT='"abc1234"' \
 *       --define OYTC_DATE='"2026-01-02T15:04:05Z"'
 *
 * `typeof OYTC_VERSION === "string"` is safe on an *undeclared* identifier, so
 * an un-defined build folds to the default. Defaults match Go exactly:
 * `dev` / `unknown` / `unknown`.
 *
 * **The Go build-info fallback is dropped, deliberately.** Go consulted
 * `debug.ReadBuildInfo()` so that `go install pkg@v1.2.3` and VCS stamping
 * produced a real version without ldflags. Bun has no analogue. (SPEC §5.2
 * documents this as the expected port.)
 *
 * Two keys deserve a note:
 *
 * - **`goVersion` is retained.** It is a documented JSON column and the
 *   `version` table's `go:` line, so renaming it would be an API change. It
 *   now carries the Bun version, formatted `bun<semver>` to mirror Go's
 *   `go1.26.5` shape.
 * - **`os`/`arch` are normalized to Go's spellings** (`win32` -> `windows`,
 *   `x64` -> `amd64`). Without this, `oytc version` on linux-x64 would start
 *   reporting `x64` where every previous release reported `amd64`, and the
 *   value would no longer match the release asset the user downloaded.
 */

import { Effect, Layer } from "effect"
import { VersionInfo, type VersionDetails, type VersionInfoShape } from "../services/index.ts"

declare const OYTC_VERSION: string
declare const OYTC_COMMIT: string
declare const OYTC_DATE: string

// `typeof <undeclared>` is the one expression that does not throw a
// ReferenceError, so these read as the substituted literal in a stamped build
// and as `undefined` in an unstamped one.
const definedVersion = (): string | undefined =>
  typeof OYTC_VERSION === "string" && OYTC_VERSION !== "" ? OYTC_VERSION : undefined
const definedCommit = (): string | undefined =>
  typeof OYTC_COMMIT === "string" && OYTC_COMMIT !== "" ? OYTC_COMMIT : undefined
const definedDate = (): string | undefined =>
  typeof OYTC_DATE === "string" && OYTC_DATE !== "" ? OYTC_DATE : undefined

/** `process.platform` -> Go's `runtime.GOOS`. Only `win32` differs. */
export const goos = (platform: string): string => (platform === "win32" ? "windows" : platform)

/** `process.arch` -> Go's `runtime.GOARCH`. */
export const goarch = (arch: string): string =>
  arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch

/** Go's `runtime.Version()` analogue: the runtime name with its version. */
export const runtimeVersion = (): string =>
  typeof Bun === "undefined" ? `node${process.versions.node}` : `bun${Bun.version}`

/**
 * Resolve the effective build metadata.
 *
 * `overrides` is the test seam that replaces Go's mutable package variables
 * (`version.Version = "v9.9.9"` in `TestGetUsesInjectedValues`). Production
 * calls pass nothing and get the build-time defines.
 *
 * The `OYTC_*` environment variables are consulted only when the corresponding
 * define is absent, which keeps `bun run src/main.ts` agreeing with `main.ts`'s
 * own `process.env["OYTC_VERSION"]` read while leaving a stamped release
 * binary immune to environment tampering.
 */
export const resolveVersionDetails = (overrides?: {
  readonly version?: string | undefined
  readonly commit?: string | undefined
  readonly date?: string | undefined
  readonly platform?: string | undefined
  readonly arch?: string | undefined
  readonly runtime?: string | undefined
  readonly env?: (name: string) => string | undefined
}): VersionDetails => {
  const env = overrides?.env ?? ((name: string) => process.env[name])
  const pick = (
    override: string | undefined,
    defined: string | undefined,
    envName: string,
    fallback: string
  ): string => {
    if (override !== undefined && override !== "") return override
    if (defined !== undefined) return defined
    const fromEnv = env(envName)
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : fallback
  }

  return {
    version: pick(overrides?.version, definedVersion(), "OYTC_VERSION", "dev"),
    commit: pick(overrides?.commit, definedCommit(), "OYTC_COMMIT", "unknown"),
    date: pick(overrides?.date, definedDate(), "OYTC_DATE", "unknown"),
    goVersion: overrides?.runtime ?? runtimeVersion(),
    os: goos(overrides?.platform ?? process.platform),
    arch: goarch(overrides?.arch ?? process.arch)
  }
}

export const makeVersionInfo: VersionInfoShape = {
  get: Effect.sync(() => resolveVersionDetails())
}

export const VersionInfoLive = Layer.succeed(VersionInfo, makeVersionInfo)

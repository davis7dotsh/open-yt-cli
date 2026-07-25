/**
 * THE PLATFORM MATRIX. **[MATRIX]**
 *
 * Two mappings live here and must never be confused:
 *
 *   (a) `process.platform` / `process.arch` -> Go's `GOOS` / `GOARCH` tokens.
 *       These are the tokens baked into RELEASE ASSET NAMES. They are frozen:
 *       every oytc already installed in the world computes its own update
 *       asset name from them, so renaming `amd64` to `x64` would strand every
 *       existing client. The Go binary is gone; the names it minted are not.
 *
 *   (b) Go's `GOOS` / `GOARCH` tokens -> `bun build --compile --target` tokens
 *       (`bun-linux-x64`, ...). A BUILD-TIME concern only; a bun token must
 *       never reach an asset name.
 *
 * `scripts/package.sh`, `site/install.sh`, `site/install.ps1` and the CI
 * workflows hardcode the same naming; `.depot/workflows/ci.yml` greps this
 * file for the literal `oytc_${tag}_${goos}_${goarch}` template in
 * `assetName` below to prove the three sources still agree. Do not reformat
 * that template literal.
 */

/** Go `GOOS` tokens the project publishes for. */
export type Goos = "linux" | "darwin" | "windows"

/** Go `GOARCH` tokens the project publishes for. */
export type Goarch = "amd64" | "arm64"

export interface Platform {
  readonly goos: Goos
  readonly goarch: Goarch
}

/** (a) `process.platform` -> `GOOS`. */
const GOOS_BY_NODE_PLATFORM: Readonly<Record<string, Goos>> = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows"
}

/** (a) `process.arch` -> `GOARCH`. */
const GOARCH_BY_NODE_ARCH: Readonly<Record<string, Goarch>> = {
  x64: "amd64",
  arm64: "arm64"
}

/** (b) `GOOS` -> the OS token in a `bun --target` triple. */
const BUN_OS_BY_GOOS: Readonly<Record<Goos, string>> = {
  linux: "linux",
  darwin: "darwin",
  windows: "windows"
}

/** (b) `GOARCH` -> the arch token in a `bun --target` triple. */
const BUN_ARCH_BY_GOARCH: Readonly<Record<Goarch, string>> = {
  amd64: "x64",
  arm64: "arm64"
}

/**
 * The five platforms the project builds and publishes.
 *
 * `windows/arm64` was published by the Go implementation and is deliberately
 * NOT here: `bun build --compile` has no `bun-windows-arm64` target. ARM64
 * Windows runs the `windows/amd64` build under emulation instead.
 */
export const SUPPORTED_PLATFORMS: ReadonlyArray<Platform> = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" }
]

/**
 * Platform pairs the Go implementation published but this one dropped.
 *
 * These hard-fail with a specific remedy rather than the generic
 * "release has no asset for this platform", because an already-installed
 * client WILL ask for one and deserves to be told why it vanished. Any other
 * unknown pair (say `linux/riscv64`) is formatted verbatim into an asset name
 * and fails later with the ordinary missing-asset error, exactly as the Go
 * updater did — `TestUpdateMissingAssetForPlatform` depends on that.
 */
const DROPPED: ReadonlyArray<Platform> = [{ goos: "windows", goarch: "arm64" }]

const isDropped = (goos: string, goarch: string): boolean =>
  DROPPED.some((p) => p.goos === goos && p.goarch === goarch)

export class UnsupportedPlatformError extends Error {
  override readonly name = "UnsupportedPlatformError"
  readonly goos: string
  readonly goarch: string
  constructor(goos: string, goarch: string, message: string) {
    super(message)
    this.goos = goos
    this.goarch = goarch
  }
}

const droppedMessage = (goos: string, goarch: string): string =>
  `oytc is not published for ${goos}/${goarch}; install the ${goos}/amd64 build instead, which runs under emulation on ARM64 Windows`

/**
 * Throws when the pair is one this project deliberately stopped publishing.
 * Call it early so the failure precedes any network traffic.
 */
export const assertBuildablePlatform = (goos: string, goarch: string): void => {
  if (isDropped(goos, goarch)) {
    throw new UnsupportedPlatformError(goos, goarch, droppedMessage(goos, goarch))
  }
}

export const isSupportedPlatform = (goos: string, goarch: string): boolean =>
  SUPPORTED_PLATFORMS.some((p) => p.goos === goos && p.goarch === goarch)

/** `zip` on Windows, `tar.gz` everywhere else. */
export const archiveExtension = (goos: string): string => (goos === "windows" ? "zip" : "tar.gz")

/** The single file at the archive root. */
export const binaryName = (goos: string): string => (goos === "windows" ? "oytc.exe" : "oytc")

/**
 * The release asset filename for a tag and platform,
 * e.g. `oytc_v0.1.0_linux_amd64.tar.gz`. The tag INCLUDES its leading `v`.
 *
 * Throws `UnsupportedPlatformError` for a dropped platform (`windows/arm64`).
 */
export const assetName = (tag: string, goos: string, goarch: string): string => {
  assertBuildablePlatform(goos, goarch)
  const ext = archiveExtension(goos)
  return `oytc_${tag}_${goos}_${goarch}.${ext}`
}

/** The `bun build --compile --target=` token for a published platform. */
export const bunTarget = (goos: Goos, goarch: Goarch): string =>
  `bun-${BUN_OS_BY_GOOS[goos]}-${BUN_ARCH_BY_GOARCH[goarch]}`

/** Every `bun --target` token the release build must produce, in matrix order. */
export const bunTargets = (): ReadonlyArray<string> =>
  SUPPORTED_PLATFORMS.map((p) => bunTarget(p.goos, p.goarch))

/**
 * Map the running process onto `GOOS`/`GOARCH`.
 *
 * Throws `UnsupportedPlatformError` when the host is not a platform oytc is
 * published for, so the failure names the host rather than an asset that was
 * never going to exist.
 */
export const hostPlatform = (platform: string, arch: string): Platform => {
  const goos = GOOS_BY_NODE_PLATFORM[platform]
  const goarch = GOARCH_BY_NODE_ARCH[arch]
  if (goos === undefined || goarch === undefined) {
    throw new UnsupportedPlatformError(
      goos ?? platform,
      goarch ?? arch,
      `oytc does not publish a build for ${platform}/${arch}`
    )
  }
  assertBuildablePlatform(goos, goarch)
  return { goos, goarch }
}

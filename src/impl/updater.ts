/**
 * Secure self-update from GitHub Releases — the port of
 * `internal/update/update.go`.
 *
 * The security posture is the point and is preserved verbatim: the updater
 * **never reads, needs, or transmits the YouTube API key**. The only network
 * traffic is unauthenticated GitHub release metadata and asset downloads.
 *
 * The chain of custody is: resolve a release -> compute the platform asset
 * name -> fetch `checksums.txt` -> stream the archive to disk while hashing it
 * -> compare SHA-256 -> extract with an exact-name traversal defense ->
 * atomically rename into place. Nothing is written next to the executable
 * until the digest matches.
 */

import { createHash } from "node:crypto"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "../effect.ts"
import { NotFoundError, OperationalError, type OytcError } from "../domain/errors.ts"
import {
  ProcessEnv,
  Updater,
  VersionInfo,
  type UpdateOptions,
  type UpdateResult,
  type UpdaterShape
} from "../services/index.ts"
import { extractBinary, MAX_ARCHIVE_BYTES } from "./archive.ts"
import { assertBuildablePlatform, assetName, binaryName, hostPlatform } from "./platformMatrix.ts"
import { compareVersions, goTrimSpace, isGoSpace } from "./semver.ts"

/** The canonical GitHub repository for oytc releases. */
export const DEFAULT_REPO = "davis7dotsh/open-yt-cli"

/** The GitHub REST API endpoint. */
export const DEFAULT_API_BASE_URL = "https://api.github.com"

/** The release checksum manifest filename. */
export const CHECKSUMS_NAME = "checksums.txt"

/** `4 << 20` — release JSON. */
const MAX_METADATA_BYTES = 4 << 20
/** `1 << 20` — checksums.txt. */
const MAX_CHECKSUM_BYTES = 1 << 20

const INSTALL_SCRIPT_URL = "https://davis7dotsh.github.io/open-yt-cli/install.sh"
const RELEASES_URL = `https://github.com/${DEFAULT_REPO}/releases`

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const operational = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({ message, ...(cause === undefined ? {} : { cause }) })

const failWith = (message: string, cause?: unknown) => Effect.fail(operational(message, cause))

/** Go renders a wrapped error as `outer: inner`; there is no stack, ever. */
const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  return String(cause)
}

const PERMISSION_TAGS = new Set(["PermissionDenied"])
const PERMISSION_CODES = new Set(["EACCES", "EPERM"])

/**
 * `errors.Is(err, os.ErrPermission)`. Effect surfaces a `PlatformError` whose
 * `reason._tag` is `"PermissionDenied"`; the raw errno is checked too because
 * a `BadArgument` reason keeps the original `cause`.
 */
const isPermissionDenied = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  let current: unknown = cause
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    const tag = record["_tag"]
    if (typeof tag === "string" && PERMISSION_TAGS.has(tag)) return true
    const code = record["code"]
    if (typeof code === "string" && PERMISSION_CODES.has(code)) return true
    current = record["reason"] ?? record["cause"]
  }
  return false
}

/**
 * `installPermissionError`. The guidance block is appended **only** when the
 * underlying failure really was a permission error; anything else is returned
 * unchanged, so a full disk does not tell the user to run as root.
 */
const installPermissionError = (executable: string, cause: unknown): OperationalError =>
  isPermissionDenied(cause)
    ? operational(
        `no permission to replace ${executable}: ${describe(cause)}\n` +
          "Re-run the update with sufficient privileges, or reinstall to a user-writable " +
          `location with the install script (${INSTALL_SCRIPT_URL})`,
        cause
      )
    : operational(describe(cause), cause)

// ---------------------------------------------------------------------------
// Release metadata
// ---------------------------------------------------------------------------

export interface ReleaseAsset {
  readonly name: string
  readonly browserDownloadUrl: string
}

export interface Release {
  readonly tagName: string
  readonly prerelease: boolean
  readonly assets: ReadonlyArray<ReleaseAsset>
}

/**
 * Parse the subset of the GitHub release payload the updater needs.
 *
 * Hand-rolled rather than schema-decoded because Go's `encoding/json` is
 * lenient here: a wrong-typed or missing field becomes its zero value rather
 * than an error, and only an empty `tag_name` is fatal. A strict schema would
 * reject payloads the Go updater accepted.
 */
export const parseRelease = (body: string): Release | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(body) as unknown
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    // Go unmarshals a JSON array or scalar into a struct as an error.
    return undefined
  }
  const record = raw as Record<string, unknown>
  const tagName = typeof record["tag_name"] === "string" ? record["tag_name"] : ""
  const prerelease = record["prerelease"] === true
  const rawAssets = Array.isArray(record["assets"]) ? (record["assets"] as ReadonlyArray<unknown>) : []
  const assets: Array<ReleaseAsset> = []
  for (const entry of rawAssets) {
    if (entry === null || typeof entry !== "object") continue
    const asset = entry as Record<string, unknown>
    assets.push({
      name: typeof asset["name"] === "string" ? asset["name"] : "",
      browserDownloadUrl:
        typeof asset["browser_download_url"] === "string" ? asset["browser_download_url"] : ""
    })
  }
  return { tagName, prerelease, assets }
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/**
 * Go's `strings.Fields` — split on runs of Unicode whitespace, dropping
 * empties. Implemented against Go's `unicode.IsSpace` set rather than the JS
 * `\s` class, because the two disagree: `\s` matches U+FEFF, Go does not.
 */
const goFields = (line: string): ReadonlyArray<string> => {
  const fields: Array<string> = []
  let current = ""
  for (const char of line) {
    if (isGoSpace(char.codePointAt(0) ?? 0)) {
      if (current !== "") fields.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current !== "") fields.push(current)
  return fields
}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * `ParseChecksums` — extract the SHA-256 digest for `name` from a
 * sha256sum-format manifest.
 *
 * Only lines with **exactly two** whitespace-separated fields are considered;
 * anything else is silently skipped, which is what lets a manifest carry
 * comments or a GPG armor block without breaking. `*` is sha256sum's
 * binary-mode marker and is stripped from the filename before matching.
 *
 * Returns an error message string on failure so the caller owns the error type.
 */
export const parseChecksums = (
  manifest: string,
  name: string
): { readonly digest: string } | { readonly error: string } => {
  for (const rawLine of manifest.split("\n")) {
    // `goTrimSpace`, not JS `trim()`: the two disagree on U+FEFF (JS strips it,
    // Go does not) and U+0085 (Go strips it, JS does not). Using `trim()` here
    // made a manifest line carrying a BOM parse where Go rejected it, which is
    // a divergence in the digest trust root.
    const fields = goFields(goTrimSpace(rawLine))
    if (fields.length !== 2) continue
    const filename = fields[1]!.startsWith("*") ? fields[1]!.slice(1) : fields[1]!
    if (filename !== name) continue
    const digest = fields[0]!.toLowerCase()
    if (!HEX64.test(digest)) {
      return { error: `${CHECKSUMS_NAME} contains a malformed digest for "${name}"` }
    }
    return { digest }
  }
  return { error: `${CHECKSUMS_NAME} has no entry for "${name}"` }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface UpdaterConfig {
  readonly repo: string
  readonly apiBaseUrl: string
  readonly currentVersion: string
  readonly goos: string
  readonly goarch: string
  /** Overrides `process.execPath` resolution; the seam the Go tests used. */
  readonly executablePath: string | undefined
}

/**
 * The full Go `Result`.
 *
 * `UpdaterShape["run"]` in the frozen service contract cannot carry
 * `targetVersion`/`upToDate` (it has `latestVersion` and no up-to-date flag),
 * so this richer record is exported for the CLI layer, which needs `upToDate`
 * to choose between the three table renderings in SPEC_AUTH_RELEASE §3.10.
 */
export interface UpdateRunResult {
  readonly currentVersion: string
  readonly targetVersion: string
  readonly updated: boolean
  readonly upToDate: boolean
  readonly assetName: string
  readonly executablePath: string
}

export type UpdaterServices = HttpClient.HttpClient | FileSystem.FileSystem | Path.Path

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const userAgent = (currentVersion: string): string => `oytc-updater/${currentVersion}`

/** Sentinel used to stop reading a body once it has passed its size cap. */
const OVERSIZED = Symbol.for("oytc/updater/oversized")

/**
 * `get()` — a size-capped GET with the updater's UA. 404 is distinguished
 * because Go's exit-code classifier keys off the literal "not found" in the
 * message, which maps a missing release to exit 4 rather than 6.
 */
const get = (
  config: UpdaterConfig,
  url: string,
  limit: number,
  accept: string
): Effect.Effect<string, OytcError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader("User-Agent", userAgent(config.currentVersion)),
      accept === "" ? (r) => r : HttpClientRequest.setHeader("Accept", accept)
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.catch((cause) => failWith(describe(cause), cause)))

    if (response.status === 404) {
      return yield* Effect.fail(
        new NotFoundError({ message: `GET ${url}: not found (has a release been published?)` })
      )
    }
    if (response.status !== 200) {
      return yield* failWith(`GET ${url}: unexpected status ${response.status}`)
    }

    // Go reads at most limit+1 bytes (`io.LimitReader`) and rejects a body that
    // filled the extra byte. Read the stream rather than `response.text` so at
    // most limit+1 bytes are ever RETAINED: `response.text` buffers the whole
    // body first and only then compares, so a 300 MB response was held in
    // memory to be rejected for exceeding 4 MB. Measured: this retains ~4 MB of
    // a 300 MB body.
    //
    // Note this bounds memory, not time — the underlying fetch body still
    // drains, so a genuinely endless response hangs here exactly as it did
    // before. A wall-clock timeout (Go used `http.Client{Timeout: 5*time.Minute}`)
    // is the missing piece and belongs with the HttpClient layer, not here.
    const chunks: Array<Uint8Array> = []
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.gen(function* () {
        if (size > limit) return
        chunks.push(chunk)
        size += chunk.length
        // One byte past the limit is enough to decide; stop pulling the body.
        if (size > limit) return yield* Effect.fail(OVERSIZED)
      })
    ).pipe(
      Effect.catch((cause) =>
        cause === OVERSIZED
          ? Effect.void
          : failWith(describe(cause), cause)
      )
    )
    if (size > limit) {
      return yield* failWith(`GET ${url}: response exceeds ${limit} bytes`)
    }

    const body = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      body.set(chunk, at)
      at += chunk.length
    }
    return new TextDecoder().decode(body)
  })

const apiBaseUrl = (config: UpdaterConfig): string =>
  (config.apiBaseUrl === "" ? DEFAULT_API_BASE_URL : config.apiBaseUrl).replace(/\/+$/, "")

const repoOf = (config: UpdaterConfig): string => (config.repo === "" ? DEFAULT_REPO : config.repo)

const resolveRelease = (
  config: UpdaterConfig,
  tag: string
): Effect.Effect<Release, OytcError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const base = apiBaseUrl(config)
    const endpoint =
      tag === ""
        ? `${base}/repos/${repoOf(config)}/releases/latest`
        : `${base}/repos/${repoOf(config)}/releases/tags/${tag.startsWith("v") ? tag : `v${tag}`}`

    const body = yield* get(config, endpoint, MAX_METADATA_BYTES, "application/vnd.github+json").pipe(
      // Go wraps with "resolve release: %w"; NotFoundError keeps its exit code
      // and its message still contains "not found", which is what matters.
      Effect.catchTag("OperationalError", (e) =>
        Effect.fail(operational(`resolve release: ${e.message}`, e.cause))
      ),
      Effect.catchTag("NotFoundError", (e) =>
        Effect.fail(new NotFoundError({ message: `resolve release: ${e.message}` }))
      )
    )

    const release = parseRelease(body)
    if (release === undefined) {
      return yield* failWith("parse release metadata: invalid JSON in release response")
    }
    if (release.tagName === "") {
      return yield* failWith("release metadata is missing a tag name")
    }
    return release
  })

/** Exact-name asset lookup; neither the archive nor the manifest is fuzzy-matched. */
const findAssets = (
  release: Release,
  asset: string
): Effect.Effect<{ readonly assetUrl: string; readonly checksumsUrl: string }, OytcError> =>
  Effect.gen(function* () {
    let assetUrl = ""
    let checksumsUrl = ""
    for (const entry of release.assets) {
      if (entry.name === asset) assetUrl = entry.browserDownloadUrl
      else if (entry.name === CHECKSUMS_NAME) checksumsUrl = entry.browserDownloadUrl
    }
    if (assetUrl === "") {
      return yield* failWith(`release ${release.tagName} has no asset "${asset}" for this platform`)
    }
    if (checksumsUrl === "") {
      return yield* failWith(
        `release ${release.tagName} has no ${CHECKSUMS_NAME} asset; refusing to install an unverifiable binary`
      )
    }
    return { assetUrl, checksumsUrl }
  })

const fetchChecksum = (
  config: UpdaterConfig,
  url: string,
  asset: string
): Effect.Effect<string, OytcError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = yield* get(config, url, MAX_CHECKSUM_BYTES, "").pipe(
      Effect.catchTag("OperationalError", (e) =>
        Effect.fail(operational(`download ${CHECKSUMS_NAME}: ${e.message}`, e.cause))
      ),
      Effect.catchTag("NotFoundError", (e) =>
        Effect.fail(new NotFoundError({ message: `download ${CHECKSUMS_NAME}: ${e.message}` }))
      )
    )
    const parsed = parseChecksums(body, asset)
    if ("error" in parsed) return yield* failWith(parsed.error)
    return parsed.digest
  })

/**
 * Stream the archive to `destination`, computing SHA-256 as bytes arrive so
 * the payload is never buffered whole and never hashed in a second pass.
 *
 * The 256 MiB cap **truncates** rather than erroring, matching Go's
 * `io.LimitReader`: an oversized asset then fails the digest comparison, which
 * is the same refusal by a different route.
 */
const downloadVerified = (
  config: UpdaterConfig,
  url: string,
  expected: string,
  destination: string
): Effect.Effect<void, OytcError, UpdaterServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader("User-Agent", userAgent(config.currentVersion))
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.catch((cause) => failWith(`download release archive: ${describe(cause)}`, cause)))
    if (response.status !== 200) {
      return yield* failWith(`download release archive: unexpected status ${response.status}`)
    }

    const hasher = createHash("sha256")
    let written = 0

    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs
          .open(destination, { flag: "w", mode: 0o600 })
          .pipe(
            Effect.catch((cause) =>
              failWith(`save release archive: ${describe(cause)}`, cause)
            )
          )
        yield* Stream.runForEach(response.stream, (chunk) =>
          Effect.gen(function* () {
            if (written >= MAX_ARCHIVE_BYTES) return
            const room = MAX_ARCHIVE_BYTES - written
            const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
            hasher.update(slice)
            written += slice.length
            yield* handle.writeAll(slice)
          })
        ).pipe(
          Effect.catch((cause) => failWith(`save release archive: ${describe(cause)}`, cause))
        )
      })
    )

    const actual = hasher.digest("hex")
    if (actual !== expected) {
      yield* fs.remove(destination, { force: true }).pipe(Effect.ignore)
      return yield* failWith(
        `checksum mismatch for downloaded archive: expected ${expected}, got ${actual}; refusing to install`
      )
    }
  })

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** Go's `os.CreateTemp(dir, "<prefix>*")`: a random decimal infix. */
const tempName = (prefix: string): string => `${prefix}${Math.floor(Math.random() * 0xffffffff)}`

/**
 * `checkWritable` — create and delete a probe file in the executable's
 * directory. Failing here means the replacement would fail after a download,
 * so it runs before a single archive byte is fetched.
 */
const checkWritable = (
  executable: string
): Effect.Effect<void, OytcError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const probe = path.join(path.dirname(executable), tempName(".oytc-write-probe-"))
    yield* fs
      .writeFileString(probe, "", { flag: "wx", mode: 0o600 })
      .pipe(Effect.catch((cause) => Effect.fail(installPermissionError(executable, cause))))
    yield* fs.remove(probe, { force: true }).pipe(Effect.ignore)
  })

/**
 * `replaceExecutable` — stage next to the target so the final rename is
 * same-filesystem and therefore atomic.
 *
 * On Windows a running executable cannot be overwritten but *can* be renamed,
 * so the current binary moves aside to `<exe>.old` first. That file is
 * deliberately **left behind** on success: it is still mapped by the running
 * process. The PowerShell installer removes it on the next install.
 */
const replaceExecutable = (
  contents: Uint8Array,
  executable: string,
  goos: string
): Effect.Effect<void, OytcError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const staged = path.join(path.dirname(executable), tempName(".oytc-new-"))

    yield* fs
      .writeFile(staged, contents, { flag: "wx", mode: 0o755 })
      .pipe(Effect.catch((cause) => Effect.fail(installPermissionError(executable, cause))))

    const install = Effect.gen(function* () {
      yield* fs
        .chmod(staged, 0o755)
        .pipe(
          Effect.catch((cause) => failWith(`stage new binary: ${describe(cause)}`, cause))
        )

      if (goos === "windows") {
        const old = `${executable}.old`
        yield* fs.remove(old, { force: true }).pipe(Effect.ignore)
        yield* fs
          .rename(executable, old)
          .pipe(
            Effect.catch((cause) =>
              failWith(
                `move the running executable aside (${describe(cause)}); on Windows, download the ` +
                  `new release manually from ${RELEASES_URL} and replace ${executable}`,
                cause
              )
            )
          )
        yield* fs.rename(staged, executable).pipe(
          Effect.catch((cause) =>
            // Roll back: the user must not be left with no executable at all.
            fs
              .rename(old, executable)
              .pipe(
                Effect.ignore,
                Effect.andThen(Effect.fail(installPermissionError(executable, cause)))
              )
          )
        )
        return
      }

      yield* fs
        .rename(staged, executable)
        .pipe(Effect.catch((cause) => Effect.fail(installPermissionError(executable, cause))))
    })

    // Go's `defer os.Remove(stagedName)` on every failure path; a no-op once
    // the rename succeeded.
    yield* install.pipe(
      Effect.onError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore))
    )
  })

/**
 * `guardManagedInstall` — refuse to fight a package manager for ownership of
 * its own binary. Path separators are normalized first so the markers match on
 * Windows too.
 */
export const guardManagedInstall = (executable: string): string | undefined => {
  const normalized = executable.replaceAll("\\", "/")
  for (const marker of ["/Cellar/", "/homebrew/", "/linuxbrew/"]) {
    if (normalized.includes(marker)) {
      return `${executable} looks like a Homebrew-managed install; update it with your package manager instead of the self-updater`
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * The 12-step run sequence from SPEC_AUTH_RELEASE §3.3, in order.
 */
export const runUpdate = (
  config: UpdaterConfig,
  options: UpdateOptions
): Effect.Effect<UpdateRunResult, OytcError, UpdaterServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    // 1. Resolve the executable. Symlink resolution failure is not fatal.
    const raw = config.executablePath ?? process.execPath
    const executable = yield* fs.realPath(raw).pipe(Effect.catch(() => Effect.succeed(raw)))

    const base: UpdateRunResult = {
      currentVersion: config.currentVersion,
      targetVersion: "",
      updated: false,
      upToDate: false,
      assetName: "",
      executablePath: executable
    }

    // 2. Guard managed installs.
    const managed = guardManagedInstall(executable)
    if (managed !== undefined) return yield* failWith(managed)

    // Fail before any network traffic when this platform is not published for.
    yield* Effect.try({
      try: () => assertBuildablePlatform(config.goos, config.goarch),
      catch: (cause) => operational(describe(cause), cause)
    })

    // 3. Resolve the release.
    const release = yield* resolveRelease(config, options.targetVersion)

    // 4. Compute the asset name.
    const asset = yield* Effect.try({
      try: () => assetName(release.tagName, config.goos, config.goarch),
      catch: (cause) => operational(describe(cause), cause)
    })
    const resolved: UpdateRunResult = {
      ...base,
      targetVersion: release.tagName,
      assetName: asset
    }

    // 5. Compare versions.
    const comparison = compareVersions(release.tagName, config.currentVersion)
    if (comparison.comparable && comparison.order === 0) {
      return { ...resolved, upToDate: true }
    }
    if (comparison.comparable && comparison.order < 0 && options.targetVersion === "") {
      return yield* failWith(
        `latest release ${release.tagName} is older than the current version ${config.currentVersion}; ` +
          "refusing to downgrade (pass an explicit version to override)"
      )
    }

    // 6. Check-only stops here, having touched nothing.
    if (options.checkOnly) return resolved

    // 7. Writability probe.
    yield* checkWritable(executable)

    // 8. Find the assets.
    const { assetUrl, checksumsUrl } = yield* findAssets(release, asset)

    // 9. Fetch the expected digest.
    const expected = yield* fetchChecksum(config, checksumsUrl, asset)

    // 10-11. Download, verify, extract — all inside a temp directory that is
    // removed however this ends.
    const scratch = yield* fs
      .makeTempDirectory({ prefix: "oytc-update-" })
      .pipe(Effect.catch((cause) => failWith(`save release archive: ${describe(cause)}`, cause)))

    const staged = yield* Effect.gen(function* () {
      const archivePath = path.join(scratch, asset)
      yield* downloadVerified(config, assetUrl, expected, archivePath)
      return yield* extractBinary(archivePath, config.goos, binaryName(config.goos))
    }).pipe(
      Effect.onExit(() => fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore))
    )

    // 12. Replace the executable.
    yield* replaceExecutable(staged, executable, config.goos)
    return { ...resolved, updated: true }
  })

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Project the Go-shaped result onto the frozen `UpdateResult` contract, which
 * names the remote tag `latestVersion` and has **no `upToDate` field**.
 *
 * The `update` command needs `upToDate` to choose between its three table
 * renderings (SPEC_AUTH_RELEASE §3.10). Two ways to get it without changing
 * the contract:
 *
 *   - preferred: call `runUpdate` directly, which returns `UpdateRunResult`
 *     with `upToDate` and `targetVersion` intact;
 *   - equivalent: recompute it as
 *     `compareVersions(latestVersion, currentVersion)` being
 *     `{ comparable: true, order: 0 }` — the exact predicate `runUpdate` uses.
 */
export const toUpdateResult = (result: UpdateRunResult): UpdateResult => ({
  currentVersion: result.currentVersion,
  latestVersion: result.targetVersion,
  updated: result.updated,
  asset: result.assetName,
  executable: result.executablePath
})

/** A `UpdaterShape` bound to an explicit config — the seam the tests drive. */
export const updaterWith = (config: UpdaterConfig) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<UpdaterServices>()
    return {
      run: (options: UpdateOptions) =>
        runUpdate(config, options).pipe(Effect.map(toUpdateResult), Effect.provide(services))
    } satisfies UpdaterShape
  })

export const makeUpdater = Effect.gen(function* () {
  const versionInfo = yield* VersionInfo
  const processEnv = yield* ProcessEnv
  const details = yield* versionInfo.get

  // An unmappable host is reported when the update actually runs, not at layer
  // construction time, so every other command still works on an exotic host.
  const platform = Effect.try({
    try: () => hostPlatform(processEnv.platform, processEnv.arch),
    catch: (cause) => operational(describe(cause), cause)
  })

  const services = yield* Effect.context<UpdaterServices>()

  return {
    run: (options: UpdateOptions) =>
      Effect.gen(function* () {
        const { goarch, goos } = yield* platform
        const result = yield* runUpdate(
          {
            repo: DEFAULT_REPO,
            apiBaseUrl: DEFAULT_API_BASE_URL,
            currentVersion: details.version,
            goos,
            goarch,
            executablePath: undefined
          },
          options
        )
        return toUpdateResult(result)
      }).pipe(Effect.provide(services))
  } satisfies UpdaterShape
})

export const UpdaterLive = Layer.effect(Updater, makeUpdater)

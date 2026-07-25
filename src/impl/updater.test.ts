import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FetchHttpClient } from "../effect.ts"
import { encodeGoStruct } from "../json/encode.ts"
import { assetName } from "./platformMatrix.ts"
import {
  CHECKSUMS_NAME,
  guardManagedInstall,
  parseChecksums,
  parseRelease,
  runUpdate,
  toUpdateResult,
  type UpdaterConfig,
  type UpdateRunResult
} from "./updater.ts"

// ---------------------------------------------------------------------------
// Fixture — the TS analogue of the Go tests' httptest.Server + t.TempDir()
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const bytes = (text: string): Uint8Array => encoder.encode(text)

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")

/**
 * A GitHub release payload. Built with the project's own encoder rather than
 * the stock one, which CI confines to `src/json/encode.ts`.
 */
const releaseJson = (
  tag: string,
  assets: ReadonlyArray<{ readonly name: string; readonly browser_download_url: string }>
): string =>
  encodeGoStruct(
    [
      ["tag_name", tag],
      ["prerelease", false],
      [
        "assets",
        assets.map((a) => ({ name: a.name, browser_download_url: a.browser_download_url }))
      ]
    ],
    { indent: "" }
  )

// Archive builders are duplicated from archive.test.ts rather than imported:
// importing a test module would re-register its suites in this file's run.

const octal = (v: number, width: number): string => v.toString(8).padStart(width - 1, "0") + "\0"

const tarGzWithEntry = (name: string, content: Uint8Array): Uint8Array => {
  const header = new Uint8Array(512)
  const put = (offset: number, t: string) => header.set(encoder.encode(t), offset)
  put(0, name.slice(0, 100))
  put(100, octal(0o755, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(content.length, 12))
  put(136, octal(0, 12))
  header[156] = "0".charCodeAt(0)
  put(257, "ustar\0")
  put(263, "00")
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `)

  const padding = (512 - (content.length % 512)) % 512
  const tar = new Uint8Array(512 + content.length + padding + 1024)
  tar.set(header, 0)
  tar.set(content, 512)
  return new Uint8Array(gzipSync(tar))
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const zipWithEntry = (name: string, content: Uint8Array): Uint8Array => {
  const nameBytes = encoder.encode(name)
  const crc = crc32(content)
  const size = content.length

  const local = new Uint8Array(30 + nameBytes.length + size)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint16(8, 0, true)
  lv.setUint32(14, crc, true)
  lv.setUint32(18, size, true)
  lv.setUint32(22, size, true)
  lv.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30)
  local.set(content, 30 + nameBytes.length)

  const central = new Uint8Array(46 + nameBytes.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint16(10, 0, true)
  cv.setUint32(16, crc, true)
  cv.setUint32(20, size, true)
  cv.setUint32(24, size, true)
  cv.setUint16(28, nameBytes.length, true)
  cv.setUint32(42, 0, true)
  central.set(nameBytes, 46)

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, local.length, true)

  const out = new Uint8Array(local.length + central.length + eocd.length)
  out.set(local, 0)
  out.set(central, local.length)
  out.set(eocd, local.length + central.length)
  return out
}

const testLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>
  )

const message = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure, got success")
  return String(exit.cause)
}

const value = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${String(exit.cause)}`)
  return exit.value
}

interface Fixture {
  readonly config: UpdaterConfig
  readonly executable: string
  readonly assetName: string
  /** Mutable so a test can corrupt the manifest, as the Go tests do. */
  checksums: string
  archive: Uint8Array
  readonly close: () => void
}

const servers: Array<{ stop: (force?: boolean) => void }> = []

afterAll(() => {
  for (const server of servers) server.stop(true)
})

const newFixture = async (options: {
  readonly tag: string
  readonly goos: string
  readonly goarch: string
  readonly currentVersion: string
  readonly binaryContent: string
  /** Omit the checksums.txt asset from the release payload. */
  readonly omitChecksumsAsset?: boolean
  /** Omit the platform archive asset from the release payload. */
  readonly omitPlatformAsset?: boolean
}): Promise<Fixture> => {
  const { currentVersion, goarch, goos, tag } = options
  const entry = goos === "windows" ? "oytc.exe" : "oytc"
  const content = bytes(options.binaryContent)
  const archive =
    goos === "windows" ? zipWithEntry(entry, content) : tarGzWithEntry(entry, content)
  const asset = assetName(tag, goos, goarch)

  const state: { checksums: string; archive: Uint8Array } = {
    checksums: `${sha256Hex(archive)}  ${asset}\n`,
    archive
  }

  const dir = `/tmp/oytc-updater-test-${Math.floor(Math.random() * 1e9)}`
  await Bun.$`mkdir -p ${dir}`.quiet()
  const executable = `${dir}/oytc`
  await Bun.write(executable, "old-binary")
  await Bun.$`chmod 755 ${executable}`.quiet()

  let base = ""

  const releaseBody = () => {
    const assets: Array<{ name: string; browser_download_url: string }> = []
    if (options.omitPlatformAsset !== true) {
      assets.push({ name: asset, browser_download_url: `${base}/assets/${asset}` })
    }
    if (options.omitChecksumsAsset !== true) {
      assets.push({
        name: CHECKSUMS_NAME,
        browser_download_url: `${base}/assets/${CHECKSUMS_NAME}`
      })
    }
    return releaseJson(tag, assets)
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/repos/owner/repo/releases/latest") {
        return new Response(releaseBody(), { headers: { "content-type": "application/json" } })
      }
      if (path.startsWith("/repos/owner/repo/releases/tags/")) {
        const requested = path.slice("/repos/owner/repo/releases/tags/".length)
        if (requested !== tag) return new Response("not found", { status: 404 })
        return new Response(releaseBody(), { headers: { "content-type": "application/json" } })
      }
      if (path.startsWith("/assets/")) {
        const name = path.slice("/assets/".length)
        if (name === asset) return new Response(state.archive as BlobPart)
        if (name === CHECKSUMS_NAME) return new Response(state.checksums)
      }
      return new Response("not found", { status: 404 })
    }
  })
  servers.push(server)
  base = `http://127.0.0.1:${server.port}`

  return {
    config: {
      repo: "owner/repo",
      apiBaseUrl: base,
      currentVersion,
      goos,
      goarch,
      executablePath: executable
    },
    executable,
    assetName: asset,
    get checksums() {
      return state.checksums
    },
    set checksums(next: string) {
      state.checksums = next
    },
    get archive() {
      return state.archive
    },
    set archive(next: Uint8Array) {
      state.archive = next
    },
    close: () => {
      server.stop(true)
      void Bun.$`rm -rf ${dir}`.quiet()
    }
  }
}

const readFile = async (path: string): Promise<string> => await Bun.file(path).text()

const noOptions = { checkOnly: false, targetVersion: "" }

// ---------------------------------------------------------------------------
// The 16 Go cases
// ---------------------------------------------------------------------------

describe("TestUpdateDownloadsVerifiesAndReplaces", () => {
  test("downloads, verifies, and replaces the executable", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "new-binary-content"
    })
    try {
      const result = value(await run(runUpdate(f.config, noOptions)))
      expect(result.updated).toBe(true)
      expect(result.targetVersion).toBe("v0.2.0")
      expect(await readFile(f.executable)).toBe("new-binary-content")

      const mode = (await Bun.file(f.executable).stat()).mode & 0o777
      expect(mode & 0o111).not.toBe(0)
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateRefusesChecksumMismatch", () => {
  test("refuses a mismatched digest and leaves the executable untouched", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      f.checksums = `${"0".repeat(64)}  ${f.assetName}\n`
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("checksum mismatch")
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateRefusesMissingChecksums", () => {
  test("refuses when the manifest has no entry for this asset", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      f.checksums = "deadbeef  something-else.tar.gz\n"
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("no entry")
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateAlreadyCurrent", () => {
  test("reports up to date and downloads nothing", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.2.0",
      binaryContent: "payload"
    })
    try {
      const result = value(await run(runUpdate(f.config, noOptions)))
      expect(result.upToDate).toBe(true)
      expect(result.updated).toBe(false)
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateRefusesImplicitDowngrade", () => {
  test("refuses when the latest release is older than the current version", async () => {
    const f = await newFixture({
      tag: "v0.1.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.2.0",
      binaryContent: "payload"
    })
    try {
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("refusing to downgrade")
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateExplicitVersionAllowsPinnedInstall", () => {
  test("an explicit --version installs an older release", async () => {
    const f = await newFixture({
      tag: "v0.1.5",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.2.0",
      binaryContent: "pinned"
    })
    try {
      const result = value(
        await run(runUpdate(f.config, { checkOnly: false, targetVersion: "v0.1.5" }))
      )
      expect(result.updated).toBe(true)
      expect(await readFile(f.executable)).toBe("pinned")
    } finally {
      f.close()
    }
  })

  test("a tag without a leading v is prefixed before the lookup", async () => {
    const f = await newFixture({
      tag: "v0.1.5",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.2.0",
      binaryContent: "pinned"
    })
    try {
      const result = value(
        await run(runUpdate(f.config, { checkOnly: false, targetVersion: "0.1.5" }))
      )
      expect(result.updated).toBe(true)
    } finally {
      f.close()
    }
  })

  test("an unknown tag surfaces the 404 guidance", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const exit = await run(runUpdate(f.config, { checkOnly: false, targetVersion: "v9.9.9" }))
      expect(message(exit)).toContain("has a release been published?")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateCheckOnlyDoesNotModify", () => {
  test("--check reports the target without touching anything", async () => {
    const f = await newFixture({
      tag: "v0.3.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const result = value(
        await run(runUpdate(f.config, { checkOnly: true, targetVersion: "" }))
      )
      expect(result.updated).toBe(false)
      expect(result.upToDate).toBe(false)
      expect(result.targetVersion).toBe("v0.3.0")
      expect(result.assetName).toBe("oytc_v0.3.0_linux_amd64.tar.gz")
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })

  test("--check still refuses a Homebrew-managed install", async () => {
    const f = await newFixture({
      tag: "v0.3.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const config = { ...f.config, executablePath: "/opt/homebrew/Cellar/oytc/0.1.0/bin/oytc" }
      const exit = await run(runUpdate(config, { checkOnly: true, targetVersion: "" }))
      expect(message(exit)).toContain("Homebrew")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateWindowsZipAndRenameAside", () => {
  /**
   * Still goos=windows + amd64: dropping windows/arm64 does not change the
   * rename-aside path, and this is the only coverage it gets on a POSIX CI.
   */
  test("extracts a zip and preserves the previous binary as <exe>.old", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "windows",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "windows-binary"
    })
    try {
      const result = value(await run(runUpdate(f.config, noOptions)))
      expect(result.updated).toBe(true)
      expect(result.assetName).toBe("oytc_v0.2.0_windows_amd64.zip")
      expect(await readFile(f.executable)).toBe("windows-binary")
      expect(await readFile(`${f.executable}.old`)).toBe("old-binary")
    } finally {
      f.close()
    }
  })

  test("a pre-existing .old from a previous update is replaced, not appended to", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "windows",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "windows-binary"
    })
    try {
      await Bun.write(`${f.executable}.old`, "ancient-binary")
      value(await run(runUpdate(f.config, noOptions)))
      expect(await readFile(`${f.executable}.old`)).toBe("old-binary")
    } finally {
      f.close()
    }
  })
})

describe("TestUpdateRefusesHomebrewInstall", () => {
  for (const path of [
    "/opt/homebrew/Cellar/oytc/0.1.0/bin/oytc",
    "/usr/local/Cellar/oytc/0.1.0/bin/oytc",
    "/home/linuxbrew/.linuxbrew/bin/oytc",
    "C:\\tools\\homebrew\\bin\\oytc.exe"
  ]) {
    test(`refuses ${path}`, async () => {
      const f = await newFixture({
        tag: "v0.2.0",
        goos: "linux",
        goarch: "amd64",
        currentVersion: "v0.1.0",
        binaryContent: "payload"
      })
      try {
        const exit = await run(runUpdate({ ...f.config, executablePath: path }, noOptions))
        expect(message(exit)).toContain("Homebrew")
        expect(message(exit)).toContain("package manager")
      } finally {
        f.close()
      }
    })
  }

  test("an ordinary path is not mistaken for a managed install", () => {
    expect(guardManagedInstall("/usr/local/bin/oytc")).toBeUndefined()
    expect(guardManagedInstall("/home/me/.local/bin/oytc")).toBeUndefined()
    // A literal "brew" in a user directory must not trip the guard: only the
    // three anchored markers count.
    expect(guardManagedInstall("/home/brewery/bin/oytc")).toBeUndefined()
  })
})

describe("TestUpdateMissingAssetForPlatform", () => {
  test("an unpublished arch fails with the missing-asset error", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const exit = await run(runUpdate({ ...f.config, goarch: "riscv64" }, noOptions))
      expect(message(exit)).toContain("no asset")
      expect(message(exit)).toContain("oytc_v0.2.0_linux_riscv64.tar.gz")
    } finally {
      f.close()
    }
  })

  test("windows/arm64 fails earlier, with the dropped-platform message", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const exit = await run(
        runUpdate({ ...f.config, goos: "windows", goarch: "arm64" }, noOptions)
      )
      expect(message(exit)).toContain("windows/arm64")
      expect(message(exit)).toContain("amd64 build instead")
    } finally {
      f.close()
    }
  })

  test("a release without checksums.txt refuses to install an unverifiable binary", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload",
      omitChecksumsAsset: true
    })
    try {
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("refusing to install an unverifiable binary")
    } finally {
      f.close()
    }
  })
})

describe("TestParseChecksums", () => {
  const digest = "ab".repeat(32)
  const manifest =
    `${digest}  oytc_v1.0.0_linux_amd64.tar.gz\n` +
    `${digest} *oytc_v1.0.0_darwin_arm64.tar.gz\n`

  test("finds both entries, stripping the binary-mode marker", () => {
    for (const name of ["oytc_v1.0.0_linux_amd64.tar.gz", "oytc_v1.0.0_darwin_arm64.tar.gz"]) {
      expect(parseChecksums(manifest, name)).toEqual({ digest })
    }
  })

  test("errors for a missing entry", () => {
    const result = parseChecksums(manifest, "missing.tar.gz")
    expect(result).toEqual({ error: 'checksums.txt has no entry for "missing.tar.gz"' })
  })

  test("errors for a malformed digest", () => {
    const result = parseChecksums("nothex  oytc.tar.gz\n", "oytc.tar.gz")
    expect(result).toEqual({
      error: 'checksums.txt contains a malformed digest for "oytc.tar.gz"'
    })
  })

  test("skips every line that does not have exactly two fields", () => {
    const noisy =
      "# a comment line with many fields\n" +
      "\n" +
      "   \n" +
      "only-one-field\n" +
      "three fields here\n" +
      `${digest}  target.tar.gz\n`
    expect(parseChecksums(noisy, "target.tar.gz")).toEqual({ digest })
  })

  test("splits on arbitrary whitespace, not just the sha256sum double space", () => {
    expect(parseChecksums(`${digest}\ttarget.tar.gz`, "target.tar.gz")).toEqual({ digest })
    expect(parseChecksums(`  ${digest}   target.tar.gz  `, "target.tar.gz")).toEqual({ digest })
  })

  test("an uppercase digest is lowercased", () => {
    expect(parseChecksums(`${"AB".repeat(32)}  t.tar.gz`, "t.tar.gz")).toEqual({ digest })
  })

  test("rejects a digest of the wrong length even when it is valid hex", () => {
    expect(parseChecksums(`${"ab".repeat(31)}  t.tar.gz`, "t.tar.gz")).toEqual({
      error: 'checksums.txt contains a malformed digest for "t.tar.gz"'
    })
    expect(parseChecksums(`${"ab".repeat(33)}  t.tar.gz`, "t.tar.gz")).toEqual({
      error: 'checksums.txt contains a malformed digest for "t.tar.gz"'
    })
  })

  test("rejects 64 characters that are not hex", () => {
    expect(parseChecksums(`${"z".repeat(64)}  t.tar.gz`, "t.tar.gz")).toEqual({
      error: 'checksums.txt contains a malformed digest for "t.tar.gz"'
    })
  })

  test("matches the first entry for a name and stops", () => {
    const other = "cd".repeat(32)
    expect(parseChecksums(`${digest}  t.tar.gz\n${other}  t.tar.gz\n`, "t.tar.gz")).toEqual({
      digest
    })
  })

  test("the name match is exact — a suffix does not count", () => {
    const result = parseChecksums(`${digest}  prefix-t.tar.gz\n`, "t.tar.gz")
    expect("error" in result).toBe(true)
  })

  test("an empty manifest reports no entry", () => {
    expect("error" in parseChecksums("", "t.tar.gz")).toBe(true)
  })

  /**
   * Line trimming uses Go's whitespace set, not JS `trim()`. Verified against
   * `strings.Fields(strings.TrimSpace(line))` with `go run`:
   *   - a leading U+FEFF stays attached to the digest, so the digest is
   *     malformed (JS `trim()` would strip it and accept the line);
   *   - a trailing U+FEFF stays attached to the filename, so it does not match;
   *   - a leading U+0085 IS stripped by Go (JS `trim()` leaves it, which would
   *     have made the digest malformed instead).
   */
  describe("trims with Go's whitespace set, not JS trim()", () => {
    const bom = "﻿"
    const nel = ""

    test("a leading U+FEFF makes the digest malformed, as Go reports", () => {
      expect(parseChecksums(`${bom}${digest}  t.tar.gz`, "t.tar.gz")).toEqual({
        error: 'checksums.txt contains a malformed digest for "t.tar.gz"'
      })
    })

    test("a trailing U+FEFF stays part of the filename, so the entry is not found", () => {
      expect(parseChecksums(`${digest}  t.tar.gz${bom}`, "t.tar.gz")).toEqual({
        error: 'checksums.txt has no entry for "t.tar.gz"'
      })
    })

    test("a leading U+0085 is stripped, so the entry still resolves", () => {
      expect(parseChecksums(`${nel}${digest}  t.tar.gz`, "t.tar.gz")).toEqual({ digest })
    })
  })
})

describe("TestDevBuildStillUpdatesToLatest", () => {
  test("an uninjected dev build is incomparable, so it installs the latest", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "dev",
      binaryContent: "release-binary"
    })
    try {
      const result = value(await run(runUpdate(f.config, noOptions)))
      expect(result.updated).toBe(true)
      expect(await readFile(f.executable)).toBe("release-binary")
    } finally {
      f.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Additional coverage the Go suite left implicit
// ---------------------------------------------------------------------------

describe("release metadata parsing", () => {
  test("reads tag, prerelease and assets", () => {
    expect(
      parseRelease(
        '{"tag_name":"v1.0.0","prerelease":true,"assets":[{"name":"a","browser_download_url":"u"}]}'
      )
    ).toEqual({
      tagName: "v1.0.0",
      prerelease: true,
      assets: [{ name: "a", browserDownloadUrl: "u" }]
    })
  })

  test("missing fields become zero values, as encoding/json does", () => {
    expect(parseRelease("{}")).toEqual({ tagName: "", prerelease: false, assets: [] })
  })

  test("unknown fields are ignored", () => {
    const release = parseRelease('{"tag_name":"v1","body":"notes","author":{"login":"x"}}')
    expect(release?.tagName).toBe("v1")
  })

  test("invalid JSON is rejected", () => {
    expect(parseRelease("not json")).toBeUndefined()
    expect(parseRelease("[1,2,3]")).toBeUndefined()
  })

  test("an empty tag_name is surfaced as a missing tag by the caller", async () => {
    const release = parseRelease('{"tag_name":""}')
    expect(release?.tagName).toBe("")
  })
})

describe("HTTP failure handling", () => {
  test("a non-200, non-404 status reports the code", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("boom", { status: 500 })
    })
    servers.push(server)
    const config: UpdaterConfig = {
      repo: "owner/repo",
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      currentVersion: "v0.1.0",
      goos: "linux",
      goarch: "amd64",
      executablePath: "/tmp/does-not-matter/oytc"
    }
    const exit = await run(runUpdate(config, noOptions))
    expect(message(exit)).toContain("unexpected status 500")
    expect(message(exit)).toContain("resolve release")
    server.stop(true)
  })

  test("a malformed body is reported as a parse failure", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<html>nope</html>")
    })
    servers.push(server)
    const config: UpdaterConfig = {
      repo: "owner/repo",
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      currentVersion: "v0.1.0",
      goos: "linux",
      goarch: "amd64",
      executablePath: "/tmp/does-not-matter/oytc"
    }
    const exit = await run(runUpdate(config, noOptions))
    expect(message(exit)).toContain("parse release metadata")
    server.stop(true)
  })

  test("an empty tag_name fails with the missing-tag message", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response('{"tag_name":"","assets":[]}')
    })
    servers.push(server)
    const config: UpdaterConfig = {
      repo: "owner/repo",
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      currentVersion: "v0.1.0",
      goos: "linux",
      goarch: "amd64",
      executablePath: "/tmp/does-not-matter/oytc"
    }
    const exit = await run(runUpdate(config, noOptions))
    expect(message(exit)).toContain("release metadata is missing a tag name")
    server.stop(true)
  })

  test("the API base URL has trailing slashes stripped", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const config = { ...f.config, apiBaseUrl: `${f.config.apiBaseUrl}///` }
      const result = value(await run(runUpdate(config, { checkOnly: true, targetVersion: "" })))
      expect(result.targetVersion).toBe("v0.2.0")
    } finally {
      f.close()
    }
  })

  test("every request carries the oytc-updater User-Agent and never a credential", async () => {
    const seen: Array<Headers> = []
    const archive = tarGzWithEntry("oytc", bytes("payload"))
    const asset = assetName("v0.2.0", "linux", "amd64")
    let base = ""
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(request.headers)
        const path = new URL(request.url).pathname
        if (path.endsWith("/releases/latest")) {
          return new Response(
            releaseJson("v0.2.0", [
              { name: asset, browser_download_url: `${base}/assets/${asset}` },
              { name: CHECKSUMS_NAME, browser_download_url: `${base}/assets/${CHECKSUMS_NAME}` }
            ])
          )
        }
        if (path.endsWith(asset)) return new Response(archive as BlobPart)
        if (path.endsWith(CHECKSUMS_NAME)) {
          return new Response(`${sha256Hex(archive)}  ${asset}\n`)
        }
        return new Response("not found", { status: 404 })
      }
    })
    servers.push(server)
    base = `http://127.0.0.1:${server.port}`

    const dir = `/tmp/oytc-ua-test-${Math.floor(Math.random() * 1e9)}`
    await Bun.$`mkdir -p ${dir}`.quiet()
    await Bun.write(`${dir}/oytc`, "old-binary")

    value(
      await run(
        runUpdate(
          {
            repo: "owner/repo",
            apiBaseUrl: base,
            currentVersion: "v0.1.0",
            goos: "linux",
            goarch: "amd64",
            executablePath: `${dir}/oytc`
          },
          noOptions
        )
      )
    )

    expect(seen.length).toBe(3)
    for (const headers of seen) {
      expect(headers.get("user-agent")).toBe("oytc-updater/v0.1.0")
      // The security posture: no API key ever leaves this process.
      expect(headers.get("authorization")).toBeNull()
      expect(headers.get("x-goog-api-key")).toBeNull()
    }
    // Only the metadata request negotiates the GitHub media type.
    expect(seen[0]?.get("accept")).toBe("application/vnd.github+json")

    server.stop(true)
    await Bun.$`rm -rf ${dir}`.quiet()
  })
})

describe("writability probe", () => {
  test("a non-writable directory fails before anything is downloaded", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const exit = await run(
        runUpdate({ ...f.config, executablePath: "/proc/definitely/not/here/oytc" }, noOptions)
      )
      expect(Exit.isSuccess(exit)).toBe(false)
    } finally {
      f.close()
    }
  })

  test("the probe leaves nothing behind on success", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      value(await run(runUpdate(f.config, noOptions)))
      const dir = f.executable.slice(0, f.executable.lastIndexOf("/"))
      const listing = (await Bun.$`ls -A ${dir}`.quiet()).stdout.toString().trim().split("\n")
      expect(listing.filter((n) => n.startsWith(".oytc-"))).toEqual([])
      expect(listing).toEqual(["oytc"])
    } finally {
      f.close()
    }
  })
})

describe("archive integrity", () => {
  test("a tampered archive fails the digest and leaves the executable alone", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      // The manifest still lists the ORIGINAL digest; the served bytes change.
      f.archive = tarGzWithEntry("oytc", bytes("attacker-controlled"))
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("checksum mismatch")
      expect(message(exit)).toContain("refusing to install")
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })

  test("a valid digest over an archive missing the binary reports the archive, not the digest", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const decoy = tarGzWithEntry("README", bytes("nothing here"))
      f.archive = decoy
      f.checksums = `${sha256Hex(decoy)}  ${f.assetName}\n`
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain('release archive does not contain "oytc"')
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })

  test("a path-traversal entry is refused even with a valid digest", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const evil = tarGzWithEntry("../oytc", bytes("evil"))
      f.archive = evil
      f.checksums = `${sha256Hex(evil)}  ${f.assetName}\n`
      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("does not contain")
      expect(await readFile(f.executable)).toBe("old-binary")
    } finally {
      f.close()
    }
  })

  test("no temporary archive survives a successful run", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      value(await run(runUpdate(f.config, noOptions)))
      const stale = (await Bun.$`ls -A /tmp`.quiet()).stdout
        .toString()
        .split("\n")
        .filter((name) => name.startsWith("oytc-update-"))
      expect(stale).toEqual([])
    } finally {
      f.close()
    }
  })
})

describe("toUpdateResult", () => {
  test("renames targetVersion to latestVersion for the service contract", () => {
    const result: UpdateRunResult = {
      currentVersion: "v0.1.0",
      targetVersion: "v0.2.0",
      updated: true,
      upToDate: false,
      assetName: "oytc_v0.2.0_linux_amd64.tar.gz",
      executablePath: "/usr/local/bin/oytc"
    }
    expect(toUpdateResult(result)).toEqual({
      currentVersion: "v0.1.0",
      latestVersion: "v0.2.0",
      updated: true,
      asset: "oytc_v0.2.0_linux_amd64.tar.gz",
      executable: "/usr/local/bin/oytc"
    })
  })
})

describe("executable resolution", () => {
  test("a symlinked executable resolves to its target before the guard runs", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "resolved"
    })
    try {
      const link = `${f.executable}-link`
      await Bun.$`ln -s ${f.executable} ${link}`.quiet()
      const result = value(await run(runUpdate({ ...f.config, executablePath: link }, noOptions)))
      // The REAL file is replaced, not the link — otherwise the update would
      // silently clobber the symlink and orphan the binary. Compared against a
      // realpath of the fixture because /tmp is itself a symlink on macOS.
      const real = (await Bun.$`readlink -f ${f.executable}`.quiet()).stdout.toString().trim()
      expect(result.executablePath).toBe(real)
      expect(result.executablePath).not.toBe(link)
      expect(await readFile(f.executable)).toBe("resolved")
    } finally {
      f.close()
    }
  })

  test("a symlink pointing into a Cellar path is caught after resolution", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const dir = f.executable.slice(0, f.executable.lastIndexOf("/"))
      await Bun.$`mkdir -p ${dir}/Cellar/oytc/bin`.quiet()
      const real = `${dir}/Cellar/oytc/bin/oytc`
      await Bun.write(real, "brewed")
      const link = `${dir}/brew-link`
      await Bun.$`ln -s ${real} ${link}`.quiet()

      const exit = await run(runUpdate({ ...f.config, executablePath: link }, noOptions))
      // The guard would miss this if it ran on the unresolved link path.
      expect(message(exit)).toContain("Homebrew")
    } finally {
      f.close()
    }
  })

  test("an unresolvable path is used as-is rather than failing", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const missing = `${f.executable}-not-created-yet`
      const result = value(
        await run(runUpdate({ ...f.config, executablePath: missing }, { checkOnly: true, targetVersion: "" }))
      )
      expect(result.executablePath).toBe(missing)
    } finally {
      f.close()
    }
  })
})

describe("windows rename-aside", () => {
  test("a failed aside-rename tells the user how to finish by hand", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "windows",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "windows-binary"
    })
    try {
      // A non-empty directory at `<exe>.old` survives the pre-emptive remove
      // (which is non-recursive) and makes `rename(exe, exe.old)` fail.
      await Bun.$`mkdir -p ${f.executable}.old/occupied`.quiet()
      await Bun.write(`${f.executable}.old/occupied/x`, "blocker")

      const exit = await run(runUpdate(f.config, noOptions))
      expect(message(exit)).toContain("move the running executable aside")
      expect(message(exit)).toContain("github.com/davis7dotsh/open-yt-cli/releases")
      // The running executable is untouched, which is the whole point.
      expect(await readFile(f.executable)).toBe("old-binary")
      const dir = f.executable.slice(0, f.executable.lastIndexOf("/"))
      const listing = (await Bun.$`ls -A ${dir}`.quiet()).stdout.toString().trim().split("\n")
      expect(listing.filter((n) => n.startsWith(".oytc-new-"))).toEqual([])
    } finally {
      f.close()
    }
  })

  /**
   * The rollback branch cannot be reached with real filesystem calls (once the
   * aside-rename succeeds, the destination is free and the second rename
   * cannot fail on a sane filesystem), so the FileSystem is wrapped to fail
   * exactly that one call. Without the rollback the user would be left with no
   * executable at all — only a `.old` file.
   */
  test("rolls the aside-rename back when the staged rename fails", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "windows",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "windows-binary"
    })
    try {
      // The updater resolves symlinks, and /tmp is one on macOS, so the path
      // it renames to is the realpath, not the fixture path.
      const target = (await Bun.$`readlink -f ${f.executable}`.quiet()).stdout.toString().trim()
      const brokenRename = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          return {
            ...fs,
            rename: (from: string, to: string) =>
              to === target && from !== `${target}.old`
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to
                    })
                  )
                : fs.rename(from, to)
          }
        })
      ).pipe(Layer.provide(BunServices.layer))

      const exit = await Effect.runPromiseExit(
        runUpdate(f.config, noOptions).pipe(
          Effect.provide(brokenRename),
          Effect.provide(testLayer)
        ) as Effect.Effect<UpdateRunResult, unknown, never>
      )

      expect(message(exit)).toContain("no permission to replace")
      // Rolled back: the original binary is back at its own path...
      expect(await readFile(f.executable)).toBe("old-binary")
      // ...and the aside copy is gone rather than holding the only copy.
      expect(await Bun.file(`${f.executable}.old`).exists()).toBe(false)
    } finally {
      f.close()
    }
  })

  test("posix does NOT leave a .old file behind", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      value(await run(runUpdate(f.config, noOptions)))
      expect(await Bun.file(`${f.executable}.old`).exists()).toBe(false)
    } finally {
      f.close()
    }
  })
})

describe("streaming download", () => {
  test("a large archive is hashed and written correctly across many chunks", async () => {
    // Big enough to arrive in multiple stream chunks, which is the only way to
    // catch a hasher that is fed the whole body instead of each slice.
    const payload = new Uint8Array(3 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256

    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "placeholder"
    })
    try {
      const archive = tarGzWithEntry("oytc", payload)
      f.archive = archive
      f.checksums = `${sha256Hex(archive)}  ${f.assetName}\n`

      value(await run(runUpdate(f.config, noOptions)))
      const installed = new Uint8Array(await Bun.file(f.executable).arrayBuffer())
      expect(installed.length).toBe(payload.length)
      expect(sha256Hex(installed)).toBe(sha256Hex(payload))
    } finally {
      f.close()
    }
  })
})

describe("installPermissionError guidance", () => {
  test("a genuinely unwritable directory gets the privileges/install-script advice", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      const locked = `/tmp/oytc-locked-${Math.floor(Math.random() * 1e9)}`
      await Bun.$`mkdir -p ${locked}`.quiet()
      await Bun.write(`${locked}/oytc`, "old-binary")
      await Bun.$`chmod 500 ${locked}`.quiet()
      try {
        const exit = await run(
          runUpdate({ ...f.config, executablePath: `${locked}/oytc` }, noOptions)
        )
        expect(message(exit)).toContain("no permission to replace")
        expect(message(exit)).toContain("Re-run the update with sufficient privileges")
        expect(message(exit)).toContain("https://davis7dotsh.github.io/open-yt-cli/install.sh")
      } finally {
        await Bun.$`chmod 700 ${locked}`.quiet()
        await Bun.$`rm -rf ${locked}`.quiet()
      }
    } finally {
      f.close()
    }
  })

  test("a non-permission failure is NOT dressed up with the privileges advice", async () => {
    const f = await newFixture({
      tag: "v0.2.0",
      goos: "linux",
      goarch: "amd64",
      currentVersion: "v0.1.0",
      binaryContent: "payload"
    })
    try {
      // A missing parent directory is ENOENT, not EACCES. Go returns the raw
      // error here; telling the user to re-run as root would be wrong.
      const exit = await run(
        runUpdate({ ...f.config, executablePath: "/tmp/no-such-dir-xyz/oytc" }, noOptions)
      )
      expect(Exit.isSuccess(exit)).toBe(false)
      expect(message(exit)).not.toContain("sufficient privileges")
    } finally {
      f.close()
    }
  })
})

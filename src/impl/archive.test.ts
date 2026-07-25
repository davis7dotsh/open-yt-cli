import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { Effect, Exit } from "effect"
import { BunServices } from "@effect/platform-bun"
// The stock JSON encoder is confined to src/json/encode.ts (CI greps for it),
// so test names quote their inputs with the project's own Go-faithful encoder.
import { encodeGoString } from "../json/encode.ts"
import {
  extractBinary,
  extractFromTarGzBytes,
  extractFromZipBytes,
  goPathClean,
  safeEntryMatch
} from "./archive.ts"

// ---------------------------------------------------------------------------
// Fixtures — the TS equivalents of the Go tests' tarGzWithEntry / zipWithEntry
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

const octal = (value: number, width: number): string =>
  value.toString(8).padStart(width - 1, "0") + "\0"

/** One-entry tar, ustar format, matching what `archive/tar` emits. */
const tarWithEntry = (
  name: string,
  content: Uint8Array,
  typeflag = "0"
): Uint8Array => {
  const header = new Uint8Array(512)
  const put = (offset: number, text: string) => header.set(encoder.encode(text), offset)

  put(0, name.slice(0, 100))
  put(100, octal(0o755, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(content.length, 12))
  put(136, octal(0, 12))
  header[156] = typeflag.charCodeAt(0)
  put(257, "ustar\0")
  put(263, "00")

  // Checksum: the field is treated as spaces while summing.
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `)

  const padding = (512 - (content.length % 512)) % 512
  const out = new Uint8Array(512 + content.length + padding + 1024)
  out.set(header, 0)
  out.set(content, 512)
  return out
}

const tarGzWithEntry = (
  name: string,
  content: Uint8Array,
  typeflag = "0"
): Uint8Array => new Uint8Array(gzipSync(tarWithEntry(name, content, typeflag)))

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One-entry STORED zip with a proper central directory and EOCD. */
const zipWithEntry = (name: string, content: Uint8Array): Uint8Array => {
  const nameBytes = encoder.encode(name)
  const crc = crc32(content)
  const size = content.length

  const local = new Uint8Array(30 + nameBytes.length + size)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint16(8, 0, true) // stored
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

const bytes = (text: string): Uint8Array => encoder.encode(text)
const text = (data: Uint8Array): string => new TextDecoder().decode(data)

const runExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect)

const runFs = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(BunServices.layer)) as Effect.Effect<A, E, never>)

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return String(exit.cause)
}

// ---------------------------------------------------------------------------

describe("goPathClean", () => {
  /** Verified row by row against a Go program calling path.Clean. */
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", "."],
    [".", "."],
    ["/", "/"],
    ["oytc", "oytc"],
    ["./oytc", "oytc"],
    ["oytc/", "oytc"],
    ["/oytc", "/oytc"],
    ["//oytc", "/oytc"],
    ["../oytc", "../oytc"],
    ["nested/oytc", "nested/oytc"],
    ["a/../oytc", "oytc"],
    ["./././oytc", "oytc"],
    ["oytc/.", "oytc"],
    ["/../oytc", "/oytc"],
    ["a//b/../../oytc", "oytc"],
    ["oytc//", "oytc"],
    ["/oytc/", "/oytc"],
    ["...", "..."],
    ["..", ".."],
    ["a/..", "."],
    ["oytc.exe", "oytc.exe"]
  ]

  for (const [input, want] of cases) {
    test(`Clean(${encodeGoString(input)}) = ${encodeGoString(want)}`, () => {
      expect(goPathClean(input)).toBe(want)
    })
  }

  test("differs from node's posix normalize on a trailing slash, which is why it exists", () => {
    // node: "oytc/" -> "oytc/"; Go: "oytc/" -> "oytc". Using node's would let
    // an entry named "oytc/" slip past the exact-match check.
    expect(goPathClean("oytc/")).toBe("oytc")
  })
})

describe("safeEntryMatch — the path-traversal defense", () => {
  test("accepts the exact expected name", () => {
    expect(safeEntryMatch("oytc", "oytc")).toBe(true)
    expect(safeEntryMatch("./oytc", "oytc")).toBe(true)
    expect(safeEntryMatch("oytc.exe", "oytc.exe")).toBe(true)
  })

  test("rejects traversal, absolute and nested paths", () => {
    for (const entry of ["../oytc", "/oytc", "nested/oytc", "..\\oytc", "a/b/oytc", "/../oytc"]) {
      expect(safeEntryMatch(entry, "oytc")).toBe(false)
    }
  })

  test("normalizes backslashes before cleaning, so ..\\oytc cannot sneak through", () => {
    // Without the replaceAll, path.Clean would leave "..\oytc" intact and it
    // would compare unequal but reach the filesystem as a literal filename.
    expect(safeEntryMatch("..\\oytc", "oytc")).toBe(false)
    expect(safeEntryMatch(".\\oytc", "oytc")).toBe(true)
  })

  test("rejects a name that merely contains the expected one", () => {
    expect(safeEntryMatch("oytc2", "oytc")).toBe(false)
    expect(safeEntryMatch("myoytc", "oytc")).toBe(false)
    expect(safeEntryMatch("oytc.exe", "oytc")).toBe(false)
  })
})

/** Port of Go's `TestExtractRejectsPathTraversal`, same four entries. */
describe("TestExtractRejectsPathTraversal", () => {
  for (const entry of ["../oytc", "/oytc", "nested/oytc", "..\\oytc"]) {
    test(`tar entry ${encodeGoString(entry)} is refused`, async () => {
      const archive = tarGzWithEntry(entry, bytes("evil"))
      const exit = await runExit(extractFromTarGzBytes(archive, "oytc"))
      expect(failureMessage(exit)).toContain("does not contain")
    })

    test(`zip entry ${encodeGoString(entry)} is refused`, async () => {
      const archive = zipWithEntry(entry, bytes("evil"))
      const exit = await runExit(extractFromZipBytes(archive, "oytc"))
      expect(failureMessage(exit)).toContain("does not contain")
    })
  }
})

describe("extractFromTarGzBytes", () => {
  test("extracts the binary at the archive root", async () => {
    const exit = await runExit(extractFromTarGzBytes(tarGzWithEntry("oytc", bytes("payload")), "oytc"))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(text(exit.value)).toBe("payload")
  })

  test("preserves binary content byte for byte", async () => {
    const content = new Uint8Array(4096)
    for (let i = 0; i < content.length; i++) content[i] = i % 256
    const exit = await runExit(extractFromTarGzBytes(tarGzWithEntry("oytc", content), "oytc"))
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value).toEqual(content)
  })

  test("an empty entry extracts as empty rather than failing", async () => {
    const exit = await runExit(
      extractFromTarGzBytes(tarGzWithEntry("oytc", new Uint8Array(0)), "oytc")
    )
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(exit.value.length).toBe(0)
  })

  test("skips non-regular entries — a symlink named oytc is not the binary", async () => {
    // typeflag "2" is a symlink. Go's `header.Typeflag != tar.TypeReg` skip is
    // what stops an archive from redirecting the write through a link.
    const exit = await runExit(
      extractFromTarGzBytes(tarGzWithEntry("oytc", bytes("evil"), "2"), "oytc")
    )
    expect(failureMessage(exit)).toContain('does not contain "oytc"')
  })

  test("skips directory entries", async () => {
    const exit = await runExit(
      extractFromTarGzBytes(tarGzWithEntry("oytc", new Uint8Array(0), "5"), "oytc")
    )
    expect(failureMessage(exit)).toContain("does not contain")
  })

  test("accepts TypeRegA (NUL typeflag), which Go's reader normalizes to a regular file", async () => {
    const exit = await runExit(
      extractFromTarGzBytes(tarGzWithEntry("oytc", bytes("old-format"), "\0"), "oytc")
    )
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(text(exit.value)).toBe("old-format")
  })

  test("reports a missing entry, not a crash, for an archive of something else", async () => {
    const exit = await runExit(extractFromTarGzBytes(tarGzWithEntry("README", bytes("x")), "oytc"))
    expect(failureMessage(exit)).toContain('release archive does not contain "oytc"')
  })

  test("non-gzip input fails as an unreadable archive", async () => {
    const exit = await runExit(extractFromTarGzBytes(bytes("this is not gzip"), "oytc"))
    expect(failureMessage(exit)).toContain("open release archive")
  })

  test("truncated gzip fails rather than returning partial bytes", async () => {
    const full = tarGzWithEntry("oytc", bytes("payload"))
    const exit = await runExit(extractFromTarGzBytes(full.subarray(0, full.length - 10), "oytc"))
    expect(Exit.isSuccess(exit)).toBe(false)
  })

  test("looks for oytc.exe when that is what was asked for", async () => {
    const archive = tarGzWithEntry("oytc.exe", bytes("win"))
    const found = await runExit(extractFromTarGzBytes(archive, "oytc.exe"))
    if (!Exit.isSuccess(found)) throw new Error("expected success")
    expect(text(found.value)).toBe("win")

    const missing = await runExit(extractFromTarGzBytes(archive, "oytc"))
    expect(failureMessage(missing)).toContain("does not contain")
  })
})

describe("extractFromZipBytes", () => {
  test("extracts a stored entry", async () => {
    const exit = await runExit(extractFromZipBytes(zipWithEntry("oytc.exe", bytes("winbin")), "oytc.exe"))
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    expect(text(exit.value)).toBe("winbin")
  })

  test("skips directory entries (trailing slash)", async () => {
    const exit = await runExit(extractFromZipBytes(zipWithEntry("oytc/", new Uint8Array(0)), "oytc"))
    expect(failureMessage(exit)).toContain("does not contain")
  })

  test("reports a missing entry", async () => {
    const exit = await runExit(extractFromZipBytes(zipWithEntry("other.exe", bytes("x")), "oytc.exe"))
    expect(failureMessage(exit)).toContain('release archive does not contain "oytc.exe"')
  })

  test("garbage input fails as an invalid zip", async () => {
    const exit = await runExit(extractFromZipBytes(bytes("not a zip at all"), "oytc.exe"))
    expect(failureMessage(exit)).toContain("open release archive")
  })
})

/**
 * The Go implementation chooses zip when the path ends in `.zip` OR when
 * goos is windows. Both halves of that disjunction are exercised.
 */
describe("extractBinary — format selection", () => {
  const withTempFile = async <A>(
    name: string,
    content: Uint8Array,
    use: (path: string) => Promise<A>
  ): Promise<A> => {
    const dir = `/tmp/oytc-archive-test-${Math.floor(Math.random() * 1e9)}`
    await Bun.$`mkdir -p ${dir}`.quiet()
    const file = `${dir}/${name}`
    await Bun.write(file, content)
    try {
      return await use(file)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  }

  test("tar.gz on linux", async () => {
    await withTempFile("a.tar.gz", tarGzWithEntry("oytc", bytes("linux-bin")), async (file) => {
      const exit = await runFs(extractBinary(file, "linux", "oytc"))
      if (!Exit.isSuccess(exit)) throw new Error(failureMessage(exit))
      expect(text(exit.value as Uint8Array)).toBe("linux-bin")
    })
  })

  test("zip on windows even when the path does not end in .zip", async () => {
    await withTempFile("archive.bin", zipWithEntry("oytc.exe", bytes("win-bin")), async (file) => {
      const exit = await runFs(extractBinary(file, "windows", "oytc.exe"))
      if (!Exit.isSuccess(exit)) throw new Error(failureMessage(exit))
      expect(text(exit.value as Uint8Array)).toBe("win-bin")
    })
  })

  test("zip when the path ends in .zip even on linux", async () => {
    await withTempFile("a.zip", zipWithEntry("oytc", bytes("zipped")), async (file) => {
      const exit = await runFs(extractBinary(file, "linux", "oytc"))
      if (!Exit.isSuccess(exit)) throw new Error(failureMessage(exit))
      expect(text(exit.value as Uint8Array)).toBe("zipped")
    })
  })

  test("a missing archive file fails as unreadable", async () => {
    const exit = await runFs(extractBinary("/tmp/definitely-not-here.tar.gz", "linux", "oytc"))
    expect(failureMessage(exit)).toContain("open release archive")
  })
})

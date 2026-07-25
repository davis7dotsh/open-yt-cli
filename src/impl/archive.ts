/**
 * Release-archive extraction — `tar.gz` and `zip`, with the path-traversal
 * defense from `internal/update/update.go`.
 *
 * The defense is deliberately not a prefix check or a `..` scan. An entry
 * qualifies only when
 *
 *     path.Clean(name.replaceAll("\\", "/")) === <expected binary name>
 *
 * i.e. an EXACT match against `oytc` / `oytc.exe`. That single rule rejects
 * `../oytc`, `/oytc`, `nested/oytc` and `..\oytc` at once, and it also means a
 * malicious archive cannot smuggle a second file past us: nothing but the one
 * expected name is ever read, and nothing is ever written to an attacker-named
 * path — the payload goes to a temp file we name ourselves.
 *
 * Neither format is streamed. Both are bounded by the 256 MiB download cap
 * upstream, so the whole archive is already on disk and fits in memory; a
 * streaming tar reader would buy nothing and cost the ability to read a zip's
 * central directory (which lives at the END of the file).
 */

import { gunzipSync, inflateRawSync } from "node:zlib"
import { Effect, FileSystem } from "effect"
import { OperationalError } from "../domain/errors.ts"

/** `256 << 20`. Mirrors Go's `maxArchiveBytes`. */
export const MAX_ARCHIVE_BYTES = 256 << 20

/**
 * Go's `path.Clean`. Node's `path.posix.normalize` is close but not equal —
 * it preserves a trailing slash (`"oytc/"` stays `"oytc/"` where Go yields
 * `"oytc"`), so it cannot be substituted here.
 */
export const goPathClean = (value: string): string => {
  if (value === "") return "."
  const rooted = value.startsWith("/")
  const segments = value.split("/")
  const out: Array<string> = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop()
        continue
      }
      // A rooted path cannot escape its root: `/../x` cleans to `/x`.
      if (rooted) continue
      out.push("..")
      continue
    }
    out.push(segment)
  }
  const joined = out.join("/")
  if (rooted) return `/${joined}`
  return joined === "" ? "." : joined
}

/**
 * The traversal defense. `want` is a bare filename (`oytc` / `oytc.exe`);
 * anything that does not clean to exactly that is not our binary.
 */
export const safeEntryMatch = (name: string, want: string): boolean =>
  goPathClean(name.replaceAll("\\", "/")) === want

const fail = (message: string, cause?: unknown) =>
  Effect.fail(new OperationalError({ message, ...(cause === undefined ? {} : { cause }) }))

const notContained = (want: string) => `release archive does not contain "${want}"`

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512

const decodeAscii = (bytes: Uint8Array): string => {
  let out = ""
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

/** A NUL-terminated (or space-padded) tar header string field. */
const headerString = (block: Uint8Array, offset: number, length: number): string => {
  const slice = block.subarray(offset, offset + length)
  let end = slice.length
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      end = i
      break
    }
  }
  return new TextDecoder().decode(slice.subarray(0, end))
}

/**
 * A tar numeric field: octal ASCII, or GNU base-256 when the high bit of the
 * first byte is set. Returns `undefined` for a field that is neither.
 */
const headerNumber = (block: Uint8Array, offset: number, length: number): number | undefined => {
  const slice = block.subarray(offset, offset + length)
  const first = slice[0] ?? 0
  if ((first & 0x80) !== 0) {
    let value = 0n
    for (let i = 0; i < slice.length; i++) {
      const byte = slice[i]!
      value = (value << 8n) | BigInt(i === 0 ? byte & 0x7f : byte)
    }
    const asNumber = Number(value)
    return Number.isSafeInteger(asNumber) ? asNumber : undefined
  }
  const text = decodeAscii(slice).replace(/[\0 ]+$/, "").trim()
  if (text === "") return 0
  if (!/^[0-7]+$/.test(text)) return undefined
  return Number.parseInt(text, 8)
}

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0)

interface TarEntry {
  readonly name: string
  readonly typeflag: string
  readonly data: Uint8Array
}

/**
 * Walk a tar archive, yielding regular-file entries. Handles the ustar `prefix`
 * field, GNU `L` long names, and PAX `x` `path=` records — the same set Go's
 * `archive/tar` transparently resolves, so an archive Go accepted still works.
 *
 * `\0` (TypeRegA) is normalized to `0` exactly as Go's reader does; verified
 * against Go by hand-building a TypeRegA header.
 */
function* tarEntries(bytes: Uint8Array): Generator<TarEntry> {
  let offset = 0
  let pendingLongName: string | undefined
  let pendingPaxPath: string | undefined

  while (offset + TAR_BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK)
    if (isZeroBlock(header)) return
    offset += TAR_BLOCK

    const size = headerNumber(header, 124, 12)
    if (size === undefined || size < 0) return

    const dataEnd = offset + size
    if (dataEnd > bytes.length) return
    const data = bytes.subarray(offset, dataEnd)
    offset = dataEnd + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK)

    const rawTypeflag = String.fromCharCode(header[156] ?? 0)
    let name = headerString(header, 0, 100)
    const magic = decodeAscii(header.subarray(257, 263))
    if (magic.startsWith("ustar")) {
      const prefix = headerString(header, 345, 155)
      if (prefix !== "") name = `${prefix}/${name}`
    }

    if (rawTypeflag === "L") {
      pendingLongName = new TextDecoder().decode(data).replace(/\0+$/, "")
      continue
    }
    if (rawTypeflag === "K") continue
    if (rawTypeflag === "x" || rawTypeflag === "X") {
      pendingPaxPath = paxPath(data)
      continue
    }
    if (rawTypeflag === "g") continue

    const effectiveName = pendingPaxPath ?? pendingLongName ?? name
    pendingLongName = undefined
    pendingPaxPath = undefined

    // Go normalizes TypeRegA ("\0"): a trailing slash means a directory,
    // otherwise a regular file.
    const typeflag =
      rawTypeflag === "\0" || rawTypeflag === "" ? (effectiveName.endsWith("/") ? "5" : "0") : rawTypeflag

    yield { name: effectiveName, typeflag, data }
  }
}

/** `path=<value>` out of a PAX extended-header record set. */
const paxPath = (data: Uint8Array): string | undefined => {
  const text = new TextDecoder().decode(data)
  let index = 0
  while (index < text.length) {
    const space = text.indexOf(" ", index)
    if (space < 0) return undefined
    const length = Number.parseInt(text.slice(index, space), 10)
    if (!Number.isFinite(length) || length <= 0) return undefined
    const record = text.slice(index, index + length)
    const equals = record.indexOf("=")
    if (equals > 0) {
      const key = record.slice(record.indexOf(" ") + 1, equals)
      if (key === "path") return record.slice(equals + 1).replace(/\n$/, "")
    }
    index += length
  }
  return undefined
}

/**
 * Extract `want` from gzipped tar bytes. Only `TypeReg` entries whose cleaned
 * name matches exactly are considered.
 */
export const extractFromTarGzBytes = (
  bytes: Uint8Array,
  want: string
): Effect.Effect<Uint8Array, OperationalError> =>
  Effect.gen(function* () {
    const tar = yield* Effect.try({
      try: () => new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_BYTES })),
      catch: (cause) => new OperationalError({ message: "open release archive", cause })
    })
    for (const entry of tarEntries(tar)) {
      if (entry.typeflag !== "0") continue
      if (!safeEntryMatch(entry.name, want)) continue
      return entry.data.slice(0, MAX_ARCHIVE_BYTES)
    }
    return yield* fail(notContained(want))
  })

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly localHeaderOffset: number
}

const findEocd = (view: DataView): number | undefined => {
  const minimum = 22
  if (view.byteLength < minimum) return undefined
  // The comment may be up to 65535 bytes; scan back from the end.
  const limit = Math.max(0, view.byteLength - minimum - 0xffff)
  for (let offset = view.byteLength - minimum; offset >= limit; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return undefined
}

/**
 * Read the central directory. Sizes come from there rather than from the local
 * header, because an archive written with a streaming writer sets general
 * purpose bit 3 and leaves the local header's sizes as zero.
 */
const zipEntries = (bytes: Uint8Array): ReadonlyArray<ZipEntry> | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(view)
  if (eocd === undefined) return undefined

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const entries: Array<ZipEntry> = []

  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length) return undefined
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return undefined
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    entries.push({ name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const zipEntryData = (
  bytes: Uint8Array,
  entry: ZipEntry
): Effect.Effect<Uint8Array, OperationalError> =>
  Effect.gen(function* () {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const start = entry.localHeaderOffset
    if (start + 30 > bytes.length || view.getUint32(start, true) !== LOCAL_SIGNATURE) {
      return yield* fail("open release archive: corrupt zip local header")
    }
    const nameLength = view.getUint16(start + 26, true)
    const extraLength = view.getUint16(start + 28, true)
    const dataStart = start + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > bytes.length) {
      return yield* fail("read release archive: truncated zip entry")
    }
    const raw = bytes.subarray(dataStart, dataEnd)

    if (entry.method === 0) return raw.slice(0, MAX_ARCHIVE_BYTES)
    if (entry.method === 8) {
      return yield* Effect.try({
        try: () => new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ARCHIVE_BYTES })),
        catch: (cause) => new OperationalError({ message: "read release archive", cause })
      })
    }
    return yield* fail(`read release archive: unsupported zip compression method ${entry.method}`)
  })

/** Extract `want` from zip bytes. Directory entries (trailing `/`) are skipped. */
export const extractFromZipBytes = (
  bytes: Uint8Array,
  want: string
): Effect.Effect<Uint8Array, OperationalError> =>
  Effect.gen(function* () {
    const entries = zipEntries(bytes)
    if (entries === undefined) {
      return yield* fail("open release archive: not a valid zip file")
    }
    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue
      if (!safeEntryMatch(entry.name, want)) continue
      return yield* zipEntryData(bytes, entry)
    }
    return yield* fail(notContained(want))
  })

/**
 * Pull the oytc binary out of a verified archive on disk.
 *
 * Format selection matches Go: zip when the path ends in `.zip` OR when
 * `goos === "windows"`, tar.gz otherwise.
 */
export const extractBinary = (
  archivePath: string,
  goos: string,
  want: string
): Effect.Effect<Uint8Array, OperationalError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bytes = yield* fs
      .readFile(archivePath)
      .pipe(
        Effect.catch((cause) =>
          Effect.fail(new OperationalError({ message: "open release archive", cause }))
        )
      )
    return yield* archivePath.endsWith(".zip") || goos === "windows"
      ? extractFromZipBytes(bytes, want)
      : extractFromTarGzBytes(bytes, want)
  })

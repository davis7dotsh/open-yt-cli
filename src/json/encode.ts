/**
 * Go-compatible JSON serializer.
 *
 * `JSON.stringify` CANNOT be used for output — it diverges from Go's
 * `encoding/json` in three ways:
 *
 *   1. Go always escapes U+2028/U+2029; `JSON.stringify` never does.
 *   2. Go replaces each invalid UTF-8 *byte* with U+FFFD (so one lone
 *      surrogate becomes THREE U+FFFD, one per byte of its WTF-8 encoding);
 *      `JSON.stringify` emits `\udXXX`.
 *   3. Go sorts map keys (by UTF-8 bytes); `JSON.stringify` uses insertion order.
 *
 * Verified against Go 1.26.5 `encoding/json` with `SetEscapeHTML(false)`.
 * NOTE: Go emits the SHORT escapes `\b` and `\f` (bytes `5c 62` / `5c 66`),
 * matching `JSON.stringify`. An earlier spec claimed ``/``; that
 * was wrong and is contradicted by the byte-level reference output.
 *
 * `JSON.stringify` is banned everywhere outside this file; CI enforces it.
 *
 * Two encoders exist because the Go code emits two different key orders:
 *   - `encodeGoValue`  sorts keys at every depth (Go marshals maps sorted)
 *   - `encodeGoStruct` preserves the given order (Go marshals structs in
 *     field-declaration order)
 */

import { compareUtf8 } from "../util/gostring.ts"
import { isJsonArray, isJsonObject, isRawNumber, type JsonValue } from "./value.ts"

export interface EncodeOptions {
  readonly indent: "" | "  "
}

const HEX = "0123456789abcdef"

const unicodeEscape = (code: number): string =>
  `\\u${HEX[(code >> 12) & 0xf]}${HEX[(code >> 8) & 0xf]}${HEX[(code >> 4) & 0xf]}${HEX[code & 0xf]}`

/**
 * Go `encoding/json` string escaping with `SetEscapeHTML(false)`.
 *
 * | input                        | output                            |
 * |------------------------------|-----------------------------------|
 * | `"` `\`                      | `\"` `\\`                         |
 * | U+000A / U+000D / U+0009     | `\n` / `\r` / `\t`                |
 * | other c < 0x20               | `\u00xx` (NOT `\b` / `\f`)        |
 * | `<` `>` `&`                  | literal (EscapeHTML false)        |
 * | U+2028 / U+2029              | ` ` / ` ` (always)      |
 * | lone surrogate               | literal U+FFFD                    |
 */
export const encodeGoString = (s: string): string => {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)

    if (code === 0x22) {
      out += '\\"'
      continue
    }
    if (code === 0x5c) {
      out += "\\\\"
      continue
    }
    if (code === 0x08) {
      out += "\\b"
      continue
    }
    if (code === 0x0c) {
      out += "\\f"
      continue
    }
    if (code === 0x0a) {
      out += "\\n"
      continue
    }
    if (code === 0x0d) {
      out += "\\r"
      continue
    }
    if (code === 0x09) {
      out += "\\t"
      continue
    }
    if (code < 0x20) {
      out += unicodeEscape(code)
      continue
    }
    if (code === 0x2028 || code === 0x2029) {
      out += unicodeEscape(code)
      continue
    }

    // Surrogate handling. A valid pair passes through as-is; a LONE surrogate
    // becomes a single U+FFFD.
    //
    // Verified against Go 1.26.5. Go's DECODER already replaces a `\uD800`
    // escape with one U+FFFD (bytes ef bf bd) at decode time, so by the time a
    // value reaches the encoder the lone surrogate is gone. Every string in
    // this pipeline arrives via parseJson, so one U+FFFD is the correct and
    // reachable behavior.
    //
    // (Go's ENCODER separately maps each invalid UTF-8 *byte* to U+FFFD, which
    // turns raw WTF-8 bytes into three U+FFFD — but raw bytes never enter this
    // pipeline, so that path is deliberately not reproduced.)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!
        i++
      } else {
        out += "�"
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�"
      continue
    }

    out += s[i]!
  }
  return out + '"'
}

const encodeValue = (value: JsonValue, indent: string, depth: number): string => {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") return encodeGoString(value)
  if (isRawNumber(value)) return value.$rawNumber

  const nl = indent === "" ? "" : "\n"
  const pad = indent === "" ? "" : indent.repeat(depth + 1)
  const padEnd = indent === "" ? "" : indent.repeat(depth)
  const sep = indent === "" ? "," : ",\n"
  const colon = indent === "" ? ":" : ": "

  if (isJsonArray(value)) {
    if (value.length === 0) return "[]"
    const parts = value.map((v) => pad + encodeValue(v, indent, depth + 1))
    return `[${nl}${parts.join(sep)}${nl}${padEnd}]`
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort(compareUtf8)
    if (keys.length === 0) return "{}"
    const parts = keys.map(
      (k) => pad + encodeGoString(k) + colon + encodeValue(value[k]!, indent, depth + 1)
    )
    return `{${nl}${parts.join(sep)}${nl}${padEnd}}`
  }

  return "null"
}

/** Encode with every object's keys sorted at every depth (Go map marshalling). */
export const encodeGoValue = (value: JsonValue, options: EncodeOptions): string =>
  encodeValue(value, options.indent, 0)

/**
 * Encode an object preserving the given entry order (Go struct marshalling).
 * Nested values still get `encodeGoValue`'s sorted-key treatment.
 */
export const encodeGoStruct = (
  entries: ReadonlyArray<readonly [key: string, value: JsonValue]>,
  options: EncodeOptions
): string => {
  if (entries.length === 0) return "{}"
  const { indent } = options
  const nl = indent === "" ? "" : "\n"
  const pad = indent
  const sep = indent === "" ? "," : ",\n"
  const colon = indent === "" ? ":" : ": "
  const parts = entries.map(
    ([k, v]) => pad + encodeGoString(k) + colon + encodeValue(v, indent, 1)
  )
  return `{${nl}${parts.join(sep)}${nl}}`
}

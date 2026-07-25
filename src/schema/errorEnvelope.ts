/**
 * Google's error envelope, decoded the way Go decodes it: tolerantly, and
 * NEVER throwing.
 *
 * Go writes `_ = json.Unmarshal(body, &envelope)` — the decode error is
 * explicitly discarded, so a malformed, non-JSON, empty, or HTML body simply
 * leaves every field at its zero value. The caller then falls back to the HTTP
 * status for `code` and to the canonical status text for `message`.
 *
 * This is deliberately hand-written rather than Schema-based. Go's decoder is
 * *partial*: when one element of `errors[]` has the wrong shape it records the
 * zero value for that element and keeps going, and it still fills sibling
 * fields. Verified against Go 1.26.5 (`go run` probe):
 *
 *   errors:[{reason:"a"},"junk",{reason:""},{reason:"b"}]  -> reasons a, b
 *   errors:["junk"], details:[{reason:"d1"}]               -> reasons d1
 *   errors:{reason:"a"}   (object, not array)              -> no reasons
 *   error:"boom"          (string, not object)             -> everything zero
 *   code:"403" / 403.7 / 4e2 / 99999999999999999999        -> code 0
 *   code:-5                                                -> code -5
 *   `{...} trailing garbage`                               -> everything zero
 *
 * That last one matters: `json.Unmarshal` (unlike `json.Decoder`) rejects
 * trailing content, so the envelope path uses a STRICT parse while the success
 * path (§1.9) tolerates trailing bytes. The asymmetry is real, not an oversight.
 *
 * `Schema.Array` is all-or-nothing and would drop every reason as soon as one
 * element were malformed, so it is the wrong tool here.
 *
 * KNOWN LIMITATION — repeated IDENTICAL keys. Go merges `{"error":{"code":9},
 * "error":{"message":"m"}}` into one struct (code 9 AND message "m"); the
 * underlying `JSON.parse` keeps only the last occurrence, so this yields
 * message "m" with code 0. Same root cause as the note in `schema/authfile.ts`
 * and it lives in `json/parse.ts`, not here. Case-VARIANT duplicates
 * (`"error"` + `"Error"`) are distinct keys and ARE handled correctly below.
 * Google's API never emits duplicate keys.
 */

import { Result } from "effect"
import { parseJson } from "../json/parse.ts"
import { isJsonObject, isRawNumber, type JsonObject, type JsonValue } from "../json/value.ts"

export interface ErrorEnvelope {
  /** `error.code`, or 0 when absent/not an integer. */
  readonly code: number
  /** `error.message`, or "" when absent/not a string. */
  readonly message: string
  /** `errors[].reason` then `details[].reason`; empties skipped, duplicates kept. */
  readonly reasons: ReadonlyArray<string>
}

export const emptyErrorEnvelope: ErrorEnvelope = { code: 0, message: "", reasons: [] }

/** Go's int64 bounds — `code` is declared `int`, so an overflow decodes to 0. */
const INT64_MIN = -9223372036854775808n
const INT64_MAX = 9223372036854775807n

/**
 * A JSON number that Go would accept into an `int` field: an integer literal
 * with no fraction, no exponent, and within int64 range. `403.0` and `4e2` are
 * both rejected by Go even though they are integral values.
 */
const asGoInt = (value: JsonValue | undefined): number | undefined => {
  if (!isRawNumber(value)) return undefined
  const literal = value.$rawNumber
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(literal)) return undefined
  const parsed = BigInt(literal)
  if (parsed < INT64_MIN || parsed > INT64_MAX) return undefined
  return Number(parsed)
}

/**
 * Go's `foldName`: struct-tag matching is CASE-INSENSITIVE when no exact match
 * exists, so `{"Error":{"CODE":403}}` decodes exactly like the lowercase form.
 * Verified against Go 1.26.5 — a case-sensitive lookup silently returns a zero
 * envelope for any provider that capitalises a key.
 *
 * The fold is ASCII-only plus Go's two special runes (`ſ` U+017F folds to `s`,
 * `K` U+212A to `k`); of those only `ſ` can appear in a field name here.
 * A non-ASCII near-miss such as `ɡ` (U+0261) does NOT match, matching Go.
 */
const foldName = (name: string): string => {
  let out = ""
  for (const char of name) {
    const code = char.codePointAt(0)!
    if (code === 0x017f) out += "S"
    else if (code === 0x212a) out += "K"
    else if (code < 0x80) out += char.toUpperCase()
    else out += char
  }
  return out
}

/**
 * Go matches an object key to a struct field by exact tag first, then by fold.
 * Keys are visited in document order and each assignment overwrites the last,
 * so `{"CODE":1,"code":2}` yields 2 and `{"code":2,"CODE":1}` yields 1.
 */
const fieldValues = (object: JsonObject, tag: string): Array<JsonValue | undefined> => {
  const folded = foldName(tag)
  const out: Array<JsonValue | undefined> = []
  for (const key of Object.keys(object)) {
    if (key === tag || foldName(key) === folded) out.push(object[key])
  }
  return out
}

const asString = (value: JsonValue | undefined): string =>
  typeof value === "string" ? value : ""

/** Element-wise, tolerant: non-objects and empty reasons contribute nothing. */
const collectReasons = (value: JsonValue | undefined, into: Array<string>): void => {
  if (!Array.isArray(value)) return
  for (const element of value) {
    if (!isJsonObject(element)) continue
    // `reason` is matched with the same fold rule as every other tag.
    let reason: JsonValue | undefined
    for (const candidate of fieldValues(element, "reason")) reason = candidate
    if (typeof reason === "string" && reason !== "") into.push(reason)
  }
}

/**
 * Best-effort extraction. Any failure — invalid JSON, an unexpected shape, a
 * wrong-typed field — yields zero values for the affected parts and never
 * raises.
 */
export const parseErrorEnvelope = (body: string): ErrorEnvelope => {
  const parsed = parseJson(body)
  if (Result.isFailure(parsed)) return emptyErrorEnvelope

  const root = parsed.success
  if (!isJsonObject(root)) return emptyErrorEnvelope

  // Go decodes EVERY key that matches the `error` tag (exactly or by fold), in
  // document order, merging into the one struct. A key whose value is not an
  // object — `null`, a string, a number — is a no-op that leaves already-decoded
  // fields intact, so `{"error":{"code":1},"Error":"junk"}` still yields 1.
  let code = 0
  let message = ""
  let errors: JsonValue | undefined
  let details: JsonValue | undefined
  let sawError = false

  for (const candidate of fieldValues(root, "error")) {
    if (candidate === undefined || !isJsonObject(candidate)) continue
    sawError = true
    // Scalars: a valid value overwrites; null or a wrong type is a no-op.
    for (const raw of fieldValues(candidate, "code")) {
      const next = asGoInt(raw)
      if (next !== undefined) code = next
    }
    for (const raw of fieldValues(candidate, "message")) {
      if (typeof raw === "string") message = raw
    }
    // Slices: an array overwrites and `null` RESETS to nil, but any other type
    // is a no-op. Verified against Go 1.26.5.
    for (const raw of fieldValues(candidate, "errors")) {
      if (Array.isArray(raw)) errors = raw
      else if (raw === null) errors = undefined
    }
    for (const raw of fieldValues(candidate, "details")) {
      if (Array.isArray(raw)) details = raw
      else if (raw === null) details = undefined
    }
  }

  if (!sawError) return emptyErrorEnvelope

  const reasons: Array<string> = []
  collectReasons(errors, reasons)
  collectReasons(details, reasons)

  return { code, message, reasons }
}

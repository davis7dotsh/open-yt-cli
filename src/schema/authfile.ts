/**
 * `auth.json` — the on-disk credential file.
 *
 * DELIBERATELY HAND-ROLLED rather than an Effect `Schema`. Go's
 * `encoding/json` has three behaviors this file must reproduce exactly, none of
 * which a `Schema` expresses naturally:
 *
 *   1. `null` is never a decode error, but what it DOES depends on the Go field
 *      type. Into a non-pointer `string` it is a NO-OP, so
 *      `{"api_key":"a","API_KEY":null}` keeps `"a"`; into a pointer (`oauth`) or
 *      a slice (`scopes`) it assigns nil. A `Schema.NullOr` union captures
 *      neither rule.
 *   2. A wrong *type* IS an error (`{"api_key":123}` fails), and `Load()`
 *      converts that into the corrupt-file/env-key fallback, so the
 *      strict-vs-tolerant split has to land on exactly Go's line.
 *   3. Object keys are resolved to fields by exact tag match OR a
 *      case-insensitive fold, and every matching key is decoded IN DOCUMENT
 *      ORDER into the same field — so `{"api_key":"exact","API_KEY":"upper"}`
 *      yields `"upper"`, and two case-variant `oauth` objects MERGE rather than
 *      the last replacing the first. Verified against Go 1.26.5.
 *
 * Differentially fuzzed against the real Go structs over 4,000 generated
 * documents (case variants, nulls, wrong types, nested and repeated `oauth`
 * blocks): identical on every input, with one class of exception.
 *
 * KNOWN LIMITATION — repeated IDENTICAL keys. `JSON.parse` collapses
 * `{"api_key":123,"api_key":"ok"}` to last-wins before this decoder runs, so
 * an earlier duplicate's TYPE ERROR is invisible and Go's hard failure becomes
 * a success here. (It never differs the other way: this decoder is never
 * stricter than Go.) Reproducing it needs a parser that surfaces every
 * key/value pair, which `src/json/parse.ts` deliberately does not do. The
 * effect is confined to a hand-edited auth.json that repeats a key verbatim
 * AND gives the earlier copy a wrong type; the value ultimately read is still
 * Go's last-wins value.
 *
 * The serializer is likewise hand-composed. `encodeGoStruct` only preserves key
 * order at the top level — nested objects are sorted, which would emit the six
 * oauth keys alphabetically. Go marshals them in struct-field order, so the
 * `oauth` block is encoded on its own and re-indented into place.
 *
 * nil vs. empty `scopes` is a real distinction on disk: a nil slice marshals as
 * `null`, an empty slice as `[]`. `undefined` here means nil.
 */

import { Data, Result } from "effect"
import { encodeGoString, encodeGoStruct } from "../json/encode.ts"
import { isJsonArray, isJsonObject, type JsonValue } from "../json/value.ts"

export class AuthFileDecodeError extends Data.TaggedError("AuthFileDecodeError")<{
  readonly message: string
}> {}

/** The `oauth` block. `scopes: undefined` is Go's nil slice, which emits `null`. */
export interface AuthOAuth {
  readonly clientId: string
  readonly clientSecret: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiry: string
  readonly scopes: ReadonlyArray<string> | undefined
}

export interface AuthFile {
  readonly apiKey: string
  readonly oauth: AuthOAuth | undefined
}

export const emptyAuthFile: AuthFile = { apiKey: "", oauth: undefined }

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

type JsonObject = { readonly [key: string]: JsonValue }

/**
 * Every value that Go would decode into the field tagged `name`, in DOCUMENT
 * ORDER, gathered across all `objects` (an object list because a struct field
 * can be targeted by several case-variant keys — see `decodeAuthFile`).
 *
 * `encoding/json` walks the object's keys in order and resolves each to a field
 * by exact tag match first, case-insensitive (`equalsFold`) match second, then
 * ASSIGNS. It does not stop at the first hit, so several keys can write the same
 * field and the effect is cumulative rather than "exact match wins":
 *
 *   {"api_key":"exact","API_KEY":"upper"} -> "upper"   (NOT "exact")
 *   {"API_KEY":"upper","api_key":"exact"} -> "exact"
 *   {"API_KEY":"a","Api_Key":"b"}         -> "b"
 *
 * Callers fold this list with the semantics of their own Go field type, which
 * differ for `null` (see `decodeString` vs `decodeScopes`). No two field names
 * in this schema fold-collide, so a fold-equality test is exactly Go's rule.
 * Verified against Go 1.26.5.
 */
const goFields = (objects: ReadonlyArray<JsonObject>, name: string): ReadonlyArray<JsonValue> => {
  const lower = name.toLowerCase()
  const values: Array<JsonValue> = []
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      if (key === name || key.toLowerCase() === lower) values.push(object[key] as JsonValue)
    }
  }
  return values
}

const jsonKind = (value: JsonValue): string => {
  if (value === null) return "null"
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "bool"
  if (isJsonArray(value)) return "array"
  if (isJsonObject(value)) return "object"
  return "number"
}

const fail = (message: string): Result.Result<never, AuthFileDecodeError> =>
  Result.fail(new AuthFileDecodeError({ message }))

/**
 * Fold every value targeting a Go `string` field.
 *
 * `null` into a NON-POINTER field is a documented Go no-op ("To unmarshal JSON
 * null into a value, Unmarshal sets that value to nil" applies to
 * interface/pointer/map/slice; for a string it leaves the field untouched), so
 * `{"api_key":"a","API_KEY":null}` keeps `"a"`. A wrong type is a hard error.
 */
const decodeString = (
  values: ReadonlyArray<JsonValue>,
  field: string
): Result.Result<string, AuthFileDecodeError> => {
  let result = ""
  for (const value of values) {
    // A null leaves the previously-assigned value in place.
    if (value === null) continue
    if (typeof value !== "string") {
      return fail(
        `json: cannot unmarshal ${jsonKind(value)} into Go struct field ${field} of type string`
      )
    }
    result = value
  }
  return Result.succeed(result)
}

/**
 * Fold every value targeting the `[]string` scopes field. Unlike a string, a
 * SLICE field IS set to nil by `null`, so a trailing `"SCOPES":null` really does
 * clear an earlier `"scopes":["a"]`.
 */
const decodeScopes = (
  values: ReadonlyArray<JsonValue>
): Result.Result<ReadonlyArray<string> | undefined, AuthFileDecodeError> => {
  let result: ReadonlyArray<string> | undefined
  for (const value of values) {
    if (value === null) {
      result = undefined
      continue
    }
    if (!isJsonArray(value)) {
      return fail(
        `json: cannot unmarshal ${jsonKind(value)} into Go struct field OAuthCredentials.oauth.scopes of type []string`
      )
    }
    const scopes: Array<string> = []
    for (const element of value) {
      // Go decodes a null array element to the zero value, keeping the slot.
      if (element === null) {
        scopes.push("")
        continue
      }
      if (typeof element !== "string") {
        return fail(
          `json: cannot unmarshal ${jsonKind(element)} into Go struct field OAuthCredentials.oauth.scopes of type string`
        )
      }
      scopes.push(element)
    }
    result = scopes
  }
  return Result.succeed(result)
}

/**
 * Decode the `oauth` block from every object that targeted it, in order. Go
 * allocates the struct once and decodes each such object INTO it, so
 * `{"oauth":{"client_id":"a"},"OAUTH":{"client_secret":"b"}}` merges into a
 * single value rather than the last object replacing the first.
 */
const decodeOAuth = (
  objects: ReadonlyArray<JsonObject>
): Result.Result<AuthOAuth, AuthFileDecodeError> => {
  const clientId = decodeString(
    goFields(objects, "client_id"),
    "OAuthCredentials.oauth.client_id"
  )
  if (Result.isFailure(clientId)) return Result.fail(clientId.failure)
  const clientSecret = decodeString(
    goFields(objects, "client_secret"),
    "OAuthCredentials.oauth.client_secret"
  )
  if (Result.isFailure(clientSecret)) return Result.fail(clientSecret.failure)
  const accessToken = decodeString(
    goFields(objects, "access_token"),
    "OAuthCredentials.oauth.access_token"
  )
  if (Result.isFailure(accessToken)) return Result.fail(accessToken.failure)
  const refreshToken = decodeString(
    goFields(objects, "refresh_token"),
    "OAuthCredentials.oauth.refresh_token"
  )
  if (Result.isFailure(refreshToken)) return Result.fail(refreshToken.failure)
  const expiry = decodeString(goFields(objects, "expiry"), "OAuthCredentials.oauth.expiry")
  if (Result.isFailure(expiry)) return Result.fail(expiry.failure)
  const scopes = decodeScopes(goFields(objects, "scopes"))
  if (Result.isFailure(scopes)) return Result.fail(scopes.failure)

  return Result.succeed({
    clientId: clientId.success,
    clientSecret: clientSecret.success,
    accessToken: accessToken.success,
    refreshToken: refreshToken.success,
    expiry: expiry.success,
    scopes: scopes.success
  })
}

/**
 * Decode a parsed `auth.json`. Top-level `null` is a no-op yielding the zero
 * File (Go); any other non-object is an error.
 */
export const decodeAuthFile = (
  value: JsonValue
): Result.Result<AuthFile, AuthFileDecodeError> => {
  if (value === null) return Result.succeed(emptyAuthFile)
  if (!isJsonObject(value)) {
    return fail(`json: cannot unmarshal ${jsonKind(value)} into Go value of type config.File`)
  }

  const apiKey = decodeString(goFields([value], "api_key"), "File.api_key")
  if (Result.isFailure(apiKey)) return Result.fail(apiKey.failure)

  // `oauth` is a POINTER field, so `null` really does reset it to nil — but a
  // later object then re-allocates and decodes into a fresh struct. Collect the
  // objects that survive the last null and merge them.
  const rawOAuths = goFields([value], "oauth")
  const blocks: Array<JsonObject> = []
  for (const raw of rawOAuths) {
    if (raw === null) {
      blocks.length = 0
      continue
    }
    if (!isJsonObject(raw)) {
      return fail(
        `json: cannot unmarshal ${jsonKind(raw)} into Go struct field File.oauth of type config.OAuthCredentials`
      )
    }
    // Validate EVERY block, even one a later null discards. Go decodes each
    // object as it walks the document and keeps the first error it hits, so a
    // bad type inside a block that is subsequently cleared still fails the
    // whole Unmarshal — which is what routes Load() to its corrupt-file path.
    const checked = decodeOAuth([raw])
    if (Result.isFailure(checked)) return Result.fail(checked.failure)
    blocks.push(raw)
  }
  if (blocks.length === 0) {
    return Result.succeed({ apiKey: apiKey.success, oauth: undefined })
  }
  const oauth = decodeOAuth(blocks)
  if (Result.isFailure(oauth)) return Result.fail(oauth.failure)
  return Result.succeed({ apiKey: apiKey.success, oauth: oauth.success })
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Push every line but the first right by `pad`, nesting a rendered block. */
const indentBlock = (text: string, pad: string): string => text.split("\n").join(`\n${pad}`)

const encodeOAuthBlock = (oauth: AuthOAuth): string =>
  indentBlock(
    encodeGoStruct(
      [
        ["client_id", oauth.clientId],
        ["client_secret", oauth.clientSecret],
        ["access_token", oauth.accessToken],
        ["refresh_token", oauth.refreshToken],
        ["expiry", oauth.expiry],
        // A nil slice is `null`; an empty slice is `[]`. Both are reachable.
        ["scopes", oauth.scopes === undefined ? null : [...oauth.scopes]]
      ],
      { indent: "  " }
    ),
    "  "
  )

/**
 * `json.MarshalIndent(file, "", "  ")` + a trailing newline.
 *
 * `api_key` is `omitempty`; `oauth` is omitted when nil; the six oauth keys are
 * always present. An entirely empty file marshals to `{}\n`.
 *
 * NOTE: Go's `json.Marshal` escapes `<`, `>` and `&` as `<`/`>`/
 * `&` (HTML escaping is on by default — `internal/output` explicitly turns
 * it OFF, `internal/config` does not). Credential values are opaque secrets,
 * so an API key containing one of those bytes would round-trip differently
 * from Go byte-for-byte. It still round-trips correctly through this reader,
 * and Google API keys / OAuth tokens are `[A-Za-z0-9._~-]`, so the divergence
 * is unreachable in practice. Flagged rather than fixed because the shared
 * `encodeGoString` is owned elsewhere.
 */
export const encodeAuthFile = (file: AuthFile): string => {
  const lines: Array<string> = []
  if (file.apiKey !== "") {
    lines.push(`  ${encodeGoString("api_key")}: ${encodeGoString(file.apiKey)}`)
  }
  if (file.oauth !== undefined) {
    lines.push(`  ${encodeGoString("oauth")}: ${encodeOAuthBlock(file.oauth)}`)
  }
  if (lines.length === 0) return "{}\n"
  return `{\n${lines.join(",\n")}\n}\n`
}

// ---------------------------------------------------------------------------
// Helpers shared with the credential store
// ---------------------------------------------------------------------------

/**
 * Go's `cloneOAuth`. Note `append([]string(nil), empty...)` returns **nil**, so
 * an empty scope slice becomes nil here and therefore serializes as `null`.
 */
export const cloneOAuth = (oauth: AuthOAuth): AuthOAuth => ({
  ...oauth,
  scopes: oauth.scopes === undefined || oauth.scopes.length === 0 ? undefined : [...oauth.scopes]
})

/**
 * Go's `sameOAuth`: both nil -> equal; exactly one nil -> not equal; otherwise
 * all five strings, then scope length, then each scope by index. A nil slice
 * and an empty slice both have length 0 and so compare equal.
 */
export const sameOAuth = (
  left: AuthOAuth | undefined,
  right: AuthOAuth | undefined
): boolean => {
  if (left === undefined || right === undefined) return left === right
  if (
    left.clientId !== right.clientId ||
    left.clientSecret !== right.clientSecret ||
    left.accessToken !== right.accessToken ||
    left.refreshToken !== right.refreshToken ||
    left.expiry !== right.expiry
  ) {
    return false
  }
  const leftScopes = left.scopes ?? []
  const rightScopes = right.scopes ?? []
  if (leftScopes.length !== rightScopes.length) return false
  for (let i = 0; i < leftScopes.length; i++) {
    if (leftScopes[i] !== rightScopes[i]) return false
  }
  return true
}

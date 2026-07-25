/**
 * JSON value model that preserves numeric literals exactly.
 *
 * Go's decoder runs with `UseNumber()`, so every JSON number keeps its original
 * source text and is re-emitted verbatim. YouTube returns counters beyond
 * 2^53 (a Go test feeds `9007199254740993123`), which JS `number` silently
 * corrupts. `RawNumber` carries the literal text instead.
 *
 * `RawNumber` is deliberately a distinct object type, not a branded string:
 * that makes `String(rawNumber)` or arithmetic on it a *type* error rather
 * than a silent `"[object Object]"` at runtime.
 */

export interface RawNumber {
  readonly $rawNumber: string
}

export const rawNumber = (literal: string): RawNumber => ({ $rawNumber: literal })

export const isRawNumber = (u: unknown): u is RawNumber =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as RawNumber).$rawNumber === "string" &&
  Object.keys(u as object).length === 1

export type JsonValue =
  | string
  | boolean
  | null
  | RawNumber
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export type JsonArray = ReadonlyArray<JsonValue>

export const isJsonObject = (u: JsonValue): u is JsonObject =>
  typeof u === "object" && u !== null && !Array.isArray(u) && !isRawNumber(u)

export const isJsonArray = (u: JsonValue): u is JsonArray => Array.isArray(u)

/** Go's `json.Number.String()` — the original literal text. */
export const rawLiteral = (n: RawNumber): string => n.$rawNumber

/**
 * Narrow a `RawNumber` to a JS number. Only for the few places a real number is
 * needed for arithmetic (e.g. `pollingIntervalMillis`), never for output.
 * Returns `undefined` for anything that is not a finite numeric literal.
 */
export const rawToNumber = (u: unknown): number | undefined => {
  if (!isRawNumber(u)) return undefined
  const n = Number(u.$rawNumber)
  return Number.isFinite(n) ? n : undefined
}

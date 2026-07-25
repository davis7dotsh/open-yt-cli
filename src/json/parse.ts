/**
 * Number-preserving JSON parse — the TypeScript equivalent of Go's
 * `json.Decoder` with `UseNumber()`.
 *
 * Uses the ES2025 `source` reviver argument, verified present in Bun 1.3.14.
 * Every JSON number becomes a `RawNumber` carrying its ORIGINAL source text,
 * so `9007199254740993123`, `1.50`, `1e3` and `-0` all survive a
 * parse -> encode round-trip byte-for-byte.
 */

import { Data, Effect, Result } from "effect"
import { type JsonValue, rawNumber } from "./value.ts"

export class JsonParseError extends Data.TaggedError("JsonParseError")<{
  readonly message: string
}> {}

interface ReviverContext {
  readonly source?: string | undefined
}

type Reviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown

const reviver: Reviver = (_key, value, context) =>
  typeof value === "number" && context !== undefined && typeof context.source === "string"
    ? rawNumber(context.source)
    : value

/**
 * Fail loudly at module load if the runtime lacks the `source` reviver, rather
 * than silently degrading to lossy numbers at some later point in the data path.
 */
const assertSourceReviverSupported = (): void => {
  let seen: string | undefined
  JSON.parse("1.50", ((_k: string, _v: unknown, ctx?: ReviverContext) => {
    seen = ctx?.source
    return _v
  }) as Reviver)
  if (seen !== "1.50") {
    throw new Error(
      "runtime does not support the JSON `source` reviver argument; " +
        "numeric literals would be corrupted (requires Bun >= 1.3 / ES2025)"
    )
  }
}

assertSourceReviverSupported()

export const parseJson = (text: string): Result.Result<JsonValue, JsonParseError> => {
  try {
    return Result.succeed(JSON.parse(text, reviver as Reviver) as JsonValue)
  } catch (cause) {
    return Result.fail(
      new JsonParseError({
        message: cause instanceof Error ? cause.message : String(cause)
      })
    )
  }
}

export const parseJsonEffect = (text: string): Effect.Effect<JsonValue, JsonParseError> =>
  Effect.fromResult(parseJson(text))

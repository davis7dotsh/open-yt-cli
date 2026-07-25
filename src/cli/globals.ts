/**
 * Resolution of the global flags into the AppOptions service value.
 */

import { Option, Result } from "effect"
import { UsageError } from "../domain/errors.ts"
import { parseGoDuration } from "../util/goduration.ts"
import type { AppOptionsShape, OutputFormat } from "../services/index.ts"
import type { GlobalFlagValues } from "./flags.ts"

/**
 * cobra's StringSliceVar semantics: comma-separated, with double-quoted
 * segments allowed to contain commas.
 */
export const parseCsv = (input: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === "," && !inQuotes) {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out.filter((s) => s !== "")
}

export interface ResolveGlobalsOptions {
  readonly isOutputTTY: boolean
  /** `live-chat stream` forces jsonl when the user did not pass --format. */
  readonly defaultFormat?: OutputFormat | undefined
}

export const resolveGlobals = (
  flags: GlobalFlagValues,
  options: ResolveGlobalsOptions
): Result.Result<AppOptionsShape, UsageError> => {
  const timeout = parseGoDuration(flags.timeout)
  if (Result.isFailure(timeout)) {
    return Result.fail(new UsageError({ message: timeout.failure.message }))
  }
  if (timeout.success <= 0) {
    return Result.fail(new UsageError({ message: "--timeout must be positive" }))
  }

  const fallback: OutputFormat =
    options.defaultFormat ?? (options.isOutputTTY ? "table" : "json")

  return Result.succeed({
    format: Option.getOrElse(flags.format, () => fallback),
    columns: Option.match(flags.columns, {
      onNone: () => [] as ReadonlyArray<string>,
      onSome: parseCsv
    }),
    noHeader: flags.noHeader,
    quiet: flags.quiet,
    timeoutMillis: timeout.success,
    isOutputTTY: options.isOutputTTY
  })
}

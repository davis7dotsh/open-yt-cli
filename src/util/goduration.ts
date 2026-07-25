/**
 * Go `time.ParseDuration` — used by `--timeout`.
 *
 * Accepts a signed decimal sequence of number+unit pairs, e.g. "300ms",
 * "1m30s", "2h45m", "-1.5h". Valid units: ns, us (or µs/μs), ms, s, m, h.
 * A unit is required; "0" is the sole exception Go allows.
 */

import { Result } from "effect"

const UNITS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  "μs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000
}

export class DurationParseError {
  readonly _tag = "DurationParseError"
  constructor(readonly input: string) {}
  get message(): string {
    return `invalid duration ${JSON.stringify(this.input)}`
  }
}

/** Returns milliseconds, matching how the HTTP layer consumes a timeout. */
export const parseGoDuration = (
  input: string
): Result.Result<number, DurationParseError> => {
  const fail = () => Result.fail(new DurationParseError(input))

  if (input === "") return fail()
  if (input === "0") return Result.succeed(0)

  let rest = input
  let sign = 1
  if (rest.startsWith("-")) {
    sign = -1
    rest = rest.slice(1)
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1)
  }
  if (rest === "") return fail()
  if (rest === "0") return Result.succeed(0)

  let total = 0
  let matchedAny = false

  while (rest.length > 0) {
    const numMatch = /^\d*\.?\d*/.exec(rest)
    const numText = numMatch?.[0] ?? ""
    if (numText === "" || numText === ".") return fail()
    rest = rest.slice(numText.length)

    const unitMatch = /^(ns|us|µs|μs|ms|s|m|h)/.exec(rest)
    const unit = unitMatch?.[0]
    if (unit === undefined) return fail()
    rest = rest.slice(unit.length)

    const value = Number(numText)
    if (!Number.isFinite(value)) return fail()

    total += value * UNITS[unit]!
    matchedAny = true
  }

  return matchedAny ? Result.succeed(sign * total) : fail()
}

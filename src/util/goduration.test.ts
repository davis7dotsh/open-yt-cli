import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { parseGoDuration } from "./goduration.ts"

const ms = (input: string): number => {
  const r = parseGoDuration(input)
  if (Result.isFailure(r)) throw new Error(`unexpected failure for ${input}`)
  return r.success
}

describe("parseGoDuration", () => {
  test.each([
    ["0", 0],
    ["20s", 20_000],
    ["1m30s", 90_000],
    ["500ms", 500],
    ["2h45m", 9_900_000],
    ["1.5h", 5_400_000],
    ["-1.5h", -5_400_000],
    ["+30s", 30_000],
    ["100us", 0.1],
    ["1000ns", 0.001],
    ["1h1m1s", 3_661_000]
  ])("%s -> %dms", (input, expected) => {
    expect(ms(input)).toBeCloseTo(expected, 6)
  })

  test.each([[""], ["20"], ["abc"], ["s"], ["-"], ["1x"], ["."], ["1.2.3s"]])(
    "rejects %s",
    (input) => {
      expect(Result.isFailure(parseGoDuration(input))).toBe(true)
    }
  )

  test("error message matches Go's phrasing", () => {
    const r = parseGoDuration("nope")
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure.message).toBe('invalid duration "nope"')
    }
  })
})

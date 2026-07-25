/**
 * Version tag comparison — a faithful port of `internal/update/update.go`'s
 * `parseVersion` / `CompareVersions`.
 *
 * This is deliberately **not** SemVer. Two behaviours are load-bearing and
 * must not be "fixed":
 *
 *   1. The prerelease tie-break is a plain **byte-wise string comparison**,
 *      not SemVer's dot-separated identifier comparison. So `rc.10` sorts
 *      BEFORE `rc.2`. Changing this would silently change which release the
 *      updater considers newer. Go compares UTF-8 bytes, so `compareUtf8` is
 *      used rather than JS `<`, which compares UTF-16 code units and disagrees
 *      above the BMP.
 *   2. Anything that does not parse makes the pair **incomparable**, not
 *      "equal". A `dev` build is therefore never up to date, which is exactly
 *      why an uninjected build always proceeds to install the latest release.
 */

import { compareUtf8 } from "../util/gostring.ts"

/** Go's `unicode.IsSpace`, which is not the same set as JS `String.trim`. */
const GO_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000
])

/**
 * Go's `unicode.IsSpace`. Exported because `strings.Fields` needs the same
 * predicate, and the JS `\s` class is not it: `\s` matches U+FEFF, which Go
 * does not, and misses U+0085, which Go does.
 */
export const isGoSpace = (code: number): boolean =>
  GO_SPACE.has(code) || (code >= 0x2000 && code <= 0x200a)

/**
 * `strings.TrimSpace`. JS `trim()` differs at both ends of the table: it does
 * not strip U+0085 (NEL) and it does strip U+FEFF, neither of which matches Go.
 */
export const goTrimSpace = (value: string): string => {
  let start = 0
  let end = value.length
  while (start < end && isGoSpace(value.charCodeAt(start))) start++
  while (end > start && isGoSpace(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}

/** `strings.Cut(s, sep)` — split at the FIRST occurrence only. */
const cut = (value: string, separator: string): readonly [string, string] => {
  const index = value.indexOf(separator)
  return index < 0 ? [value, ""] : [value.slice(0, index), value.slice(index + separator.length)]
}

/**
 * `strconv.Atoi`, including its refusal of whitespace, underscores, decimal
 * points and exponents, and its out-of-range failure past int64. Returns
 * `undefined` where Go returns an error.
 */
const atoi = (text: string): number | undefined => {
  if (!/^[+-]?[0-9]+$/.test(text)) return undefined
  const value = BigInt(text)
  // Go's `int` is 64-bit on every platform oytc ships for.
  if (value > 9223372036854775807n || value < -9223372036854775808n) return undefined
  return Number(value)
}

export interface ParsedVersion {
  /** major, minor, patch. */
  readonly numbers: readonly [number, number, number]
  /** Prerelease text after the first `-`, or `""`. */
  readonly prerelease: string
}

/**
 * `parseVersion`. Returns `undefined` when the tag is not a `x.y.z` core with
 * an optional `-prerelease` and optional `+build` metadata.
 *
 * Faithful oddities, verified against Go:
 *   - build metadata is stripped from the CORE only, so `1.2.3-rc.1+b` keeps a
 *     prerelease of `rc.1+b`;
 *   - a leading `+` does NOT parse: `strings.Cut(core, "+")` runs before
 *     `strconv.Atoi`, so `+1.2.3` empties the core and is rejected even though
 *     `Atoi("+1")` would have succeeded;
 *   - `01` is 1, and `1.2.3-` has an empty (i.e. release) prerelease.
 */
export const parseVersion = (tag: string): ParsedVersion | undefined => {
  let text = goTrimSpace(tag)
  if (text.startsWith("v")) text = text.slice(1)
  if (text === "") return undefined

  const [beforeDash, prerelease] = cut(text, "-")
  const [core] = cut(beforeDash, "+")

  const parts = core.split(".")
  if (parts.length !== 3) return undefined

  const numbers: Array<number> = []
  for (const part of parts) {
    const value = atoi(part)
    if (value === undefined || value < 0) return undefined
    numbers.push(value)
  }
  return { numbers: [numbers[0]!, numbers[1]!, numbers[2]!], prerelease }
}

export type VersionOrder = -1 | 0 | 1

export interface VersionComparison {
  /** `-1` when a < b, `0` when equal, `1` when a > b. `0` when incomparable. */
  readonly order: VersionOrder
  /** False when either side failed to parse; `order` is then meaningless. */
  readonly comparable: boolean
}

const INCOMPARABLE: VersionComparison = { order: 0, comparable: false }

/**
 * `CompareVersions(a, b)`. Compares major/minor/patch numerically, then
 * tie-breaks on the prerelease: a release outranks any of its prereleases,
 * and two prereleases compare **byte-wise as strings**.
 */
export const compareVersions = (a: string, b: string): VersionComparison => {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return INCOMPARABLE

  for (let i = 0; i < 3; i++) {
    const x = left.numbers[i]!
    const y = right.numbers[i]!
    if (x !== y) return { order: x < y ? -1 : 1, comparable: true }
  }

  if (left.prerelease === right.prerelease) return { order: 0, comparable: true }
  if (left.prerelease === "") return { order: 1, comparable: true }
  if (right.prerelease === "") return { order: -1, comparable: true }
  return {
    order: compareUtf8(left.prerelease, right.prerelease) < 0 ? -1 : 1,
    comparable: true
  }
}

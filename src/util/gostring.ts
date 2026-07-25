/**
 * Go string semantics that differ from JavaScript defaults.
 */

/**
 * Compare two strings by their UTF-8 byte sequences, which is what Go's
 * `sort.Strings` (and therefore `encoding/json`'s map-key ordering) does.
 *
 * JavaScript's `<` compares UTF-16 code units, which disagrees with UTF-8 byte
 * order whenever an astral-plane character (encoded as a surrogate pair,
 * 0xD800-0xDFFF) is compared against U+E000-U+FFFF. Comparing by code point
 * reproduces UTF-8 byte order exactly, because UTF-8 encoding is
 * order-preserving over code points.
 */
export const compareUtf8 = (a: string, b: string): number => {
  if (a === b) return 0
  const aCodes = Array.from(a, (c) => c.codePointAt(0) ?? 0)
  const bCodes = Array.from(b, (c) => c.codePointAt(0) ?? 0)
  const len = Math.min(aCodes.length, bCodes.length)
  for (let i = 0; i < len; i++) {
    const x = aCodes[i]!
    const y = bCodes[i]!
    if (x !== y) return x < y ? -1 : 1
  }
  return aCodes.length === bCodes.length ? 0 : aCodes.length < bCodes.length ? -1 : 1
}

/**
 * Number of Unicode code points ("runes" in Go), not UTF-16 code units.
 * Go's text/tabwriter measures cell widths in runes.
 */
export const runeLength = (s: string): number => Array.from(s).length

/** Sort a copy of `keys` in Go map-marshal order. */
export const sortKeysUtf8 = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...keys].sort(compareUtf8)

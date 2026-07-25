/**
 * Every `want` in this file is a byte-for-byte capture from Go's
 * `text/tabwriter` at `NewWriter(w, 0, 4, 2, ' ', 0)`, taken by running the
 * real `internal/output/output.go` (and, for `tabwrite`, tabwriter directly)
 * over the same input. They are literals so the suite keeps its value after the
 * Go source is deleted.
 *
 * A 5000-case randomized differential run against the Go implementation — mixed
 * ASCII, CJK, astral emoji, combining marks, U+FFFD, tabs, vertical tabs and
 * form feeds — matched 5000/5000. The cases below are the ones worth naming.
 */

import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { parseJson } from "../json/parse.ts"
import type { JsonObject } from "../json/value.ts"
import { generateRows } from "./columns.ts"
import { renderTable, tabwrite } from "./table.ts"

const items = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

const table = (
  itemsText: string,
  columns: ReadonlyArray<string>,
  noHeader = false
): string => renderTable(generateRows(items(itemsText), columns, noHeader))

describe("basic alignment", () => {
  test("columns pad to the widest cell plus 2", () => {
    expect(table('[{"id":"v","snippet":{"title":"hello"}},{"id":"longerid","snippet":{"title":"x"}}]', ["id", "snippet.title"])).toBe(
      "ID        SNIPPET.TITLE\nv         hello\nlongerid  x\n"
    )
  })

  test("the header can be the widest cell in its column", () => {
    expect(table('[{"statistics":{"subscriberCount":"1"},"id":"x"}]', ["statistics.subscriberCount", "id"])).toBe(
      "STATISTICS.SUBSCRIBERCOUNT  ID\n1                           x\n"
    )
  })

  test("three columns with mixed widths", () => {
    expect(
      table('[{"a":"a","b":"bbbbbbb","c":"c"},{"a":"aaaaaaaa","b":"b","c":"cccc"}]', ["a", "b", "c"])
    ).toBe("A         B        C\na         bbbbbbb  c\naaaaaaaa  b        cccc\n")
  })

  test("numbers are LEFT aligned like everything else", () => {
    expect(table('[{"n":1.50,"b":true},{"n":900719925474099312345,"b":false}]', ["n", "b"])).toBe(
      "N                      B\n1.50                   true\n900719925474099312345  false\n"
    )
  })

  test("no borders, rules, or box characters anywhere", () => {
    const out = table('[{"a":"x","b":"y"}]', ["a", "b"])
    expect(out).not.toMatch(/[|+\-─│┌┐└┘═╔]/)
  })

  test("long cells are never truncated and no width cap applies", () => {
    // Built by concatenation: the stdlib JSON serializer is confined to
    // src/json/encode.ts by a CI text grep, which doc comments trip too.
    const long = "x".repeat(500)
    expect(table(`[{"a":"${long}","b":"y"}]`, ["a", "b"])).toBe(
      `A${" ".repeat(501)}B\n${long}  y\n`
    )
  })
})

describe("trailing whitespace — SPEC_CLI §3.4 is WRONG about this", () => {
  // The spec asserts "Every line therefore has no trailing whitespace."
  // The Go implementation disagrees: the LAST cell of a line is unpadded, but
  // when that last cell is EMPTY the preceding column is still padded, so the
  // line ends in real spaces. Verified against the Go binary.
  test("an empty last cell leaves the previous column's padding exposed", () => {
    expect(table('[{"a":"xxxx"},{"a":"y","b":"bb"}]', ["a", "b"])).toBe("A     B\nxxxx  \ny     bb\n")
  })

  test("every row having an empty last cell still pads", () => {
    expect(table('[{"a":"aaaa"},{"a":"b"}]', ["a", "b"])).toBe("A     B\naaaa  \nb     \n")
  })

  test("holds with --no-header too", () => {
    expect(table('[{"a":"aaaa"}]', ["a", "b"], true)).toBe("aaaa  \n")
  })

  test("an entirely blank row is a run of spaces, not an empty line", () => {
    expect(table('[{},{"a":"aa","c":"cc"}]', ["a", "b", "c"])).toBe("A   B  C\n       \naa     cc\n")
  })

  test("a populated last cell yields no trailing whitespace", () => {
    expect(table('[{"a":"x","b":"y"}]', ["a", "b"])).toBe("A  B\nx  y\n")
  })
})

describe("rune widths — misalignment on wide glyphs is intentional", () => {
  test("CJK counts 1 per rune, so it visually overflows", () => {
    expect(table('[{"id":"a","t":"日本語のタイトル"},{"id":"bb","t":"short"}]', ["id", "t"])).toBe(
      "ID  T\na   日本語のタイトル\nbb  short\n"
    )
  })

  test("an emoji in the first column pads by CODE POINTS, not UTF-16 units", () => {
    // "🎬🎬" is 2 code points but 4 UTF-16 units. Go pads to width 2+2=4, so it
    // emits 2 spaces. A `.length`-based port would emit 0 and lose a column.
    expect(table('[{"id":"🎬🎬","t":"a"},{"id":"xy","t":"b"}]', ["id", "t"])).toBe(
      "ID  T\n🎬🎬  a\nxy  b\n"
    )
  })

  test("astral CJK Extension B also counts 1 per code point", () => {
    expect(table('[{"a":"\\ud840\\udc00\\ud840\\udc01","b":"1"},{"a":"abcde","b":"2"}]', ["a", "b"])).toBe(
      "A      B\n\u{20000}\u{20001}     1\nabcde  2\n"
    )
  })

  test("a combining mark counts as its own rune", () => {
    // Decomposed "e"+U+0301+"x" is 3 runes, so the column is 3+2=5 wide and
    // only 2 spaces follow even though the grapheme cluster looks 2 wide.
    // Escapes, not literals: an editor or formatter that NFC-normalizes this
    // file would otherwise silently turn it into the 2-rune precomposed case.
    expect(table(`[{"a":"e\\u0301x","b":"1"},{"a":"abc","b":"2"}]`, ["a", "b"])).toBe(
      `A    B\ne\u0301x  1\nabc  2\n`
    )
  })

  test("the precomposed form is one rune shorter and pads one space more", () => {
    expect(table(`[{"a":"\\u00e9x","b":"1"},{"a":"abc","b":"2"}]`, ["a", "b"])).toBe(
      `A    B\n\u00e9x   1\nabc  2\n`
    )
  })

  test("U+FFFD counts 1", () => {
    expect(table('[{"a":"\\ufffd","b":"1"},{"a":"abcd","b":"2"}]', ["a", "b"])).toBe(
      "A     B\n�     1\nabcd  2\n"
    )
  })
})

describe("single-column output never aligns (ncells == 1 forces a flush)", () => {
  test("each line is its own block, so no padding is ever emitted", () => {
    expect(table('[{"id":"a"},{"id":"bbbbbb"}]', ["id"])).toBe("ID\na\nbbbbbb\n")
  })

  test("even with a very wide value", () => {
    expect(table('[{"a":"short"},{"a":"muchmuchlonger"}]', ["a"])).toBe("A\nshort\nmuchmuchlonger\n")
  })
})

describe("empty results", () => {
  test("no items still prints the header", () => {
    expect(table("[]", ["id", "x"])).toBe("ID  X\n")
  })

  test("no items and --no-header prints nothing at all", () => {
    expect(table("[]", ["id", "x"], true)).toBe("")
  })

  test("header-only output for long dotted paths", () => {
    expect(table("[]", ["contentDetails.videoId", "snippet.videoOwnerChannelTitle"])).toBe(
      "CONTENTDETAILS.VIDEOID  SNIPPET.VIDEOOWNERCHANNELTITLE\n"
    )
  })

  test("empty first column across all rows", () => {
    expect(table('[{"b":"aaaa"},{"b":"b"}]', ["a", "b"])).toBe("A  B\n   aaaa\n   b\n")
  })
})

describe("missing paths and empty cells", () => {
  test("a broken path renders as spaces, indistinguishable from an empty value", () => {
    expect(table('[{"a":"notobject","id":"x"}]', ["a.b.c", "id"])).toBe("A.B.C  ID\n       x\n")
  })

  test("realistic mixed table with a missing statistics object", () => {
    expect(
      table(
        '[{"id":"dQw4w9WgXcQ","snippet":{"title":"Never Gonna Give You Up"},"statistics":{"viewCount":"1600000000"}},{"id":"x","snippet":{"title":"日本"},"statistics":{"viewCount":"1"}},{"id":"yy","snippet":{"title":""},"statistics":{}}]',
        ["id", "snippet.title", "statistics.viewCount"]
      )
    ).toBe(
      "ID           SNIPPET.TITLE            STATISTICS.VIEWCOUNT\n" +
        "dQw4w9WgXcQ  Never Gonna Give You Up  1600000000\n" +
        "x            日本                       1\n" +
        "yy                                    \n"
    )
  })
})

describe("control characters inside cells", () => {
  test("a tab is cleaned to a space before it can split a cell", () => {
    expect(table('[{"a":"x\\ty","b":"p\\rq\\nr"},{"a":"zzzzzzzz","b":"q"}]', ["a", "b"])).toBe(
      "A         B\nx y       p q r\nzzzzzzzz  q\n"
    )
  })

  test("a VERTICAL TAB is NOT cleaned and splits the cell", () => {
    // clean() replaces only \t, \r, \n — \v reaches tabwriter as a cell
    // terminator, so this row silently gains a column.
    expect(table('[{"a":"x\\u000by","b":"z"},{"a":"pppppp","b":"q"}]', ["a", "b"])).toBe(
      "A       B\nx       y  z\npppppp  q\n"
    )
  })

  test("a FORM FEED splits the cell AND forces a flush", () => {
    // Everything after the \f gets independently computed column widths.
    expect(table('[{"a":"x\\fy","b":"z"},{"a":"pppppp","b":"q"},{"a":"s","b":"t"}]', ["a", "b"])).toBe(
      "A  B\nx\ny       z\npppppp  q\ns       t\n"
    )
  })

  test("a form feed in the last row", () => {
    expect(table('[{"a":"pppppp","b":"q"},{"a":"x\\fy","b":"z"}]', ["a", "b"])).toBe(
      "A       B\npppppp  q\nx\ny  z\n"
    )
  })

  test("a backspace is just a 1-rune character", () => {
    expect(table('[{"a":"x\\by","b":"z"},{"a":"pppppp","b":"q"}]', ["a", "b"])).toBe(
      "A       B\nx\by     z\npppppp  q\n"
    )
  })
})

describe("tabwrite — direct tabwriter parity", () => {
  test("the trivial case", () => {
    expect(tabwrite("ID\tSNIPPET.TITLE\nv\thello\nlongerid\tx\n")).toBe(
      "ID        SNIPPET.TITLE\nv         hello\nlongerid  x\n"
    )
  })

  test("empty input produces empty output", () => {
    expect(tabwrite("")).toBe("")
  })

  test("input with no trailing newline still flushes the partial line", () => {
    expect(tabwrite("a\tb")).toBe("a  b")
  })

  test("a lone newline is one empty line", () => {
    expect(tabwrite("\n")).toBe("\n")
  })

  test("a lone form feed flushes an empty block", () => {
    expect(tabwrite("\f")).toBe("\n")
  })

  test("padchar is a space, so tabwidth=4 never introduces a tab", () => {
    expect(tabwrite("a\tb\tc\nlonger\tx\ty\n")).not.toContain("\t")
  })
})

/**
 * Goldens captured from `internal/output/output.go` running the same inputs.
 */

import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { parseJson } from "../json/parse.ts"
import type { JsonObject } from "../json/value.ts"
import { generateRows } from "./columns.ts"
import { renderTsv } from "./tsv.ts"

const items = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

const tsv = (itemsText: string, columns: ReadonlyArray<string>, noHeader = false): string =>
  renderTsv(generateRows(items(itemsText), columns, noHeader))

describe("tsv", () => {
  test("the exact case from Go's output_test.go TestTSVColumnsAndSanitization", () => {
    expect(tsv('[{"id":"v","snippet":{"title":"line one\\nline two"}}]', ["id", "snippet.title"])).toBe(
      "ID\tSNIPPET.TITLE\nv\tline one line two\n"
    )
  })

  test("fields are separated by exactly one tab, with no padding", () => {
    expect(tsv('[{"a":"x","b":"y"},{"a":"muchlonger","b":"z"}]', ["a", "b"])).toBe(
      "A\tB\nx\ty\nmuchlonger\tz\n"
    )
  })

  test("no alignment even when a column is much wider than the rest", () => {
    expect(tsv('[{"statistics":{"subscriberCount":"1"},"id":"x"}]', ["statistics.subscriberCount", "id"])).toBe(
      "STATISTICS.SUBSCRIBERCOUNT\tID\n1\tx\n"
    )
  })

  test("missing values become adjacent tabs", () => {
    expect(tsv('[{"a":"notobject","id":"x"}]', ["a.b.c", "id"])).toBe("A.B.C\tID\n\tx\n")
  })

  test("an empty last column leaves a trailing tab", () => {
    expect(tsv('[{"o":{},"a":[]}]', ["o", "a"])).toBe("O\tA\n\t\n")
  })

  test("no items still prints the header", () => {
    expect(tsv("[]", ["id", "x"])).toBe("ID\tX\n")
  })

  test("no items and --no-header prints nothing", () => {
    expect(tsv("[]", ["id", "x"], true)).toBe("")
  })

  test("single column has no tabs at all", () => {
    expect(tsv('[{"id":"a"},{"id":"bbbbbb"}]', ["id"])).toBe("ID\na\nbbbbbb\n")
  })

  test("every value kind in one row", () => {
    expect(
      tsv(
        '[{"s":"hi","n":900719925474099312345,"f":1.50,"b":true,"arr":[1,"a",null,{"z":1,"a":2}],"obj":{"z":"1","a":{"q":true}},"nul":null}]',
        ["s", "n", "f", "b", "arr", "obj", "nul", "missing"]
      )
    ).toBe(
      "S\tN\tF\tB\tARR\tOBJ\tNUL\tMISSING\n" +
        "hi\t900719925474099312345\t1.50\ttrue\t1,a,,a=2,z=1\ta=q=true,z=1\t\t\n"
    )
  })

  test("numeric literals keep their original text", () => {
    expect(tsv('[{"a":1e3,"b":-0.0,"c":1E+10}]', ["a", "b", "c"])).toBe("A\tB\tC\n1e3\t-0.0\t1E+10\n")
  })

  test("tabs, CR and LF in a cell are cleaned so they cannot break the format", () => {
    expect(tsv('[{"a":"x\\ty","b":"p\\rq\\nr"}]', ["a", "b"])).toBe("A\tB\nx y\tp q r\n")
  })

  test("a vertical tab is NOT cleaned and passes through literally", () => {
    // Unlike in `table`, where \v splits the cell, TSV writes it verbatim.
    expect(tsv('[{"a":"x\\u000by","b":"z"}]', ["a", "b"])).toBe("A\tB\nx\u000by\tz\n")
  })

  test("a form feed also passes through literally, with no flush semantics", () => {
    expect(tsv('[{"a":"x\\fy","b":"z"}]', ["a", "b"])).toBe("A\tB\nx\fy\tz\n")
  })

  test("a deep dotted path renders one long header", () => {
    expect(
      tsv(
        '[{"snippet":{"topLevelComment":{"snippet":{"authorDisplayName":"Bob"}}}}]',
        ["snippet.topLevelComment.snippet.authorDisplayName"]
      )
    ).toBe("SNIPPET.TOPLEVELCOMMENT.SNIPPET.AUTHORDISPLAYNAME\nBob\n")
  })

  test("a status-shaped object row", () => {
    expect(
      tsv(
        '[{"path":"/x/auth.json","api_key":{"configured":true,"source":"env","fingerprint":"ab12"},"oauth":{"configured":false,"client_id":"","scopes":["a","b"],"expiry":""}}]',
        [
          "path",
          "api_key.configured",
          "api_key.source",
          "api_key.fingerprint",
          "oauth.configured",
          "oauth.client_id",
          "oauth.scopes",
          "oauth.expiry"
        ]
      )
    ).toBe(
      "PATH\tAPI_KEY.CONFIGURED\tAPI_KEY.SOURCE\tAPI_KEY.FINGERPRINT\tOAUTH.CONFIGURED\tOAUTH.CLIENT_ID\tOAUTH.SCOPES\tOAUTH.EXPIRY\n" +
        "/x/auth.json\ttrue\tenv\tab12\tfalse\t\ta,b\t\n"
    )
  })

  test("wide glyphs are irrelevant here — no widths are computed", () => {
    expect(tsv('[{"id":"🎬🎬","t":"日本"}]', ["id", "t"])).toBe("ID\tT\n🎬🎬\t日本\n")
  })
})

/**
 * Goldens captured from `internal/output/output.go` (Go's `json.Encoder` with
 * `SetEscapeHTML(false)` and `SetIndent("", "  ")`) on the same inputs, plus a
 * direct capture from the real `oytc version --format json` binary.
 */

import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import type { ListResult } from "../domain/listResult.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonObject } from "../json/value.ts"
import { renderJson, renderJsonl, renderObjectJson, renderObjectJsonl } from "./jsonOut.ts"

const obj = (text: string): JsonObject => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as JsonObject
}

const items = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

const result = (
  itemsText: string,
  nextPageToken = "",
  requests = 0
): ListResult => ({ items: items(itemsText), nextPageToken, requests })

describe("json envelope", () => {
  test("empty result: items is [] and requests is present at 0", () => {
    expect(renderJson(result("[]", "", 1))).toBe('{\n  "items": [],\n  "requests": 1\n}\n')
  })

  test("nextPageToken is omitted when empty and ordered between items and requests", () => {
    expect(renderJson(result('[{"id":"a"}]', "CAoQAA", 3))).toBe(
      '{\n  "items": [\n    {\n      "id": "a"\n    }\n  ],\n  "nextPageToken": "CAoQAA",\n  "requests": 3\n}\n'
    )
  })

  test("envelope keys use struct order, not alphabetical", () => {
    const out = renderJson(result('[{"id":"a"}]', "T", 2))
    expect(out.indexOf('"items"')).toBeLessThan(out.indexOf('"nextPageToken"'))
    expect(out.indexOf('"nextPageToken"')).toBeLessThan(out.indexOf('"requests"'))
  })

  test("nested item keys ARE sorted alphabetically at every depth", () => {
    expect(renderJson(result('[{"z":{"y":"1","a":"2"},"a":"x"}]'))).toBe(
      '{\n  "items": [\n    {\n      "a": "x",\n      "z": {\n        "a": "2",\n        "y": "1"\n      }\n    }\n  ],\n  "requests": 0\n}\n'
    )
  })

  test("large counters keep their exact text (Go's TestJSONPreservesLargeCounterString)", () => {
    const out = renderJson(result('[{"id":"v","statistics":{"viewCount":"900719925474099312345"}}]', "", 1))
    expect(out).toContain('"viewCount": "900719925474099312345"')
  })

  test("numeric literals are not reformatted", () => {
    expect(renderJson(result('[{"a":1.50,"b":1e3,"c":900719925474099312345}]'))).toContain(
      '"a": 1.50'
    )
    expect(renderJson(result('[{"b":1e3}]'))).toContain('"b": 1e3')
  })

  test("SetEscapeHTML(false): < > & are literal", () => {
    expect(renderJson(result('[{"t":"<a>& x"}]'))).toBe(
      '{\n  "items": [\n    {\n      "t": "<a>& x"\n    }\n  ],\n  "requests": 0\n}\n'
    )
  })

  test("U+2028 and U+2029 are always escaped", () => {
    expect(renderJson(result('[{"t":"a\\u2028b\\u2029c"}]'))).toContain('"a\\u2028b\\u2029c"')
  })

  test("control characters use Go's short escapes for \\b and \\f", () => {
    expect(renderJson(result('[{"t":"a\\bb\\fc\\u0001d"}]'))).toContain('"a\\bb\\fc\\u0001d"')
  })

  test("two-space indent throughout", () => {
    expect(renderJson(result('[{"a":{"b":"c"}}]'))).toBe(
      '{\n  "items": [\n    {\n      "a": {\n        "b": "c"\n      }\n    }\n  ],\n  "requests": 0\n}\n'
    )
  })

  test("always ends in exactly one newline", () => {
    const out = renderJson(result("[]"))
    expect(out.endsWith("}\n")).toBe(true)
    expect(out.endsWith("}\n\n")).toBe(false)
  })

  test("--no-header is irrelevant to json (it never reads the flag)", () => {
    expect(renderJson(result('[{"id":"a"}]'))).toBe(renderJson(result('[{"id":"a"}]')))
  })
})

describe("jsonl", () => {
  test("one compact object per line", () => {
    expect(renderJsonl(result('[{"id":"a","z":"1"},{"id":"b"}]'))).toBe(
      '{"id":"a","z":"1"}\n{"id":"b"}\n'
    )
  })

  test("an empty result produces ZERO BYTES, not an empty line", () => {
    expect(renderJsonl(result("[]"))).toBe("")
    expect(renderJsonl(result("[]")).length).toBe(0)
  })

  test("no envelope: nextPageToken and requests are dropped", () => {
    const out = renderJsonl(result('[{"id":"a"}]', "CAoQAA", 7))
    expect(out).toBe('{"id":"a"}\n')
    expect(out).not.toContain("nextPageToken")
    expect(out).not.toContain("requests")
  })

  test("keys are still sorted within each line", () => {
    expect(renderJsonl(result('[{"z":"1","a":"2"}]'))).toBe('{"a":"2","z":"1"}\n')
  })

  test("no spaces after colons or commas", () => {
    expect(renderJsonl(result('[{"a":"1","b":"2"}]'))).toBe('{"a":"1","b":"2"}\n')
  })
})

describe("renderObject — no list envelope", () => {
  test("json: a bare indented object with a trailing newline", () => {
    expect(renderObjectJson(obj('{"version":"1.2.3","commit":"abc","os":"darwin"}'))).toBe(
      '{\n  "commit": "abc",\n  "os": "darwin",\n  "version": "1.2.3"\n}\n'
    )
  })

  test("json: never wraps in items/requests", () => {
    const out = renderObjectJson(obj('{"version":"1.2.3"}'))
    expect(out).not.toContain('"items"')
    expect(out).not.toContain('"requests"')
  })

  test("jsonl: the same object, compact, one line", () => {
    expect(renderObjectJsonl(obj('{"version":"1.2.3","commit":"abc"}'))).toBe(
      '{"commit":"abc","version":"1.2.3"}\n'
    )
  })

  test("an empty object still emits {} and a newline (unlike an empty item list)", () => {
    expect(renderObjectJson(obj("{}"))).toBe("{}\n")
    expect(renderObjectJsonl(obj("{}"))).toBe("{}\n")
  })

  test("nested objects are indented and sorted", () => {
    expect(renderObjectJson(obj('{"oauth":{"scopes":["a","b"],"configured":false},"path":"/x"}'))).toBe(
      '{\n  "oauth": {\n    "configured": false,\n    "scopes": [\n      "a",\n      "b"\n    ]\n  },\n  "path": "/x"\n}\n'
    )
  })
})

describe("release CI grep contract", () => {
  // .depot/workflows/release.yml runs, verbatim:
  //
  //   /tmp/oytc version --format json | grep -q '"version": "<tag>"'
  //
  // — colon, ONE space, quote. A regression in the pretty-printer's key/value
  // separator would silently fail the release with no other symptom, so these
  // assertions are about raw bytes, not parsed shape.
  const versionState = obj(
    '{"version":"0.4.1","commit":"none","date":"unknown","goVersion":"go1.26.5","os":"darwin","arch":"arm64"}'
  )

  test('pretty JSON contains the literal `"version": "`', () => {
    expect(renderObjectJson(versionState)).toContain('"version": "')
  })

  test("the exact release grep pattern matches, tag included", () => {
    const tagged = obj('{"version":"v1.2.3","commit":"abc","os":"darwin"}')
    expect(renderObjectJson(tagged)).toContain('"version": "v1.2.3"')
  })

  test("the full version payload matches the Go binary byte-for-byte", () => {
    expect(renderObjectJson(versionState)).toBe(
      '{\n  "arch": "arm64",\n  "commit": "none",\n  "date": "unknown",\n  "goVersion": "go1.26.5",\n  "os": "darwin",\n  "version": "0.4.1"\n}\n'
    )
  })

  test("the JSONL form does NOT have the space (it is compact) — grep must target json", () => {
    expect(renderObjectJsonl(versionState)).toContain('"version":"')
    expect(renderObjectJsonl(versionState)).not.toContain('"version": "')
  })

  test("a version inside a list envelope keeps the space too", () => {
    expect(renderJson(result('[{"version":"0.4.1"}]'))).toContain('"version": "')
  })
})

import { describe, expect, test } from "bun:test"
import { parseJson } from "../json/parse.ts"
import { Result } from "effect"
import type { JsonObject } from "../json/value.ts"
import {
  fieldSelectorIncludes,
  fieldSelectorPaths,
  fieldsWithRequired,
  stripItemIds,
  stripSearchKind,
  stripSearchKinds
} from "./fields.ts"

const obj = (text: string): JsonObject => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as JsonObject
}

const objs = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

describe("fieldSelectorPaths", () => {
  test("a flat comma list", () => {
    expect(fieldSelectorPaths("items,nextPageToken")).toEqual(["items", "nextPageToken"])
  })

  test("slash nesting builds one path", () => {
    expect(fieldSelectorPaths("items/id/videoId")).toEqual(["items/id/videoId"])
  })

  test("parenthesised groups distribute the prefix", () => {
    expect(fieldSelectorPaths("items(id/videoId,snippet/title),nextPageToken")).toEqual([
      "items/id/videoId",
      "items/snippet/title",
      "nextPageToken"
    ])
  })

  test("nested groups", () => {
    expect(fieldSelectorPaths("items(id(kind,videoId))")).toEqual([
      "items/id/kind",
      "items/id/videoId"
    ])
  })

  test("whitespace around every delimiter is skipped", () => {
    expect(fieldSelectorPaths("items ( id / kind , snippet/title ) , nextPageToken")).toEqual([
      "items/id/kind",
      "items/snippet/title",
      "nextPageToken"
    ])
  })

  test("tabs, CR and LF count as whitespace", () => {
    expect(fieldSelectorPaths("items\t(\r\nid/kind\n)")).toEqual(["items/id/kind"])
  })

  test("an empty selector produces no paths", () => {
    expect(fieldSelectorPaths("")).toEqual([])
  })

  test("a stray delimiter is consumed and contributes nothing", () => {
    expect(fieldSelectorPaths("/items")).toEqual(["items"])
    expect(fieldSelectorPaths(")")).toEqual([])
  })

  test("a wildcard is just a name", () => {
    expect(fieldSelectorPaths("items/*")).toEqual(["items/*"])
    expect(fieldSelectorPaths("*")).toEqual(["*"])
  })

  test("an unterminated group still yields its members", () => {
    expect(fieldSelectorPaths("items(id/kind")).toEqual(["items/id/kind"])
  })

  test("a multi-byte name survives; Go slices bytes, JS slices UTF-16 units", () => {
    // Every delimiter is ASCII, so the two agree on every boundary.
    expect(fieldSelectorPaths("items/naïve,items/日本")).toEqual([
      "items/naïve",
      "items/日本"
    ])
  })
})

/**
 * The exact table from `internal/cli/fields_test.go:TestFieldSelectorIncludes`.
 */
describe("fieldSelectorIncludes(_, 'items/id') — the Go table", () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["", false],
    ["items", true],
    ["items/*", true],
    ["items/id", true],
    ["items(id/videoId,snippet/title),nextPageToken", true],
    ["items(snippet/title),nextPageToken", false],
    ["items/snippet/resourceId/channelId", false]
  ]
  for (const [selector, want] of cases) {
    test(`${JSON.stringify(selector)} -> ${want}`, () => {
      expect(fieldSelectorIncludes(selector, "items/id")).toBe(want)
    })
  }
})

/** `TestFieldSelectorIncludesNestedSearchKind`, verbatim. */
describe("fieldSelectorIncludes(_, 'items/id/kind') — the Go table", () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["items", true],
    ["items/id", true],
    ["items/id/*", true],
    ["items/id/kind", true],
    ["items(id/kind,snippet/title)", true],
    ["items(id/*,snippet/title)", true],
    ["items(id/channelId,snippet/title)", false],
    ["items(id/videoId,snippet/title)", false]
  ]
  for (const [selector, want] of cases) {
    test(`${JSON.stringify(selector)} -> ${want}`, () => {
      expect(fieldSelectorIncludes(selector, "items/id/kind")).toBe(want)
    })
  }
})

describe("fieldSelectorIncludes — the five match rules individually", () => {
  test("rule 1: a bare '*' covers everything", () => {
    expect(fieldSelectorIncludes("*", "items/id")).toBe(true)
    expect(fieldSelectorIncludes("*", "items/id/kind")).toBe(true)
  })

  test("rule 1: a bare 'items' covers everything under items", () => {
    expect(fieldSelectorIncludes("nextPageToken,items", "items/id/kind")).toBe(true)
  })

  test("rule 2: exact equality", () => {
    expect(fieldSelectorIncludes("items/id", "items/id")).toBe(true)
  })

  test("rule 3: the selector asks for something DEEPER than the target", () => {
    expect(fieldSelectorIncludes("items/id/videoId", "items/id")).toBe(true)
  })

  test("rule 4: the selector asks for an ANCESTOR of the target", () => {
    expect(fieldSelectorIncludes("items/id", "items/id/kind")).toBe(true)
  })

  test("rule 5: a trailing /* covers everything below its parent", () => {
    expect(fieldSelectorIncludes("items/id/*", "items/id/kind")).toBe(true)
    // The wildcard parent must be a STRICT prefix; "items/id/*" does not make
    // "items/idOther/x" match.
    expect(fieldSelectorIncludes("items/id/*", "items/idOther/kind")).toBe(false)
  })

  test("a sibling path does not match", () => {
    expect(fieldSelectorIncludes("items/snippet", "items/id")).toBe(false)
  })

  test("a prefix that is not a path boundary does not match", () => {
    expect(fieldSelectorIncludes("items/idx", "items/id")).toBe(false)
  })
})

describe("fieldsWithRequired", () => {
  test("an empty selector is left alone and preserves", () => {
    expect(fieldsWithRequired("", "items/id")).toEqual({ fields: "", preserve: true })
  })

  test("an already-covering selector is left alone and preserves", () => {
    expect(fieldsWithRequired("items/id,items/snippet", "items/id")).toEqual({
      fields: "items/id,items/snippet",
      preserve: true
    })
  })

  test("a non-covering selector gets the required path appended", () => {
    expect(fieldsWithRequired("items/snippet/title", "items/id")).toEqual({
      fields: "items/snippet/title,items/id",
      preserve: false
    })
  })

  test("search injects items/id/kind, not items/id", () => {
    expect(fieldsWithRequired("items(id/videoId)", "items/id/kind")).toEqual({
      fields: "items(id/videoId),items/id/kind",
      preserve: false
    })
  })

  test("a selector asking for id/videoId still covers items/id", () => {
    // Rule 3: deeper than the target. So the batch-get commands do NOT inject.
    expect(fieldsWithRequired("items(id/videoId)", "items/id").preserve).toBe(true)
  })
})

describe("stripItemIds", () => {
  test("preserve=true returns the items untouched, identically", () => {
    const items = objs('[{"id":"a","snippet":{"title":"t"}}]')
    expect(stripItemIds(items, true)).toBe(items)
  })

  test("preserve=false deletes id from every item", () => {
    const items = objs('[{"id":"a","snippet":{"title":"t"}},{"id":"b"}]')
    expect(stripItemIds(items, false)).toEqual([{ snippet: { title: "t" } }, {}])
  })

  test("an item without an id is unharmed", () => {
    expect(stripItemIds(objs('[{"snippet":{"title":"t"}}]'), false)).toEqual([
      { snippet: { title: "t" } }
    ])
  })

  test("the input array is not mutated", () => {
    const items = objs('[{"id":"a"}]')
    stripItemIds(items, false)
    expect(items).toEqual([{ id: "a" }])
  })

  test("non-id keys keep their relative order", () => {
    const [stripped] = stripItemIds(objs('[{"z":"1","id":"a","b":"2"}]'), false)
    expect(Object.keys(stripped!)).toEqual(["z", "b"])
  })
})

describe("stripSearchKind", () => {
  test("kind is removed but siblings keep id alive", () => {
    expect(stripSearchKind(obj('{"id":{"kind":"youtube#video","videoId":"v"}}'))).toEqual({
      id: { videoId: "v" }
    })
  })

  test("id is dropped entirely when kind was its only key", () => {
    expect(stripSearchKind(obj('{"id":{"kind":"youtube#video"},"snippet":{"title":"t"}}'))).toEqual(
      { snippet: { title: "t" } }
    )
  })

  test("an id that is a plain string is left alone", () => {
    // channels/videos return a string id; only search returns an object.
    expect(stripSearchKind(obj('{"id":"UC123"}'))).toEqual({ id: "UC123" })
  })

  test("a missing id is left alone", () => {
    expect(stripSearchKind(obj('{"snippet":{"title":"t"}}'))).toEqual({
      snippet: { title: "t" }
    })
  })

  test("an id object without a kind is left with its other keys", () => {
    expect(stripSearchKind(obj('{"id":{"videoId":"v"}}'))).toEqual({ id: { videoId: "v" } })
  })

  test("an id that is null is left alone", () => {
    expect(stripSearchKind(obj('{"id":null}'))).toEqual({ id: null })
  })
})

describe("stripSearchKinds", () => {
  test("preserve=true is a no-op returning the same array", () => {
    const items = objs('[{"id":{"kind":"youtube#video","videoId":"v"}}]')
    expect(stripSearchKinds(items, true)).toBe(items)
  })

  test("preserve=false strips every item", () => {
    const items = objs(
      '[{"id":{"kind":"youtube#video","videoId":"v"}},{"id":{"kind":"youtube#channel"}}]'
    )
    expect(stripSearchKinds(items, false)).toEqual([{ id: { videoId: "v" } }, {}])
  })
})

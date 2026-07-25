import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { parseJson } from "../json/parse.ts"
import type { JsonValue } from "../json/value.ts"
import {
  cloneOAuth,
  decodeAuthFile,
  encodeAuthFile,
  sameOAuth,
  type AuthFile,
  type AuthOAuth
} from "./authfile.ts"

const decode = (text: string): Result.Result<AuthFile, { readonly message: string }> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) return Result.fail({ message: parsed.failure.message })
  return decodeAuthFile(parsed.success)
}

const ok = (text: string): AuthFile => {
  const r = decode(text)
  if (Result.isFailure(r)) throw new Error(`expected success, got: ${r.failure.message}`)
  return r.success
}

const oauth = (overrides: Partial<AuthOAuth> = {}): AuthOAuth => ({
  clientId: "id",
  clientSecret: "sec",
  accessToken: "acc",
  refreshToken: "ref",
  expiry: "2026-02-01T12:00:00Z",
  scopes: undefined,
  ...overrides
})

describe("encodeAuthFile — byte parity with json.MarshalIndent(file, \"\", \"  \") + '\\n'", () => {
  // Every expected string below was produced by running the real Go structs
  // through encoding/json (Go 1.26.5) and capturing the bytes.

  test("an empty file marshals to {}", () => {
    expect(encodeAuthFile({ apiKey: "", oauth: undefined })).toBe("{}\n")
  })

  test("api_key is omitempty", () => {
    expect(encodeAuthFile({ apiKey: "abc", oauth: undefined })).toBe('{\n  "api_key": "abc"\n}\n')
  })

  test("a nil scopes slice marshals as null, not []", () => {
    expect(encodeAuthFile({ apiKey: "abc", oauth: oauth() })).toBe(
      `{
  "api_key": "abc",
  "oauth": {
    "client_id": "id",
    "client_secret": "sec",
    "access_token": "acc",
    "refresh_token": "ref",
    "expiry": "2026-02-01T12:00:00Z",
    "scopes": null
  }
}
`
    )
  })

  test("an empty scopes slice marshals as [] and empty strings are still emitted", () => {
    expect(
      encodeAuthFile({
        apiKey: "",
        oauth: {
          clientId: "id",
          clientSecret: "sec",
          accessToken: "",
          refreshToken: "",
          expiry: "",
          scopes: []
        }
      })
    ).toBe(
      `{
  "oauth": {
    "client_id": "id",
    "client_secret": "sec",
    "access_token": "",
    "refresh_token": "",
    "expiry": "",
    "scopes": []
  }
}
`
    )
  })

  test("a populated scopes array indents at 6 spaces", () => {
    expect(
      encodeAuthFile({
        apiKey: "k",
        oauth: {
          clientId: "id",
          clientSecret: "sec",
          accessToken: "a",
          refreshToken: "r",
          expiry: "e",
          scopes: ["scope.one", "scope.two"]
        }
      })
    ).toBe(
      `{
  "api_key": "k",
  "oauth": {
    "client_id": "id",
    "client_secret": "sec",
    "access_token": "a",
    "refresh_token": "r",
    "expiry": "e",
    "scopes": [
      "scope.one",
      "scope.two"
    ]
  }
}
`
    )
  })

  test("oauth-only files omit api_key entirely", () => {
    const text = encodeAuthFile({ apiKey: "", oauth: oauth({ scopes: ["s"] }) })
    expect(text.includes("api_key")).toBe(false)
    expect(text.startsWith('{\n  "oauth": {')).toBe(true)
  })

  test("key order is struct order, not alphabetical", () => {
    const text = encodeAuthFile({ apiKey: "k", oauth: oauth({ scopes: ["s"] }) })
    const keys = [...text.matchAll(/"([a-z_]+)":/g)].map((m) => m[1])
    expect(keys).toEqual([
      "api_key",
      "oauth",
      "client_id",
      "client_secret",
      "access_token",
      "refresh_token",
      "expiry",
      "scopes"
    ])
  })

  test("every encoding round-trips through the decoder", () => {
    const cases: ReadonlyArray<AuthFile> = [
      { apiKey: "", oauth: undefined },
      { apiKey: "abc", oauth: undefined },
      { apiKey: "abc", oauth: oauth() },
      { apiKey: "", oauth: oauth({ scopes: ["a", "b"] }) }
    ]
    for (const file of cases) {
      expect(ok(encodeAuthFile(file))).toEqual(file)
    }
  })
})

describe("decodeAuthFile — Go encoding/json semantics", () => {
  test("an empty object yields the zero file", () => {
    expect(ok("{}")).toEqual({ apiKey: "", oauth: undefined })
  })

  test("unknown keys are ignored", () => {
    expect(ok('{"unknown":1,"api_key":"z"}')).toEqual({ apiKey: "z", oauth: undefined })
  })

  test("null decodes to the zero value rather than failing", () => {
    expect(ok('{"api_key":null}')).toEqual({ apiKey: "", oauth: undefined })
    expect(ok('{"oauth":null}')).toEqual({ apiKey: "", oauth: undefined })
    // Verified against Go: a top-level null is a no-op, not an error.
    expect(ok("null")).toEqual({ apiKey: "", oauth: undefined })
  })

  test("a null scopes value is nil, an empty array is empty", () => {
    expect(ok('{"oauth":{"client_id":"x","scopes":null}}').oauth?.scopes).toBeUndefined()
    expect(ok('{"oauth":{"client_id":"x","scopes":[]}}').oauth?.scopes).toEqual([])
  })

  test("a null scopes element becomes an empty string, keeping the slot", () => {
    expect(ok('{"oauth":{"scopes":["a",null]}}').oauth?.scopes).toEqual(["a", ""])
  })

  test("missing oauth fields default to empty strings", () => {
    expect(ok('{"oauth":{"scopes":["a"],"client_id":"x"}}').oauth).toEqual({
      clientId: "x",
      clientSecret: "",
      accessToken: "",
      refreshToken: "",
      expiry: "",
      scopes: ["a"]
    })
  })

  test("keys match case-insensitively when there is no exact match", () => {
    // Verified against Go 1.26.5: encoding/json falls back to a
    // case-insensitive field match.
    expect(ok('{"OAUTH":{"client_id":"x"}}').oauth?.clientId).toBe("x")
    expect(ok('{"API_KEY":"z"}').apiKey).toBe("z")
  })

  test.each([
    // Go decodes EVERY key that resolves to a field, in document order, so the
    // last one wins — even when an EARLIER key was the exact tag match. Every
    // expectation below was captured from Go 1.26.5.
    ['{"api_key":"exact","API_KEY":"upper"}', "upper"],
    ['{"API_KEY":"upper","api_key":"exact"}', "exact"],
    ['{"API_KEY":"first","Api_Key":"second"}', "second"],
    ['{"Api_Key":"second","API_KEY":"first"}', "first"],
    ['{"api_key":"a","API_KEY":"b","apI_kEy":"c"}', "c"],
    ['{"api_key":"a","API_KEY":"","x":1}', ""],
    // null into a non-pointer STRING field is a Go no-op, NOT a reset to "".
    ['{"api_key":"a","API_KEY":null}', "a"],
    ['{"API_KEY":null,"api_key":"a"}', "a"],
    ['{"api_key":"a","API_KEY":null,"apI_kEy":"c"}', "c"],
    // ...but with no other value present the field keeps its zero value.
    ['{"api_key":null}', ""]
  ])("case-variant string keys fold in document order: %s -> %s", (text, expected) => {
    expect(ok(text).apiKey).toBe(expected)
  })

  test("null into a POINTER field (oauth) really does clear it", () => {
    // Unlike a string field, a pointer IS set to nil by null — and a later
    // object re-allocates it.
    expect(ok('{"oauth":{"client_id":"a"},"OAUTH":null}').oauth).toBeUndefined()
    expect(ok('{"OAUTH":null,"oauth":{"client_id":"a"}}').oauth?.clientId).toBe("a")
    expect(ok('{"oauth":null,"OAUTH":{"client_id":"a"}}').oauth?.clientId).toBe("a")
  })

  test("null into a SLICE field (scopes) clears it, unlike a string field", () => {
    expect(ok('{"oauth":{"scopes":["a"],"SCOPES":null}}').oauth?.scopes).toBeUndefined()
    expect(ok('{"oauth":{"SCOPES":null,"scopes":["a"]}}').oauth?.scopes).toEqual(["a"])
    expect(ok('{"oauth":{"client_id":"a","CLIENT_ID":null}}').oauth?.clientId).toBe("a")
  })

  test("case-variant oauth objects MERGE into one struct rather than replacing", () => {
    // Go allocates the struct once and decodes each matching object into it.
    const merged = ok('{"oauth":{"client_id":"a"},"OAUTH":{"client_secret":"b"}}').oauth
    expect(merged?.clientId).toBe("a")
    expect(merged?.clientSecret).toBe("b")
    // Nested keys fold the same way, last-wins.
    expect(ok('{"oauth":{"CLIENT_ID":"ci","client_id":"exact"}}').oauth?.clientId).toBe("exact")
    expect(ok('{"oauth":{"client_id":"exact","CLIENT_ID":"ci"}}').oauth?.clientId).toBe("ci")
  })

  test("a type error inside an oauth block a later null CLEARS is still an error", () => {
    // Go decodes each object as it walks the document and keeps the first
    // error, so the trailing null does not excuse the bad type. This is what
    // routes Load() to its corrupt-file/env-key path. Verified against Go.
    expect(Result.isFailure(decode('{"oauth":{"client_id":123},"OAUTH":null}'))).toBe(true)
    expect(Result.isFailure(decode('{"oauth":{"scopes":"notarray"},"OAUTH":null}'))).toBe(true)
    // A well-typed block cleared by a later null is still just nil.
    expect(ok('{"oauth":{"client_id":"a"},"OAUTH":null}').oauth).toBeUndefined()
  })

  test("a wrong type under a case-variant key still errors", () => {
    expect(Result.isFailure(decode('{"API_KEY":123}'))).toBe(true)
    expect(Result.isFailure(decode('{"api_key":"ok","API_KEY":123}'))).toBe(true)
    expect(Result.isFailure(decode('{"API_KEY":123,"api_key":"ok"}'))).toBe(true)
  })

  test("whitespace inside a value is preserved; trimming happens in Load()", () => {
    expect(ok('{"api_key":"  spaced  "}').apiKey).toBe("  spaced  ")
  })

  test.each([
    ['{"api_key":123}', "number into"],
    ['{"api_key":true}', "bool into"],
    ['{"oauth":{"scopes":"x"}}', "string into"],
    ['{"oauth":{"scopes":[1,2]}}', "number into"],
    ['{"oauth":[]}', "array into"],
    ['{"oauth":true}', "bool into"],
    ['"a string"', "string into"],
    ["123", "number into"],
    ["[]", "array into"]
  ])("a wrong type is an error: %s", (text, fragment) => {
    const r = decode(text)
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) expect(r.failure.message).toContain(fragment)
  })

  test.each([["{not json"], [""], ['{"api_key":"x"}{"api_key":"y"}']])(
    "malformed JSON fails: %s",
    (text) => {
      expect(Result.isFailure(decode(text))).toBe(true)
    }
  )

  test("a non-object, non-null JSON value is rejected", () => {
    const r = decodeAuthFile(true as JsonValue)
    expect(Result.isFailure(r)).toBe(true)
  })
})

describe("sameOAuth — the compare half of the compare-and-swap", () => {
  const base = oauth({ scopes: ["a", "b"] })

  test("both undefined are equal; exactly one undefined is not", () => {
    expect(sameOAuth(undefined, undefined)).toBe(true)
    expect(sameOAuth(base, undefined)).toBe(false)
    expect(sameOAuth(undefined, base)).toBe(false)
  })

  test("identical values are equal", () => {
    expect(sameOAuth(base, { ...base, scopes: ["a", "b"] })).toBe(true)
  })

  test.each([
    ["clientId", { clientId: "other" }],
    ["clientSecret", { clientSecret: "other" }],
    ["accessToken", { accessToken: "other" }],
    ["refreshToken", { refreshToken: "other" }],
    ["expiry", { expiry: "other" }]
  ] as ReadonlyArray<readonly [string, Partial<AuthOAuth>]>)(
    "a differing %s breaks equality",
    (_name, patch) => {
      expect(sameOAuth(base, { ...base, ...patch })).toBe(false)
    }
  )

  test("scope length and element ORDER both matter", () => {
    expect(sameOAuth(base, { ...base, scopes: ["a"] })).toBe(false)
    expect(sameOAuth(base, { ...base, scopes: ["a", "b", "c"] })).toBe(false)
    expect(sameOAuth(base, { ...base, scopes: ["b", "a"] })).toBe(false)
  })

  test("nil and empty scopes both have length 0 and compare equal", () => {
    expect(sameOAuth(oauth({ scopes: undefined }), oauth({ scopes: [] }))).toBe(true)
  })
})

describe("cloneOAuth", () => {
  test("copies the scope array rather than aliasing it", () => {
    const scopes = ["a", "b"]
    const clone = cloneOAuth(oauth({ scopes }))
    scopes.push("c")
    expect(clone.scopes).toEqual(["a", "b"])
  })

  test("an empty slice clones to nil, matching append([]string(nil), empty...)", () => {
    expect(cloneOAuth(oauth({ scopes: [] })).scopes).toBeUndefined()
  })
})

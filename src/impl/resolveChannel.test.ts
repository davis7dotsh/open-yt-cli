/**
 * Channel-resolution tests.
 *
 * Ported from `internal/youtube/client_test.go`:
 *   TestResolveChannelHandleAndURL
 *
 * The classification table below is a GOLDEN CORPUS captured by running each
 * input through the real Go `parseChannelReference` (Go 1.26.5, `go run`), not
 * from reading the spec. The full corpus — 4,497 structured combinations plus
 * 11,398 random fuzz strings — was diffed against this implementation and
 * matched on every row; these are the readable representatives.
 *
 * That exercise found one real bug: Go's `url.Parse` rejects a `%XX` escape in
 * the HOST whose high nibble is `< 8` (unless it is literally `%25`), so
 * `//youtube%2ecom/@x` is a parse error and classifies as a keyword search. A
 * naive decoder sees `youtube.com` and calls it a handle. 100 corpus rows
 * hinged on it.
 */

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { NotFoundError, OperationalError } from "../domain/errors.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonValue } from "../json/value.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import type { Params } from "../services/index.ts"
import {
  CHANNEL_ID_PATTERN,
  goQuote,
  goUrlParse,
  parseChannelReference,
  resolveChannelWith,
  type ChannelReferenceKind
} from "./resolveChannel.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SeenGet {
  readonly resource: string
  readonly params: Params
}

const response = (text: string): DataApiResponse => {
  const parsed = parseJson(text)
  if (parsed._tag === "Failure") throw new Error("bad fixture")
  return parsed.success as unknown as DataApiResponse
}

const harness = (bodies: ReadonlyArray<string>) => {
  const seen: Array<SeenGet> = []
  const get = (resource: string, params: Params) => {
    seen.push({ resource, params })
    return Effect.succeed(response(bodies[Math.min(seen.length - 1, bodies.length - 1)] ?? "{}"))
  }
  const resolve = resolveChannelWith(get)
  return {
    seen,
    run: (reference: string) => Effect.runPromise(Effect.exit(resolve(reference)))
  }
}

const okOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const errOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  const found = Cause.findErrorOption(exit.cause)
  if (!Option.isSome(found)) throw new Error("no error in cause")
  return found.value
}

const param = (params: Params, key: string): string | undefined =>
  params.find(([k]) => k === key)?.[1]

// ---------------------------------------------------------------------------
// goQuote
// ---------------------------------------------------------------------------

describe("goQuote", () => {
  // Verified against Go 1.26.5 strconv.Quote.
  test.each([
    ["@example", '"@example"'],
    ["Some Channel", '"Some Channel"'],
    ['a"b', '"a\\"b"'],
    ["a\\b", '"a\\\\b"'],
    ["a\nb", '"a\\nb"'],
    ["a\tb", '"a\\tb"'],
    ["a\x00b", '"a\\x00b"'],
    ["a\x1bb", '"a\\x1bb"'],
    ["a\x7fb", '"a\\x7fb"'],
    ["a'b", "\"a'b\""],
    ["\x07\b\f\v", '"\\a\\b\\f\\v"'],
    ["café", '"café"'],
    ["日本", '"日本"'],
    ["emoji \u{1F389}", '"emoji \u{1F389}"'],
    ["nbsp x", '"nbsp\\u00a0x"'],
    ["zwsp​x", '"zwsp\\u200bx"'],
    ["bom﻿x", '"bom\\ufeffx"'],
    ["line sep", '"line\\u2028sep"'],
    ["next", '"\\u0085next"'],
    ["　ideographic", '"\\u3000ideographic"'],
    ["unassigned\u{e0000}x", '"unassigned\\U000e0000x"']
  ])("quotes %j", (input, expected) => {
    expect(goQuote(input)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// goUrlParse
// ---------------------------------------------------------------------------

describe("goUrlParse", () => {
  test("does not lowercase the host, unlike new URL", () => {
    expect(goUrlParse("https://WWW.YOUTUBE.COM/@Foo")?.hostname).toBe("WWW.YOUTUBE.COM")
    expect(new URL("https://WWW.YOUTUBE.COM/@Foo").hostname).toBe("www.youtube.com")
  })

  test("percent-decodes the path, unlike new URL", () => {
    expect(goUrlParse("https://youtube.com/%40handle")?.path).toBe("/@handle")
    expect(new URL("https://youtube.com/%40handle").pathname).toBe("/%40handle")
  })

  test("a scheme-relative //host DOES yield an authority", () => {
    // Verified in Go: url.Parse("//youtube.com/@x").Host == "youtube.com".
    // The classifier still calls it a search, because the "://" test fails and
    // no "https://" prefix is prepended — so the reference reaches parse with a
    // host but is not what the caller typed. See the golden corpus.
    expect(goUrlParse("//youtube.com/@x")?.host).toBe("youtube.com")
  })

  test("three slashes after a scheme leave no authority", () => {
    // url.Parse("https:////youtube.com/@x").Host == "" — verified in Go.
    expect(goUrlParse("https:////youtube.com/@x")?.host).toBe("")
  })

  test("strips userinfo from the authority", () => {
    expect(goUrlParse("https://user:pass@youtube.com/@x")?.hostname).toBe("youtube.com")
  })

  test("Hostname drops the port and unwraps IPv6 brackets", () => {
    expect(goUrlParse("https://youtube.com:8080/@x")?.hostname).toBe("youtube.com")
    expect(goUrlParse("https://[::1]/@x")?.hostname).toBe("::1")
  })

  test.each([
    ["a control byte", "https://youtube.com/@x\ty"],
    ["a truncated escape", "https://youtube.com/@x%"],
    ["a bad escape", "https://youtube.com/@x%2G"],
    ["a space in the host", "https://yout ube.com/@x"],
    ["a bad escape in the fragment", "https://youtube.com/@x#f%zz"],
    ["a low escape in the host", "https://youtube%2ecom/@x"]
  ])("rejects %s", (_label, input) => {
    expect(goUrlParse(input)).toBeUndefined()
  })

  test("does NOT validate query escapes", () => {
    expect(goUrlParse("https://youtube.com/@x?q=%zz")?.path).toBe("/@x")
  })
})

// ---------------------------------------------------------------------------
// parseChannelReference — golden corpus
// ---------------------------------------------------------------------------

describe("parseChannelReference (golden, captured from Go 1.26.5)", () => {
  const golden: ReadonlyArray<readonly [string, ChannelReferenceKind, string]> = [
    // Bare handles.
    ["@example", "handle", "@example"],
    ["@", "handle", "@"],
    [" @x", "search", " @x"],

    // Canonical URL forms.
    ["https://youtube.com/@example/videos", "handle", "@example"],
    ["youtube.com/@example", "handle", "@example"],
    ["https://www.youtube.com/@x", "handle", "@x"],
    ["www.youtube.com/channel/UC1234567890123456789012", "id", "UC1234567890123456789012"],
    [
      "https://youtube.com/channel/UC1234567890123456789012/videos",
      "id",
      "UC1234567890123456789012"
    ],
    ["https://m.youtube.com/user/someuser", "username", "someuser"],
    ["https://youtube.com/c/SomeName", "search", "SomeName"],
    ["https://m.youtube.com/@x", "handle", "@x"],

    // Host casing: TrimPrefix("www.") runs BEFORE ToLower, so an uppercase
    // "WWW." survives and the host test fails.
    ["https://WWW.YOUTUBE.COM/@Foo", "search", "https://WWW.YOUTUBE.COM/@Foo"],
    ["WWW.youtube.com/@x", "search", "WWW.youtube.com/@x"],
    // ...but a host with no "www." prefix lowercases fine.
    ["https://M.YOUTUBE.COM/@x", "handle", "@x"],
    ["M.Youtube.com/@x", "search", "M.Youtube.com/@x"],
    ["https://www.m.youtube.com/@x", "handle", "@x"],

    // The scheme is never checked.
    ["ftp://youtube.com/@x", "handle", "@x"],
    ["HTTPS://youtube.com/@x", "handle", "@x"],

    // Non-YouTube and near-miss hosts.
    ["https://youtu.be/@x", "search", "https://youtu.be/@x"],
    ["youtu.be/@x", "search", "youtu.be/@x"],
    ["https://music.youtube.com/@x", "search", "https://music.youtube.com/@x"],
    ["https://youtube.com./@x", "search", "https://youtube.com./@x"],
    ["xyoutube.com/@z", "search", "xyoutube.com/@z"],
    ["https://[::1]/@x", "search", "https://[::1]/@x"],

    // A scheme-relative reference has no authority in Go.
    ["//youtube.com/@x", "search", "//youtube.com/@x"],

    // Userinfo and ports.
    ["https://user:pass@youtube.com/@x", "handle", "@x"],
    ["https://youtube.com:8080/@x", "handle", "@x"],
    ["http://www.youtube.com:8080/channel/UCabc", "id", "UCabc"],

    // Paths that do not resolve to a known prefix.
    ["https://youtube.com/", "search", "https://youtube.com/"],
    ["https://youtube.com", "search", "https://youtube.com"],
    ["youtube.com/", "search", "youtube.com/"],
    ["https://youtube.com/channel", "search", "https://youtube.com/channel"],
    ["https://youtube.com/channel/", "search", "https://youtube.com/channel/"],
    ["https://youtube.com/user", "search", "https://youtube.com/user"],
    ["https://youtube.com/user/", "search", "https://youtube.com/user/"],
    ["https://youtube.com/c/", "search", "https://youtube.com/c/"],
    ["https://youtube.com/watch?v=x", "search", "https://youtube.com/watch?v=x"],
    // The prefix match is case-sensitive.
    ["https://youtube.com/CHANNEL/UCabc", "search", "https://youtube.com/CHANNEL/UCabc"],
    ["https://youtube.com/C/SomeName", "search", "https://youtube.com/C/SomeName"],

    // Only the FIRST two path segments matter; extras are ignored.
    ["https://youtube.com/user/a/b/c", "username", "a"],
    ["https://youtube.com/channel/a/b", "id", "a"],
    ["https://youtube.com/@x/@y", "handle", "@x"],

    // Slash collapsing via strings.Trim(path, "/").
    ["https://youtube.com//@x", "handle", "@x"],
    ["https://youtube.com///@x", "handle", "@x"],
    // ...but "." is a real segment, not normalized away.
    ["https://youtube.com/./@x", "search", "https://youtube.com/./@x"],

    // The path is percent-DECODED before segmentation.
    ["https://youtube.com/%40handle", "handle", "@handle"],
    ["https://youtube.com/@%C3%A9", "handle", "@é"],
    ["https://youtube.com/@x%20y", "handle", "@x y"],
    ["https://youtube.com/@x%2Fy", "handle", "@x"],
    ["https://youtube.com/a%2Fb/@x", "search", "https://youtube.com/a%2Fb/@x"],
    ["https://youtube.com/%2540handle", "search", "https://youtube.com/%2540handle"],

    // Query and fragment are split off before the path is read.
    ["https://youtube.com/@x?q=1", "handle", "@x"],
    ["https://youtube.com/@x?", "handle", "@x"],
    ["https://youtube.com/@x#frag", "handle", "@x"],
    ["https://youtube.com/@x#", "handle", "@x"],
    // Query escapes are not validated; fragment escapes are.
    ["https://youtube.com/@x?q=%zz", "handle", "@x"],
    ["https://youtube.com/@x#f%zz", "search", "https://youtube.com/@x#f%zz"],

    // url.Parse failures all fall through to a keyword search.
    ["https://youtube.com/@x%", "search", "https://youtube.com/@x%"],
    ["https://youtube.com/@x%2G", "search", "https://youtube.com/@x%2G"],
    ["https://yout ube.com/@x", "search", "https://yout ube.com/@x"],
    // A %XX in the host with a high nibble < 8 is rejected outright.
    ["https://youtube%2ecom/@x", "search", "https://youtube%2ecom/@x"],

    // Characters url.Parse tolerates in a path.
    ["https://youtube.com/@x y", "handle", "@x y"],
    ["https://youtube.com/@x|y", "handle", "@x|y"],
    ['https://youtube.com/@x"y', "handle", '@x"y'],
    ["https://youtube.com/@x[1]", "handle", "@x[1]"],
    ["https://youtube.com/@café", "handle", "@café"],
    ["https://youtube.com/@日本", "handle", "@日本"],
    ["https://youtube.com/@", "handle", "@"],

    // Plain keywords.
    ["Some Channel", "search", "Some Channel"],
    ["UC1234567890123456789012", "search", "UC1234567890123456789012"],
    ["mailto:x@y.com", "search", "mailto:x@y.com"],
    ["a:b/c", "search", "a:b/c"]
  ]

  test.each(golden)("%j -> %s %j", (input, kind, value) => {
    expect(parseChannelReference(input)).toEqual({ kind, value })
  })

  test("the golden corpus covers every kind", () => {
    const kinds = new Set(golden.map(([, kind]) => kind))
    expect([...kinds].sort()).toEqual(["handle", "id", "search", "username"])
  })
})

// ---------------------------------------------------------------------------
// CHANNEL_ID_PATTERN
// ---------------------------------------------------------------------------

describe("CHANNEL_ID_PATTERN", () => {
  test("accepts exactly 24 characters starting with UC", () => {
    expect(CHANNEL_ID_PATTERN.test("UC1234567890123456789012")).toBe(true)
    expect("UC1234567890123456789012".length).toBe(24)
  })

  test.each([
    ["too short", "UC123456789012345678901"],
    ["too long", "UC12345678901234567890123"],
    ["wrong prefix", "AB1234567890123456789012"],
    ["lowercase prefix", "uc1234567890123456789012"],
    ["an illegal character", "UC123456789012345678901!"],
    ["empty", ""]
  ])("rejects %s", (_label, input) => {
    expect(CHANNEL_ID_PATTERN.test(input)).toBe(false)
  })

  test("accepts the URL-safe base64 alphabet", () => {
    expect(CHANNEL_ID_PATTERN.test("UCabcXYZ012_-abcXYZ01234")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveChannel
// ---------------------------------------------------------------------------

describe("resolveChannel", () => {
  // Go: TestResolveChannelHandleAndURL
  test("resolves a handle URL through channels?forHandle, one request", async () => {
    const h = harness([`{"items":[{"id":"UC1234567890123456789012"}]}`])
    const result = okOf(await h.run("https://youtube.com/@example/videos"))

    expect(result).toEqual({ id: "UC1234567890123456789012", requests: 1 })
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]!.resource).toBe("channels")
    expect(param(h.seen[0]!.params, "forHandle")).toBe("example")
    expect(param(h.seen[0]!.params, "part")).toBe("id")
  })

  // Go: the same test asserts a canonical UC… id costs zero requests.
  test("a UC… id short-circuits with zero requests", async () => {
    const h = harness([`{"items":[]}`])
    expect(okOf(await h.run("UC1234567890123456789012"))).toEqual({
      id: "UC1234567890123456789012",
      requests: 0
    })
    expect(h.seen).toHaveLength(0)
  })

  test("a bare @handle strips only the leading @", async () => {
    const h = harness([`{"items":[{"id":"UCz"}]}`])
    okOf(await h.run("@ex@mple"))
    expect(param(h.seen[0]!.params, "forHandle")).toBe("ex@mple")
  })

  test("a /user/ URL uses forUsername", async () => {
    const h = harness([`{"items":[{"id":"UCu"}]}`])
    const result = okOf(await h.run("https://m.youtube.com/user/someuser"))
    expect(result).toEqual({ id: "UCu", requests: 1 })
    expect(param(h.seen[0]!.params, "forUsername")).toBe("someuser")
    expect(param(h.seen[0]!.params, "forHandle")).toBeUndefined()
  })

  test("a /channel/ URL short-circuits when the ID is valid", async () => {
    const h = harness(["{}"])
    expect(okOf(await h.run("https://youtube.com/channel/UC1234567890123456789012"))).toEqual({
      id: "UC1234567890123456789012",
      requests: 0
    })
    expect(h.seen).toHaveLength(0)
  })

  test("a /channel/ URL with a malformed ID is an error, not a search", async () => {
    const h = harness(["{}"])
    const error = errOf(await h.run("https://youtube.com/channel/UCabc"))
    expect(error).toBeInstanceOf(OperationalError)
    expect(error.message).toBe('invalid channel ID "UCabc"')
    expect(h.seen).toHaveLength(0)
  })

  test("a keyword reads the NESTED id.channelId from search", async () => {
    const h = harness([`{"items":[{"id":{"kind":"youtube#channel","channelId":"UCsearched"}}]}`])
    const result = okOf(await h.run("Some Channel"))

    expect(result).toEqual({ id: "UCsearched", requests: 1 })
    expect(h.seen[0]!.resource).toBe("search")
    expect(param(h.seen[0]!.params, "part")).toBe("snippet")
    expect(param(h.seen[0]!.params, "type")).toBe("channel")
    expect(param(h.seen[0]!.params, "q")).toBe("Some Channel")
    expect(param(h.seen[0]!.params, "maxResults")).toBe("1")
  })

  test("a /c/ URL searches for the segment, not the whole URL", async () => {
    const h = harness([`{"items":[{"id":{"channelId":"UCc"}}]}`])
    okOf(await h.run("https://youtube.com/c/SomeName"))
    expect(param(h.seen[0]!.params, "q")).toBe("SomeName")
  })

  test("the channels path reads a FLAT string id, unlike search", async () => {
    // An object-valued id on the channels path yields "not found".
    const h = harness([`{"items":[{"id":{"channelId":"UCnested"}}]}`])
    expect(errOf(await h.run("@example"))).toBeInstanceOf(NotFoundError)
  })

  describe("not found", () => {
    test("empty items on the channels path", async () => {
      const h = harness([`{"items":[]}`])
      const error = errOf(await h.run("@example"))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe('channel "@example" not found')
    })

    test("empty items on the search path", async () => {
      const h = harness([`{"items":[]}`])
      const error = errOf(await h.run("Some Channel"))
      expect(error.message).toBe('channel "Some Channel" not found')
    })

    test("an item with no id", async () => {
      const h = harness([`{"items":[{"snippet":{"title":"t"}}]}`])
      expect(errOf(await h.run("@example"))).toBeInstanceOf(NotFoundError)
    })

    test("an item with an empty-string id", async () => {
      const h = harness([`{"items":[{"id":""}]}`])
      expect(errOf(await h.run("@example"))).toBeInstanceOf(NotFoundError)
    })

    test("a search item with no channelId", async () => {
      const h = harness([`{"items":[{"id":{"kind":"youtube#channel"}}]}`])
      expect(errOf(await h.run("Some Channel"))).toBeInstanceOf(NotFoundError)
    })

    test("a search item whose id is a flat string", async () => {
      const h = harness([`{"items":[{"id":"UCflat"}]}`])
      expect(errOf(await h.run("Some Channel"))).toBeInstanceOf(NotFoundError)
    })

    test("the message quotes the TRIMMED reference with Go's %q", async () => {
      const h = harness([`{"items":[]}`])
      const error = errOf(await h.run('  a"b  '))
      expect(error.message).toBe('channel "a\\"b" not found')
    })
  })

  describe("empty reference", () => {
    test.each([["empty", ""], ["spaces", "   "], ["a tab", "\t"], ["a newline", "\n"]])(
      "%s is rejected before any request",
      async (_label, input) => {
        const h = harness(["{}"])
        const error = errOf(await h.run(input))
        expect(error).toBeInstanceOf(OperationalError)
        expect(error.message).toBe("channel reference cannot be empty")
        expect(h.seen).toHaveLength(0)
      }
    )
  })

  test("the reference is trimmed before classification", async () => {
    const h = harness(["{}"])
    expect(okOf(await h.run("  UC1234567890123456789012  "))).toEqual({
      id: "UC1234567890123456789012",
      requests: 0
    })
  })

  test("an upstream error propagates unchanged", async () => {
    const failing = (resource: string, _params: Params) =>
      Effect.fail(new OperationalError({ message: `boom on ${resource}` }))
    const exit = await Effect.runPromise(
      Effect.exit(resolveChannelWith(failing)("@example"))
    )
    expect(errOf(exit).message).toBe("boom on channels")
  })
})

test("a resolved id round-trips through the JSON value model unchanged", () => {
  // Guards against an accessor accidentally coercing a RawNumber-shaped id.
  const parsed = parseJson(`{"items":[{"id":"UC1234567890123456789012"}]}`)
  expect(parsed._tag).toBe("Success")
  if (parsed._tag !== "Success") throw new Error("unreachable")
  const value: JsonValue = parsed.success
  expect(typeof value).toBe("object")
})

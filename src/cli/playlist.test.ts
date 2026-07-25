/**
 * `oytc playlist {get,list,items}` plus the shared helpers that live in
 * playlist.ts.
 *
 * Every validation message and exit code asserted here was captured from
 * `/tmp/oytc-ref` (the compiled Go binary), not from the spec.
 */

import { describe, expect, test } from "bun:test"
import { NotFoundError } from "../domain/errors.ts"
import {
  playlistCommand,
  batch,
  exactArgs,
  fieldSelectorIncludes,
  fieldsWithRequired,
  minimumArgs,
  pageOptions,
  partsOr,
  setValues,
  stripItemIDs,
  validateEnum,
  validateListFlags,
  validateParts,
  validateRequestedItems
} from "./playlist.ts"
import { expectUsage, listOf, responseOf, runCli, summaryLine } from "./harness.testutil.ts"

const run = (argv: ReadonlyArray<string>, options?: Parameters<typeof runCli>[2]) =>
  runCli(playlistCommand, argv, options)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe("partsOr", () => {
  test("blank and whitespace-only fall back", () => {
    expect(partsOr("", "snippet")).toBe("snippet")
    expect(partsOr("   ", "snippet")).toBe("snippet")
    expect(partsOr("\t\n", "snippet")).toBe("snippet")
  })

  test("a set value is used verbatim, untrimmed", () => {
    expect(partsOr(" snippet ", "x")).toBe(" snippet ")
    expect(partsOr("a,b", "x")).toBe("a,b")
  })
})

describe("setValues", () => {
  test("drops empty values and keeps order", () => {
    expect(
      setValues(
        [["part", "snippet"]],
        [
          ["hl", ""],
          ["fields", "items/id"],
          ["videoId", ""]
        ]
      )
    ).toEqual([
      ["part", "snippet"],
      ["fields", "items/id"]
    ])
  })
})

describe("validateEnum", () => {
  test("an empty value always passes", () => {
    expect(validateEnum("--order", "", "time", "relevance")).toBeUndefined()
  })

  test("an allowed value passes", () => {
    expect(validateEnum("--order", "relevance", "time", "relevance")).toBeUndefined()
  })

  test("message lists the allowed values comma-separated", () => {
    expect(validateEnum("--order", "bogus", "time", "relevance")?.message).toBe(
      "--order must be one of: time, relevance"
    )
  })
})

describe("validateParts", () => {
  test("a forbidden part anywhere in the list is rejected", () => {
    expect(validateParts("snippet,subscriberSnippet", "subscriberSnippet")?.message).toBe(
      'part "subscriberSnippet" requires owner/OAuth access and is not supported'
    )
  })

  test("segments are trimmed before comparison", () => {
    expect(validateParts(" subscriberSnippet ", "subscriberSnippet")).toBeDefined()
  })

  test("a superstring is not a match", () => {
    expect(validateParts("subscriberSnippetX", "subscriberSnippet")).toBeUndefined()
  })
})

describe("arity helpers", () => {
  test("exactArgs", () => {
    expect(exactArgs(1, ["a"])).toBeUndefined()
    expect(exactArgs(1, [])?.message).toBe("expected 1 argument(s), received 0")
    expect(exactArgs(1, ["a", "b"])?.message).toBe("expected 1 argument(s), received 2")
    expect(exactArgs(0, ["a"])?.message).toBe("expected 0 argument(s), received 1")
  })

  test("minimumArgs", () => {
    expect(minimumArgs(1, ["a", "b"])).toBeUndefined()
    expect(minimumArgs(1, [])?.message).toBe("expected at least 1 argument(s), received 0")
  })
})

describe("validateListFlags", () => {
  const flags = (pageSize: number, limit = 0) => ({
    pageSize,
    limit,
    all: false,
    pageToken: ""
  })

  test("bounds are inclusive", () => {
    expect(validateListFlags(flags(1), 50)).toBeUndefined()
    expect(validateListFlags(flags(50), 50)).toBeUndefined()
    expect(validateListFlags(flags(100), 100)).toBeUndefined()
  })

  test("zero and negative are rejected, not clamped", () => {
    expect(validateListFlags(flags(0), 50)?.message).toBe("--page-size must be between 1 and 50")
    expect(validateListFlags(flags(-1), 50)?.message).toBe("--page-size must be between 1 and 50")
  })

  test("the max appears verbatim in the message", () => {
    expect(validateListFlags(flags(101), 100)?.message).toBe(
      "--page-size must be between 1 and 100"
    )
  })

  test("page size is checked before limit", () => {
    expect(validateListFlags(flags(999, -1), 50)?.message).toBe(
      "--page-size must be between 1 and 50"
    )
  })

  test("a negative limit is rejected; zero is allowed", () => {
    expect(validateListFlags(flags(25, -1), 50)?.message).toBe("--limit cannot be negative")
    expect(validateListFlags(flags(25, 0), 50)).toBeUndefined()
  })
})

describe("pageOptions", () => {
  test("maps the four list flags across", () => {
    expect(pageOptions({ pageSize: 20, pageToken: "T", all: true, limit: 5 })).toEqual({
      pageSize: 20,
      pageToken: "T",
      all: true,
      limit: 5
    })
  })
})

describe("batch", () => {
  test("splits into groups of at most size", () => {
    expect(batch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  test("an empty input produces no batches", () => {
    expect(batch([], 50)).toEqual([])
  })

  test("an exact multiple produces no trailing empty batch", () => {
    expect(batch([1, 2], 2)).toEqual([[1, 2]])
  })
})

describe("fieldSelectorIncludes", () => {
  test("a wildcard covers everything", () => {
    expect(fieldSelectorIncludes("*", "items/id")).toBe(true)
  })

  test("the bare items selector covers items/id", () => {
    expect(fieldSelectorIncludes("items", "items/id")).toBe(true)
  })

  test("an exact match", () => {
    expect(fieldSelectorIncludes("items/id", "items/id")).toBe(true)
  })

  test("a deeper path implies the parent", () => {
    expect(fieldSelectorIncludes("items/id/videoId", "items/id")).toBe(true)
  })

  test("a wildcard child covers the target", () => {
    expect(fieldSelectorIncludes("items/*", "items/id")).toBe(true)
  })

  test("parenthesized groups expand", () => {
    expect(fieldSelectorIncludes("items(id,snippet/title)", "items/id")).toBe(true)
    expect(fieldSelectorIncludes("nextPageToken,items(snippet/title)", "items/id")).toBe(false)
  })

  test("an unrelated selector does not cover it", () => {
    expect(fieldSelectorIncludes("nextPageToken", "items/id")).toBe(false)
    expect(fieldSelectorIncludes("items/snippet", "items/id")).toBe(false)
  })

  test("whitespace is skipped", () => {
    expect(fieldSelectorIncludes("items( id , snippet/title )", "items/id")).toBe(true)
  })

  /**
   * Differentially generated: each pair was run through Go's
   * `fieldSelectorIncludes` (internal/cli/fields.go) and the expectation is its
   * actual return value. The malformed inputs are the interesting half — the
   * Go parser never errors, it just yields whatever paths it managed to read.
   */
  test.each([
    ["*", "items/id", true],
    ["items", "items/id", true],
    ["items/id", "items/id", true],
    ["items/id/videoId", "items/id", true],
    ["items/*", "items/id", true],
    ["items(id,snippet/title)", "items/id", true],
    ["items( id , snippet/title )", "items/id", true],
    ["items((id))", "items/id", true],
    ["items/id/kind", "items/id/kind", true],
    ["nextPageToken,items(snippet/title)", "items/id", false],
    ["nextPageToken", "items/id", false],
    ["items/snippet", "items/id", false],
    ["", "items/id", false],
    ["i", "items/id", false],
    ["items/idx", "items/id", false],
    ["items/*/x", "items/id", false],
    ["items/snippet/*", "items/id", false],
    ["a/*", "items/id", false],
    ["items(", "items/id", false],
    [")", "items/id", false],
    ["items/", "items/id", false],
    [",,,", "items/id", false]
  ])("matches Go for (%p, %p)", (selector, target, expected) => {
    expect(fieldSelectorIncludes(selector as string, target as string)).toBe(expected)
  })
})

describe("fieldsWithRequired", () => {
  test("an empty selector is left alone and the field is preserved", () => {
    expect(fieldsWithRequired("", "items/id")).toEqual(["", true])
  })

  test("an already-covering selector is left alone", () => {
    expect(fieldsWithRequired("items/id", "items/id")).toEqual(["items/id", true])
  })

  test("otherwise the required path is appended and the field is stripped later", () => {
    expect(fieldsWithRequired("items/snippet/title", "items/id")).toEqual([
      "items/snippet/title,items/id",
      false
    ])
  })
})

describe("stripItemIDs", () => {
  test("preserve keeps the items untouched", () => {
    const input = [{ id: "a", x: "1" }]
    expect(stripItemIDs(input, true)).toBe(input)
  })

  test("otherwise id is removed from every item", () => {
    expect(stripItemIDs([{ id: "a", x: "1" }, { id: "b" }], false)).toEqual([{ x: "1" }, {}])
  })
})

describe("validateRequestedItems", () => {
  test("all present", () => {
    expect(
      validateRequestedItems("playlists", ["a", "b"], [{ id: "a" }, { id: "b" }])
    ).toBeUndefined()
  })

  test("reports only the missing ids, in request order", () => {
    const error = validateRequestedItems("playlists", ["a", "b", "c"], [{ id: "b" }])
    expect(error?.message).toBe("playlists not found: a, c")
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test("duplicate requests are de-duplicated", () => {
    expect(validateRequestedItems("playlists", ["a", "a"], [{ id: "a" }])).toBeUndefined()
    expect(validateRequestedItems("playlists", ["a", "a", "b"], [{ id: "a" }])?.message).toBe(
      "playlists not found: b"
    )
  })

  test("the equal-cardinality escape hatch: no ids returned but the counts match", () => {
    expect(
      validateRequestedItems("playlists", ["a", "b"], [{ snippet: {} }, { snippet: {} }])
    ).toBeUndefined()
  })

  test("no ids returned and fewer items than requested reports them all", () => {
    expect(validateRequestedItems("playlists", ["a", "b"], [{ snippet: {} }])?.message).toBe(
      "playlists not found: a, b"
    )
  })

  test("an empty id string does not count as returned", () => {
    expect(validateRequestedItems("playlists", ["a"], [{ id: "" }])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// playlist get
// ---------------------------------------------------------------------------

describe("playlist get", () => {
  test("requires at least one id, before any request", async () => {
    const result = await run(["playlist", "get"])
    expectUsage(result, "expected at least 1 argument(s), received 0")
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("sends the default parts and the joined ids", async () => {
    const result = await run(["playlist", "get", "PL1", "PL2"], {
      script: { get: [responseOf(`[{"id":"PL1"},{"id":"PL2"}]`)] }
    })
    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]!.kind).toBe("get")
    expect(result.calls[0]!.resource).toBe("playlists")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails,status",
      id: "PL1,PL2"
    })
  })

  test("--parts overrides the default, --hl and --fields are forwarded", async () => {
    const result = await run(
      ["playlist", "get", "PL1", "--parts", "snippet", "--hl", "de", "--fields", "items"],
      { script: { get: [responseOf(`[{"id":"PL1"}]`)] } }
    )
    expect(result.calls[0]!.params).toEqual({
      part: "snippet",
      id: "PL1",
      hl: "de",
      fields: "items"
    })
  })

  test("batches ids in groups of 50 and counts one request each", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `PL${index}`)
    const script = {
      get: [
        responseOf(JSON.stringify(ids.slice(0, 50).map((id) => ({ id })))),
        responseOf(JSON.stringify(ids.slice(50, 100).map((id) => ({ id })))),
        responseOf(JSON.stringify(ids.slice(100).map((id) => ({ id }))))
      ]
    }
    const result = await run(["playlist", "get", ...ids], { script })
    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(3)
    expect(result.calls[0]!.params["id"]!.split(",")).toHaveLength(50)
    expect(result.calls[2]!.params["id"]!.split(",")).toHaveLength(20)
    expect(result.stderr).toBe(summaryLine(120, 3))
  })

  test("a --fields selector without items/id is widened and the id stripped again", async () => {
    const result = await run(["playlist", "get", "PL1", "--fields", "items/snippet/title"], {
      script: { get: [responseOf(`[{"id":"PL1","snippet":{"title":"T"}}]`)] }
    })
    expect(result.calls[0]!.params["fields"]).toBe("items/snippet/title,items/id")
    expect(result.stdout).not.toContain("PL1")
    expect(result.stdout).toContain("T")
  })

  test("a --fields selector that already covers items/id is untouched", async () => {
    const result = await run(["playlist", "get", "PL1", "--fields", "items/id"], {
      script: { get: [responseOf(`[{"id":"PL1"}]`)] }
    })
    expect(result.calls[0]!.params["fields"]).toBe("items/id")
    expect(result.stdout).toContain("PL1")
  })

  test("a missing id is a NotFoundError with exit 4", async () => {
    const result = await run(["playlist", "get", "PL1", "PL2"], {
      script: { get: [responseOf(`[{"id":"PL1"}]`)] }
    })
    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(result.message).toBe("playlists not found: PL2")
    expect(result.exitCode).toBe(4)
    expect(result.stdout).toBe("")
  })

  test("has no pagination flags", async () => {
    const result = await run(["playlist", "get", "PL1", "--page-size", "5"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("renders the default columns in declaration order", async () => {
    const result = await run(["playlist", "get", "PL1"], {
      script: {
        get: [
          responseOf(
            `[{"id":"PL1","snippet":{"title":"T","channelTitle":"C"},"contentDetails":{"itemCount":3},"status":{"privacyStatus":"public"}}]`
          )
        ]
      }
    })
    const [header, row] = result.stdout.split("\n")
    expect(header).toContain("ID")
    expect(header).toContain("SNIPPET.TITLE")
    expect(header).toContain("STATUS.PRIVACYSTATUS")
    expect(row).toContain("PL1")
    expect(row).toContain("public")
  })
})

// ---------------------------------------------------------------------------
// playlist list
// ---------------------------------------------------------------------------

describe("playlist list", () => {
  test("--channel is required", async () => {
    const result = await run(["playlist", "list"])
    expectUsage(result, "--channel is required")
    expect(result.calls).toEqual([])
  })

  test("takes no positional arguments", async () => {
    const result = await run(["playlist", "list", "extra"])
    expectUsage(result, "expected 0 argument(s), received 1")
  })

  test("page size defaults to 25 and maxes at 50", async () => {
    const ok = await run(["playlist", "list", "--channel", "UC1"], {
      script: { list: [listOf("[]")] }
    })
    expect(ok.calls[0]!.page?.pageSize).toBe(25)

    const bad = await run(["playlist", "list", "--channel", "UC1", "--page-size", "51"])
    expectUsage(bad, "--page-size must be between 1 and 50")
  })

  test("the page-size bound is checked before the missing --channel", async () => {
    const result = await run(["playlist", "list", "--page-size", "999"])
    expectUsage(result, "--page-size must be between 1 and 50")
  })

  test("--limit cannot be negative", async () => {
    const result = await run(["playlist", "list", "--channel", "UC1", "--limit=-1"])
    expectUsage(result, "--limit cannot be negative")
  })

  test("FRAMEWORK LIMITATION: space-separated negative values do not tokenize", async () => {
    // `--limit -1` (with a space) fails inside the CLI tokenizer, which treats
    // `-1` as a short flag rather than as the value of `--limit`:
    //   "Missing value for flag --limit" + "Unrecognized flag: -1"
    // Go's pflag accepts it and reports "--limit cannot be negative".
    //
    // This is NOT specific to `Flag.integer` — a `Flag.string` behaves the same
    // way, so it cannot be worked around at the flag level. It affects every
    // package that has a numeric flag a user might pass a negative value to.
    // `--limit=-1` (with an equals sign) works and produces the Go message.
    const result = await run(["playlist", "list", "--channel", "UC1", "--limit", "-1"])
    expect(result.exitCode).toBe(2)
    expect(result.error).toBeUndefined()
    expect(result.calls).toEqual([])
  })

  test("assembles channelId, hl and fields", async () => {
    const result = await run(
      ["playlist", "list", "--channel", "UC1", "--hl", "fr", "--fields", "items"],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.resource).toBe("playlists")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails,status",
      channelId: "UC1",
      hl: "fr",
      fields: "items"
    })
  })

  test("forwards --all, --limit and --page-token", async () => {
    const result = await run(
      [
        "playlist",
        "list",
        "--channel",
        "UC1",
        "--all",
        "--limit",
        "10",
        "--page-token",
        "TOK",
        "--page-size",
        "5"
      ],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.page).toEqual({
      all: true,
      limit: 10,
      pageSize: 5,
      pageToken: "TOK"
    })
  })

  test("the stderr summary reports the next page token when one is present", async () => {
    const result = await run(["playlist", "list", "--channel", "UC1"], {
      script: { list: [listOf(`[{"id":"a"},{"id":"b"}]`, 2, "NEXT")] }
    })
    expect(result.stderr).toBe("2 item(s), 2 request(s); more available (next token: NEXT)\n")
  })

  test("--quiet suppresses the summary", async () => {
    const result = await run(["playlist", "list", "--channel", "UC1", "--quiet"], {
      script: { list: [listOf(`[{"id":"a"}]`)] }
    })
    expect(result.stderr).toBe("")
    expect(result.stdout).not.toBe("")
  })

  test("non-table formats emit no summary at all", async () => {
    const result = await run(["playlist", "list", "--channel", "UC1", "--format", "json"], {
      script: { list: [listOf(`[{"id":"a"}]`)] }
    })
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain('"items"')
  })

  test("--columns overrides the defaults", async () => {
    const result = await run(["playlist", "list", "--channel", "UC1", "--columns", "id"], {
      script: { list: [listOf(`[{"id":"a","snippet":{"title":"T"}}]`)] }
    })
    expect(result.stdout).toBe("ID\na\n")
  })

  test("a bad global --timeout fails before the command's own checks", async () => {
    // `resolveGlobals` runs inside `Command.provide`, which the framework
    // builds before the handler — so this beats the missing --channel, exactly
    // as it does in Go (`oytc --timeout 0 playlist list` -> the timeout error).
    const result = await runCli(playlistCommand, ["playlist", "list", "--timeout", "0"])
    expectUsage(result, "--timeout must be positive")
    expect(result.calls).toEqual([])
  })

  test("--no-header omits the header row", async () => {
    const result = await run(
      ["playlist", "list", "--channel", "UC1", "--columns", "id", "--no-header"],
      { script: { list: [listOf(`[{"id":"a"}]`)] } }
    )
    expect(result.stdout).toBe("a\n")
  })
})

// ---------------------------------------------------------------------------
// playlist items
// ---------------------------------------------------------------------------

describe("playlist items", () => {
  test("requires exactly one playlist id", async () => {
    const none = await run(["playlist", "items"])
    expectUsage(none, "expected 1 argument(s), received 0")
    expect(none.calls).toEqual([])

    const two = await run(["playlist", "items", "a", "b"])
    expectUsage(two, "expected 1 argument(s), received 2")
  })

  test("the arity check precedes the page-size bound", async () => {
    const result = await run(["playlist", "items", "--page-size", "999"])
    expectUsage(result, "expected 1 argument(s), received 0")
  })

  test("KNOWN DIVERGENCE: a bad --timeout beats the arity check", async () => {
    // Go reports "expected 1 argument(s), received 0" here, because cobra runs
    // Args before PersistentPreRunE. The framework builds `Command.provide`
    // (which is where resolveGlobals lives) before the handler, so the timeout
    // error wins instead. Documented in playlist.ts; fixing it would require
    // editing root.ts/globals.ts, which this package does not own.
    const result = await run(["playlist", "items", "--timeout", "0"])
    expectUsage(result, "--timeout must be positive")
    expect(result.calls).toEqual([])
  })

  test("page size defaults to 50, not 25", async () => {
    const result = await run(["playlist", "items", "PL1"], { script: { list: [listOf("[]")] } })
    expect(result.calls[0]!.page?.pageSize).toBe(50)
  })

  test("page size maxes at 50", async () => {
    const result = await run(["playlist", "items", "PL1", "--page-size", "51"])
    expectUsage(result, "--page-size must be between 1 and 50")
  })

  test("assembles playlistId and the optional videoId", async () => {
    const result = await run(["playlist", "items", "PL1", "--video", "V1"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.resource).toBe("playlistItems")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails,status",
      playlistId: "PL1",
      videoId: "V1"
    })
  })

  test("has no --hl flag", async () => {
    const result = await run(["playlist", "items", "PL1", "--hl", "en"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("renders the playlist-item default columns", async () => {
    const result = await run(["playlist", "items", "PL1"], {
      script: {
        list: [
          listOf(
            `[{"snippet":{"position":1,"title":"T","videoOwnerChannelTitle":"O"},"contentDetails":{"videoId":"V"}}]`
          )
        ]
      }
    })
    // Byte-for-byte against `output.Render(..., Format: "table")` in Go.
    expect(result.stdout).toBe(
      "SNIPPET.POSITION  CONTENTDETAILS.VIDEOID  SNIPPET.TITLE  SNIPPET.VIDEOOWNERCHANNELTITLE\n" +
        "1                 V                       T              O\n"
    )
  })
})

// ---------------------------------------------------------------------------
// group command
// ---------------------------------------------------------------------------

describe("the playlist group", () => {
  test("bare `oytc playlist` prints help and exits 0", async () => {
    const result = await run(["playlist"])
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.calls).toEqual([])
  })
})

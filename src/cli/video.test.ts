import { describe, expect, test } from "bun:test"
import { ApiError } from "../domain/errors.ts"
import type { JsonValue } from "../json/value.ts"
import {
  expectUsage,
  object,
  pageOf,
  responseOf,
  runCli,
  summaryLine
} from "./p8aHarness.testutil.ts"
import type { RunResult } from "./p8aHarness.testutil.ts"
import {
  videoCommand,
  videoGetCommand,
  videoPopularCommand,
  videoStatsCommand,
  videoTrainabilityCommand
} from "./video.ts"

/** The five-parameter Command generic differs per command; the harness only mounts it. */
const cmd = (c: unknown) => c as never

const get = (argv: ReadonlyArray<string>, script = {}): Promise<RunResult> =>
  runCli(cmd(videoGetCommand), argv, { script })

const stats = (argv: ReadonlyArray<string>, script = {}): Promise<RunResult> =>
  runCli(cmd(videoStatsCommand), argv, { script })

const popular = (argv: ReadonlyArray<string>, script = {}): Promise<RunResult> =>
  runCli(cmd(videoPopularCommand), argv, { script })

const trainability = (argv: ReadonlyArray<string>, script = {}): Promise<RunResult> =>
  runCli(cmd(videoTrainabilityCommand), argv, { script })

const ids = (count: number, prefix = "v"): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`)

const videoItems = (values: ReadonlyArray<string>): string =>
  `[${values.map((id) => `{"id":${JSON.stringify(id)}}`).join(",")}]`

// ---------------------------------------------------------------------------
// video get
// ---------------------------------------------------------------------------

describe("video get — validation", () => {
  test("G3: no arguments", async () => {
    expectUsage(await get(["get"]), "expected at least 1 argument(s), received 0")
  })

  test("a forbidden part is rejected before any request", async () => {
    expectUsage(
      await get(["get", "--parts", "fileDetails", "abc"]),
      'part "fileDetails" requires owner/OAuth access and is not supported'
    )
  })

  test("processingDetails and suggestions are forbidden too", async () => {
    expectUsage(
      await get(["get", "--parts", "snippet,processingDetails", "abc"]),
      'part "processingDetails" requires owner/OAuth access and is not supported'
    )
    expectUsage(
      await get(["get", "--parts", "suggestions", "abc"]),
      'part "suggestions" requires owner/OAuth access and is not supported'
    )
  })

  test("the arg-count check fires BEFORE the parts check", async () => {
    expectUsage(
      await get(["get", "--parts", "fileDetails"]),
      "expected at least 1 argument(s), received 0"
    )
  })

  test("a normal part list is accepted", async () => {
    const result = await get(["get", "--parts", "snippet", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.exitCode).toBe(0)
  })
})

describe("video get — request assembly", () => {
  test("the default parts and a single id", async () => {
    const result = await get(["get", "abc"], { get: [responseOf('[{"id":"abc"}]')] })
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]!.resource).toBe("videos")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails,statistics,status",
      id: "abc"
    })
  })

  test("--parts overrides the default", async () => {
    const result = await get(["get", "--parts", "snippet", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.calls[0]!.params["part"]).toBe("snippet")
  })

  test("whitespace-only --parts falls back to the default", async () => {
    const result = await get(["get", "--parts", "   ", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.calls[0]!.params["part"]).toBe("snippet,contentDetails,statistics,status")
  })

  test("--hl is forwarded", async () => {
    const result = await get(["get", "--hl", "fr", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.calls[0]!.params["hl"]).toBe("fr")
  })

  test("an empty --hl is NOT sent at all", async () => {
    const result = await get(["get", "abc"], { get: [responseOf('[{"id":"abc"}]')] })
    expect(result.calls[0]!.params).not.toHaveProperty("hl")
    expect(result.calls[0]!.params).not.toHaveProperty("fields")
  })

  test("ids are comma-joined into one request", async () => {
    const result = await get(["get", "a", "b", "c"], {
      get: [responseOf('[{"id":"a"},{"id":"b"},{"id":"c"}]')]
    })
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]!.params["id"]).toBe("a,b,c")
  })
})

describe("video get — batching at 50", () => {
  test("exactly 50 ids is ONE request", async () => {
    const requested = ids(50)
    const result = await get(["get", ...requested], {
      get: [responseOf(videoItems(requested))]
    })
    expect(result.calls).toHaveLength(1)
    expect(result.exitCode).toBe(0)
  })

  test("51 ids is TWO requests, split 50/1", async () => {
    const requested = ids(51)
    const result = await get(["get", ...requested], {
      get: [responseOf(videoItems(requested.slice(0, 50))), responseOf(videoItems(requested.slice(50)))]
    })
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0]!.params["id"]!.split(",")).toHaveLength(50)
    expect(result.calls[1]!.params["id"]).toBe("v50")
  })

  test("101 ids is THREE requests and requests counts batches, not ids", async () => {
    const requested = ids(101)
    const result = await get(["get", ...requested], {
      get: [
        responseOf(videoItems(requested.slice(0, 50))),
        responseOf(videoItems(requested.slice(50, 100))),
        responseOf(videoItems(requested.slice(100)))
      ]
    })
    expect(result.calls).toHaveLength(3)
    expect(result.stderr).toBe(summaryLine(101, 3))
  })

  test("items are concatenated in batch order", async () => {
    const requested = ids(51)
    const result = await get(["get", "--format", "jsonl", ...requested], {
      get: [responseOf(videoItems(requested.slice(0, 50))), responseOf(videoItems(requested.slice(50)))]
    })
    const lines = result.stdout.trim().split("\n")
    expect(lines).toHaveLength(51)
    expect(lines[0]).toBe('{"id":"v0"}')
    expect(lines[50]).toBe('{"id":"v50"}')
  })
})

describe("video get — validateRequestedItems", () => {
  test("a missing id fails with exit 4 and the comma-space joined list", async () => {
    const result = await get(["get", "a", "b"], { get: [responseOf('[{"id":"a"}]')] })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe("videos not found: b")
  })

  test("several missing ids keep the requested order", async () => {
    const result = await get(["get", "a", "b", "c"], {
      get: [responseOf('[{"id":"b"}]')]
    })
    expect(result.message).toBe("videos not found: a, c")
  })

  test("duplicate requested ids are de-duplicated for the report", async () => {
    const result = await get(["get", "a", "a", "b"], {
      get: [responseOf('[{"id":"a"}]')]
    })
    expect(result.message).toBe("videos not found: b")
  })

  test("a duplicate id that IS returned passes", async () => {
    const result = await get(["get", "a", "a"], { get: [responseOf('[{"id":"a"}]')] })
    expect(result.exitCode).toBe(0)
  })

  test("the escape hatch: no recoverable ids but equal cardinality passes", async () => {
    // A --fields selector that keeps ids out of the response entirely.
    const result = await get(["get", "--fields", "items/snippet/title", "a", "b"], {
      get: [responseOf('[{"snippet":{"title":"one"}},{"snippet":{"title":"two"}}]')]
    })
    expect(result.exitCode).toBe(0)
  })

  test("no recoverable ids AND fewer items reports every requested id", async () => {
    const result = await get(["get", "--fields", "items/snippet/title", "a", "b"], {
      get: [responseOf('[{"snippet":{"title":"one"}}]')]
    })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe("videos not found: a, b")
  })

  test("no recoverable ids and MORE items than requested passes", async () => {
    // returned.size === 0 and items.length > unique.length: neither branch
    // populates `missing`, so Go accepts.
    const result = await get(["get", "--fields", "items/snippet/title", "a"], {
      get: [responseOf('[{"snippet":{"title":"one"}},{"snippet":{"title":"two"}}]')]
    })
    expect(result.exitCode).toBe(0)
  })

  test("an empty-string id in the response does not count as recoverable", async () => {
    const result = await get(["get", "a"], { get: [responseOf('[{"id":""}]')] })
    // returned stays empty, cardinality matches -> the escape hatch accepts.
    expect(result.exitCode).toBe(0)
  })
})

describe("video get — --fields injection and stripping", () => {
  test("no --fields sends no fields param and keeps id", async () => {
    const result = await get(["get", "--format", "jsonl", "abc"], {
      get: [responseOf('[{"id":"abc","snippet":{"title":"T"}}]')]
    })
    expect(result.calls[0]!.params).not.toHaveProperty("fields")
    expect(result.stdout).toBe('{"id":"abc","snippet":{"title":"T"}}\n')
  })

  test("a non-covering selector gets items/id appended, then stripped from output", async () => {
    const result = await get(
      ["get", "--fields", "items/snippet/title", "--format", "jsonl", "abc"],
      { get: [responseOf('[{"id":"abc","snippet":{"title":"T"}}]')] }
    )
    expect(result.calls[0]!.params["fields"]).toBe("items/snippet/title,items/id")
    // The injected id must not reach the user.
    expect(result.stdout).toBe('{"snippet":{"title":"T"}}\n')
  })

  test("a selector that already covers items/id is sent unchanged and NOT stripped", async () => {
    const result = await get(
      ["get", "--fields", "items/id,items/snippet/title", "--format", "jsonl", "abc"],
      { get: [responseOf('[{"id":"abc","snippet":{"title":"T"}}]')] }
    )
    expect(result.calls[0]!.params["fields"]).toBe("items/id,items/snippet/title")
    expect(result.stdout).toBe('{"id":"abc","snippet":{"title":"T"}}\n')
  })

  test("a deeper selector also counts as covering", async () => {
    const result = await get(["get", "--fields", "items/id/videoId", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.calls[0]!.params["fields"]).toBe("items/id/videoId")
  })

  test("the same injected selector goes to EVERY batch", async () => {
    const requested = ids(51)
    const result = await get(["get", "--fields", "items/snippet/title", ...requested], {
      get: [
        responseOf(videoItems(requested.slice(0, 50))),
        responseOf(videoItems(requested.slice(50)))
      ]
    })
    expect(result.calls[0]!.params["fields"]).toBe("items/snippet/title,items/id")
    expect(result.calls[1]!.params["fields"]).toBe("items/snippet/title,items/id")
  })
})

describe("video get — rendering", () => {
  test("the default table columns", async () => {
    const result = await get(["get", "--format", "tsv", "abc"], {
      get: [
        responseOf(
          '[{"id":"abc","snippet":{"title":"T","channelTitle":"C"},"contentDetails":{"duration":"PT1M"},"statistics":{"viewCount":"5"}}]'
        )
      ]
    })
    expect(result.stdout).toBe(
      "ID\tSNIPPET.TITLE\tSNIPPET.CHANNELTITLE\tCONTENTDETAILS.DURATION\tSTATISTICS.VIEWCOUNT\n" +
        "abc\tT\tC\tPT1M\t5\n"
    )
  })

  test("--columns overrides the defaults", async () => {
    const result = await get(["get", "--format", "tsv", "--columns", "id", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.stdout).toBe("ID\nabc\n")
  })

  test("--quiet drops the stderr summary", async () => {
    const result = await get(["get", "--quiet", "abc"], {
      get: [responseOf('[{"id":"abc"}]')]
    })
    expect(result.stderr).toBe("")
  })

  test("a large counter keeps its exact literal (no float rounding)", async () => {
    const result = await get(["get", "--format", "json", "abc"], {
      get: [responseOf('[{"id":"abc","statistics":{"viewCount":9007199254740993123}}]')]
    })
    expect(result.stdout).toContain("9007199254740993123")
  })
})

// ---------------------------------------------------------------------------
// video stats
// ---------------------------------------------------------------------------

describe("video stats", () => {
  test("its default part is just statistics", async () => {
    const result = await stats(["stats", "abc"], { get: [responseOf('[{"id":"abc"}]')] })
    expect(result.calls[0]!.params["part"]).toBe("statistics")
  })

  test("its own default columns", async () => {
    const result = await stats(["stats", "--format", "tsv", "abc"], {
      get: [
        responseOf('[{"id":"abc","statistics":{"viewCount":"1","likeCount":"2","commentCount":"3"}}]')
      ]
    })
    expect(result.stdout).toBe(
      "ID\tSTATISTICS.VIEWCOUNT\tSTATISTICS.LIKECOUNT\tSTATISTICS.COMMENTCOUNT\nabc\t1\t2\t3\n"
    )
  })

  test("it shares get's validation", async () => {
    expectUsage(await stats(["stats"]), "expected at least 1 argument(s), received 0")
    expectUsage(
      await stats(["stats", "--parts", "fileDetails", "a"]),
      'part "fileDetails" requires owner/OAuth access and is not supported'
    )
  })

  test("it shares get's batching and validateRequestedItems", async () => {
    const result = await stats(["stats", "a", "b"], { get: [responseOf('[{"id":"a"}]')] })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe("videos not found: b")
  })
})

// ---------------------------------------------------------------------------
// video popular
// ---------------------------------------------------------------------------

describe("video popular — validation", () => {
  test("it accepts no positional arguments", async () => {
    expectUsage(
      await popular(["popular", "extra"]),
      "expected 0 argument(s), received 1"
    )
  })

  test("G3: --page-size bounds", async () => {
    expectUsage(
      await popular(["popular", "--page-size", "99"]),
      "--page-size must be between 1 and 50"
    )
    expectUsage(
      await popular(["popular", "--page-size", "0"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("G3: --limit cannot be negative", async () => {
    expectUsage(await popular(["popular", "--limit=-1"]), "--limit cannot be negative")
  })

  test("the arg count is checked before pagination", async () => {
    expectUsage(
      await popular(["popular", "--page-size", "99", "extra"]),
      "expected 0 argument(s), received 1"
    )
  })

  test("pagination is checked before the parts check", async () => {
    expectUsage(
      await popular(["popular", "--page-size", "99", "--parts", "fileDetails"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("a forbidden part is rejected", async () => {
    expectUsage(
      await popular(["popular", "--parts", "fileDetails"]),
      'part "fileDetails" requires owner/OAuth access and is not supported'
    )
  })
})

describe("video popular — request assembly", () => {
  test("chart, region and the default parts", async () => {
    const result = await popular(["popular"], { pages: [pageOf('[{"id":"a"}]')] })
    expect(result.calls[0]!.resource).toBe("videos")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails,statistics",
      chart: "mostPopular",
      regionCode: "US"
    })
  })

  test("--region overrides the US default", async () => {
    const result = await popular(["popular", "--region", "GB"], {
      pages: [pageOf('[{"id":"a"}]')]
    })
    expect(result.calls[0]!.params["regionCode"]).toBe("GB")
  })

  test("an explicitly empty --region is dropped, matching setValues", async () => {
    const result = await popular(["popular", "--region", ""], {
      pages: [pageOf('[{"id":"a"}]')]
    })
    expect(result.calls[0]!.params).not.toHaveProperty("regionCode")
  })

  test("--category becomes videoCategoryId", async () => {
    const result = await popular(["popular", "--category", "10"], {
      pages: [pageOf('[{"id":"a"}]')]
    })
    expect(result.calls[0]!.params["videoCategoryId"]).toBe("10")
  })

  test("the page options carry the defaults", async () => {
    const result = await popular(["popular"], { pages: [pageOf('[{"id":"a"}]')] })
    expect(result.calls[0]!.page).toEqual({
      all: false,
      limit: 0,
      pageSize: 25,
      pageToken: "",
      filter: undefined
    })
  })

  test("--all, --limit, --page-size and --page-token reach the page options", async () => {
    const result = await popular(
      ["popular", "--all", "--limit", "3", "--page-size", "2", "--page-token", "T"],
      { pages: [pageOf('[{"id":"a"},{"id":"b"}]', "N"), pageOf('[{"id":"c"},{"id":"d"}]', "M")] }
    )
    expect(result.calls[0]!.page).toEqual({
      all: true,
      limit: 3,
      pageSize: 2,
      pageToken: "T",
      filter: undefined
    })
  })

  test("popular does NOT inject a fields selector — it is not a batch get", async () => {
    const result = await popular(["popular", "--fields", "items/snippet/title"], {
      pages: [pageOf('[{"snippet":{"title":"T"}}]')]
    })
    expect(result.calls[0]!.params["fields"]).toBe("items/snippet/title")
  })
})

describe("video popular — pagination", () => {
  test("without --all exactly one request is made even with a next token", async () => {
    const result = await popular(["popular"], {
      pages: [pageOf('[{"id":"a"}]', "NEXT")]
    })
    expect(result.calls).toHaveLength(1)
    expect(result.stderr).toBe(summaryLine(1, 1, "NEXT"))
  })

  test("--all follows tokens until one is empty", async () => {
    const result = await popular(["popular", "--all"], {
      pages: [pageOf('[{"id":"a"}]', "N"), pageOf('[{"id":"b"}]', "")]
    })
    expect(result.calls).toHaveLength(2)
    expect(result.stderr).toBe(summaryLine(2, 2))
  })

  test("D2: a truncating --limit reports no resume token", async () => {
    const result = await popular(["popular", "--all", "--limit", "3"], {
      pages: [pageOf('[{"id":"a"},{"id":"b"}]', "N"), pageOf('[{"id":"c"},{"id":"d"}]', "unused")]
    })
    // 3 kept, 2 requests, and the token is suppressed because item d was
    // discarded — DEVIATIONS.md D2.
    expect(result.stderr).toBe(summaryLine(3, 2))
  })

  test("a limit landing exactly on a page boundary keeps its token", async () => {
    const result = await popular(["popular", "--all", "--limit", "2"], {
      pages: [pageOf('[{"id":"a"},{"id":"b"}]', "N")]
    })
    expect(result.stderr).toBe(summaryLine(2, 1, "N"))
  })

  test("the default columns", async () => {
    const result = await popular(["popular", "--format", "tsv"], {
      pages: [
        pageOf('[{"id":"a","snippet":{"title":"T","channelTitle":"C"},"statistics":{"viewCount":"9"}}]')
      ]
    })
    expect(result.stdout).toBe(
      "ID\tSNIPPET.TITLE\tSNIPPET.CHANNELTITLE\tSTATISTICS.VIEWCOUNT\na\tT\tC\t9\n"
    )
  })
})

// ---------------------------------------------------------------------------
// video trainability
// ---------------------------------------------------------------------------

describe("video trainability", () => {
  test("exactly one argument is required", async () => {
    expectUsage(
      await trainability(["trainability"]),
      "expected 1 argument(s), received 0"
    )
    expectUsage(
      await trainability(["trainability", "a", "b"]),
      "expected 1 argument(s), received 2"
    )
  })

  test("it is UNAUTHENTICATED and sends only id — no part, no key", async () => {
    const result = await trainability(["trainability", "abc"], {
      json: [object('{"videoId":"abc","permitted":["None"]}')]
    })
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]!.kind).toBe("getJson")
    expect(result.calls[0]!.resource).toBe("videoTrainability")
    expect(result.calls[0]!.authenticate).toBe(false)
    expect(result.calls[0]!.params).toEqual({ id: "abc" })
  })

  test("it renders a bare object with the default columns and NO summary line", async () => {
    const result = await trainability(["trainability", "--format", "tsv", "abc"], {
      json: [object('{"videoId":"abc","permitted":["None"]}')]
    })
    // Matches the real binary byte for byte.
    expect(result.stdout).toBe("VIDEOID\tPERMITTED\nabc\tNone\n")
    expect(result.stderr).toBe("")
  })

  test("G1: the permitted array comma-joins with no brackets or quotes", async () => {
    const result = await trainability(["trainability", "--format", "tsv", "abc"], {
      json: [object('{"videoId":"abc","permitted":["None","Other"]}')]
    })
    expect(result.stdout).toBe("VIDEOID\tPERMITTED\nabc\tNone,Other\n")
  })

  test("G4: json output sorts keys", async () => {
    const result = await trainability(["trainability", "--format", "json", "abc"], {
      json: [object('{"videoId":"abc","kind":"youtube#videoTrainability","etag":"E"}')]
    })
    expect(result.stdout).toBe(
      '{\n  "etag": "E",\n  "kind": "youtube#videoTrainability",\n  "videoId": "abc"\n}\n'
    )
  })

  test("no envelope: there is no items/requests wrapper", async () => {
    const result = await trainability(["trainability", "--format", "json", "abc"], {
      json: [object('{"videoId":"abc"}')]
    })
    expect(result.stdout).not.toContain("items")
    expect(result.stdout).not.toContain("requests")
  })

  test("a transport failure propagates with its own exit code", async () => {
    const result = await trainability(["trainability", "abc"], {
      failJson: new ApiError({
        httpStatus: 404,
        code: 404,
        apiMessage: "Not Found",
        reasons: []
      })
    })
    expect(result.exitCode).toBe(4)
  })

  // json.Unmarshal into map[string]any, measured against the binary through an
  // intercepting server. Each of these was a real mismatch before the fix.
  describe("non-object bodies follow json.Unmarshal, not a blanket reject", () => {
    test.each([
      ["a string", "string"],
      [42, "number"],
      [true, "bool"],
      [false, "bool"]
    ])("%p is a decode failure at exit 6", async (body, kind) => {
      const result = await trainability(["trainability", "abc"], {
        json: [body as JsonValue]
      })
      expect(result.exitCode).toBe(6)
      expect(result.message).toBe(
        `decode YouTube API response: json: cannot unmarshal ${kind} into Go value of type map[string]interface {}`
      )
    })

    test("an array reports kind 'array'", async () => {
      const result = await trainability(["trainability", "abc"], { json: [[1, 2]] })
      expect(result.exitCode).toBe(6)
      expect(result.message).toBe(
        "decode YouTube API response: json: cannot unmarshal array into Go value of type map[string]interface {}"
      )
    })

    // Go unmarshals `null` into a NIL MAP and renders it, exiting 0. A nil map
    // re-encodes as `null`, NOT as `{}` — verified against the binary.
    test.each([
      ["json", "null\n"],
      ["jsonl", "null\n"],
      ["tsv", "VIDEOID\tPERMITTED\n\t\n"]
    ])("null renders as null in %s and exits 0", async (format, expected) => {
      const result = await trainability(
        ["trainability", "--format", format, "abc"],
        { json: [null] }
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(expected)
      expect(result.stderr).toBe("")
    })

    test("null in table format matches the binary byte for byte", async () => {
      const result = await trainability(["trainability", "abc"], { json: [null] })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("VIDEOID  PERMITTED\n         \n")
    })
  })
})

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

describe("video — the group command", () => {
  test("bare `oytc video` prints help and exits 0", async () => {
    const result = await runCli(cmd(videoCommand), ["video"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(0)
  })

  test("every leaf is reachable through the group", async () => {
    const result = await runCli(cmd(videoCommand), ["video", "get", "abc"], {
      script: { get: [responseOf('[{"id":"abc"}]')] }
    })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.resource).toBe("videos")
  })

  test("popular through the group", async () => {
    const result = await runCli(cmd(videoCommand), ["video", "popular"], {
      script: { pages: [pageOf('[{"id":"a"}]')] }
    })
    expect(result.exitCode).toBe(0)
  })

  test("trainability through the group", async () => {
    const result = await runCli(cmd(videoCommand), ["video", "trainability", "abc"], {
      script: { json: [object('{"videoId":"abc"}')] }
    })
    expect(result.exitCode).toBe(0)
  })
})

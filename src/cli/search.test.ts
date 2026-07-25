import { describe, expect, test } from "bun:test"
import { expectUsage, pageOf, runCli, summaryLine } from "./p8aHarness.testutil.ts"
import type { ApiScript, RunResult } from "./p8aHarness.testutil.ts"
import { searchCommand, searchKindFilter } from "./search.ts"

/** The five-parameter Command generic differs per command; the harness only mounts it. */
const cmd = (c: unknown) => c as never

const search = (argv: ReadonlyArray<string>, script: ApiScript = {}): Promise<RunResult> =>
  runCli(cmd(searchCommand), argv, { script })

/** One search item of a given kind. */
const item = (kind: string, id: string, title = "T"): string =>
  `{"id":{"kind":"youtube#${kind}","${kind}Id":"${id}"},"snippet":{"title":"${title}"}}`

const params = (result: RunResult): Record<string, string> => result.calls[0]!.params

// ---------------------------------------------------------------------------
// validation, in Go's exact order
// ---------------------------------------------------------------------------

describe("search — argument count", () => {
  test("zero arguments is fine — QUERY is optional", async () => {
    const result = await search(["search"], { pages: [pageOf(`[${item("video", "v")}]`)] })
    expect(result.exitCode).toBe(0)
    expect(params(result)).not.toHaveProperty("q")
  })

  test("one argument becomes q", async () => {
    const result = await search(["search", "cats"], { pages: [pageOf(`[${item("video", "v")}]`)] })
    expect(params(result)["q"]).toBe("cats")
  })

  test("two arguments is a usage error", async () => {
    expectUsage(await search(["search", "a", "b"]), "expected at most 1 argument(s), received 2")
  })

  test("the arg count wins over every other check", async () => {
    expectUsage(
      await search(["search", "--order", "bogus", "a", "b"]),
      "expected at most 1 argument(s), received 2"
    )
    expectUsage(
      await search(["search", "--page-size", "99", "a", "b"]),
      "expected at most 1 argument(s), received 2"
    )
  })
})

describe("search — pagination bounds", () => {
  test("G3: --page-size must be between 1 and 50", async () => {
    expectUsage(
      await search(["search", "foo", "--page-size", "99"]),
      "--page-size must be between 1 and 50"
    )
    expectUsage(await search(["search", "--page-size", "0"]), "--page-size must be between 1 and 50")
  })

  test("G3: --limit cannot be negative", async () => {
    expectUsage(await search(["search", "--limit=-1"]), "--limit cannot be negative")
  })

  test("pagination is checked before the enums", async () => {
    expectUsage(
      await search(["search", "--page-size", "99", "--order", "bogus"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("the default page size is 25", async () => {
    const result = await search(["search"], { pages: [pageOf("[]")] })
    expect(result.calls[0]!.page!.pageSize).toBe(25)
  })
})

describe("search — enum validation in source order", () => {
  test("--order", async () => {
    expectUsage(
      await search(["search", "--order", "bogus"]),
      "--order must be one of: date, rating, relevance, title, videoCount, viewCount"
    )
  })

  test("--safe-search comes after --order", async () => {
    expectUsage(
      await search(["search", "--order", "bogus", "--safe-search", "bogus"]),
      "--order must be one of: date, rating, relevance, title, videoCount, viewCount"
    )
    expectUsage(
      await search(["search", "--safe-search", "bogus"]),
      "--safe-search must be one of: moderate, none, strict"
    )
  })

  test("--type comes after --safe-search", async () => {
    expectUsage(
      await search(["search", "--safe-search", "bogus", "--type", "bogus"]),
      "--safe-search must be one of: moderate, none, strict"
    )
    expectUsage(
      await search(["search", "--type", "bogus"]),
      "--type must be one of: video, channel, playlist"
    )
  })

  test("--type is a CSV enum: each entry is validated after trimming", async () => {
    expectUsage(
      await search(["search", "--type", "video,bogus"]),
      "--type must be one of: video, channel, playlist"
    )
    const ok = await search(["search", "--type", "video, channel"], { pages: [pageOf("[]")] })
    expect(ok.exitCode).toBe(0)
  })

  test("--channel-type comes after --type", async () => {
    expectUsage(
      await search(["search", "--type", "bogus", "--channel-type", "bogus"]),
      "--type must be one of: video, channel, playlist"
    )
    expectUsage(
      await search(["search", "--channel-type", "bogus"]),
      "--channel-type must be one of: any, show"
    )
  })

  test("the remaining video enums, each with its exact message", async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["--event-type", "bogus", "--event-type must be one of: completed, live, upcoming"],
      ["--video-caption", "bogus", "--video-caption must be one of: any, closedCaption, none"],
      ["--video-duration", "bogus", "--video-duration must be one of: any, short, medium, long"],
      ["--video-embeddable", "bogus", "--video-embeddable must be one of: any, true"],
      [
        "--video-license",
        "bogus",
        "--video-license must be one of: any, creativeCommon, youtube"
      ],
      [
        "--video-paid-product-placement",
        "bogus",
        "--video-paid-product-placement must be one of: any, true"
      ],
      ["--video-syndicated", "bogus", "--video-syndicated must be one of: any, true"]
    ]
    for (const [flag, value, message] of cases) {
      expectUsage(await search(["search", flag, value]), message)
    }
  })

  test("the enum order among the video filters is caption, duration, embeddable, …", async () => {
    expectUsage(
      await search(["search", "--video-caption", "bogus", "--video-duration", "bogus"]),
      "--video-caption must be one of: any, closedCaption, none"
    )
    expectUsage(
      await search(["search", "--video-duration", "bogus", "--video-embeddable", "bogus"]),
      "--video-duration must be one of: any, short, medium, long"
    )
  })

  test("--event-type comes before --video-caption", async () => {
    expectUsage(
      await search(["search", "--event-type", "bogus", "--video-caption", "bogus"]),
      "--event-type must be one of: completed, live, upcoming"
    )
  })
})

describe("search — timestamps come after every enum", () => {
  test("a bad enum beats a bad timestamp", async () => {
    expectUsage(
      await search(["search", "--video-duration", "bogus", "--published-after", "nope"]),
      "--video-duration must be one of: any, short, medium, long"
    )
  })

  test("--published-after then --published-before", async () => {
    expectUsage(
      await search(["search", "--published-after", "x", "--published-before", "y"]),
      "--published-after must be an RFC 3339 timestamp"
    )
    expectUsage(
      await search(["search", "--published-before", "y"]),
      "--published-before must be an RFC 3339 timestamp"
    )
  })
})

describe("search — cross-flag checks", () => {
  test("--location without --location-radius", async () => {
    expectUsage(
      await search(["search", "--location", "1,2"]),
      "--location and --location-radius must be used together"
    )
  })

  test("--location-radius without --location", async () => {
    expectUsage(
      await search(["search", "--location-radius", "5km"]),
      "--location and --location-radius must be used together"
    )
  })

  test("the together-check beats the video-filter check", async () => {
    // --location IS a video filter, but the pairing check runs first.
    expectUsage(
      await search(["search", "--type", "video", "--location", "1,2"]),
      "--location and --location-radius must be used together"
    )
  })

  test("both together with --type video is accepted", async () => {
    const result = await search(
      ["search", "--type", "video", "--location", "1,2", "--location-radius", "5km"],
      { pages: [pageOf("[]")] }
    )
    expect(result.exitCode).toBe(0)
  })
})

/**
 * The headline wart: `resourceType != "video"` is EXACT string equality, so a
 * type list merely CONTAINING video is still rejected. Every case here was
 * verified against `/tmp/oytc-ref`.
 */
describe("search — video-specific filters require EXACTLY --type video", () => {
  test("G3: the default type list is rejected", async () => {
    expectUsage(
      await search(["search", "--video-duration", "short"]),
      "video-specific filters require --type video"
    )
  })

  test("--type video,channel is rejected even though it contains video", async () => {
    expectUsage(
      await search(["search", "--type", "video,channel", "--video-duration", "short"]),
      "video-specific filters require --type video"
    )
  })

  test('--type "video " with a trailing space is rejected — no trimming here', async () => {
    expectUsage(
      await search(["search", "--type", "video ", "--video-duration", "short"]),
      "video-specific filters require --type video"
    )
  })

  test('--type "video," with a trailing comma is rejected', async () => {
    expectUsage(
      await search(["search", "--type", "video,", "--video-duration", "short"]),
      "video-specific filters require --type video"
    )
  })

  test("--type video exactly is accepted", async () => {
    const result = await search(["search", "--type", "video", "--video-duration", "short"], {
      pages: [pageOf("[]")]
    })
    expect(result.exitCode).toBe(0)
  })

  test("all nine video-specific filters trigger it", async () => {
    const filters: ReadonlyArray<readonly [string, string]> = [
      ["--event-type", "live"],
      ["--location", "1,2"],
      ["--video-caption", "any"],
      ["--video-category", "10"],
      ["--video-duration", "short"],
      ["--video-embeddable", "true"],
      ["--video-license", "youtube"],
      ["--video-paid-product-placement", "true"],
      ["--video-syndicated", "true"]
    ]
    for (const [flag, value] of filters) {
      const result = await search(["search", flag, value])
      // --location trips the pairing check first, by design.
      const expected =
        flag === "--location"
          ? "--location and --location-radius must be used together"
          : "video-specific filters require --type video"
      expectUsage(result, expected)
    }
  })

  test("--topic, --region, --language and --channel are NOT video-specific", async () => {
    for (const [flag, value] of [
      ["--topic", "/m/019_rr"],
      ["--region", "GB"],
      ["--language", "en"],
      ["--channel", "UC1"]
    ] as ReadonlyArray<readonly [string, string]>) {
      const result = await search(["search", flag, value], { pages: [pageOf("[]")] })
      expect(result.exitCode).toBe(0)
    }
  })
})

describe("search — --channel-type requires EXACTLY --type channel", () => {
  test("the default type list is rejected", async () => {
    expectUsage(
      await search(["search", "--channel-type", "any"]),
      "--channel-type requires --type channel"
    )
  })

  test("--type video is rejected", async () => {
    expectUsage(
      await search(["search", "--type", "video", "--channel-type", "any"]),
      "--channel-type requires --type channel"
    )
  })

  test("--type channel,video is rejected", async () => {
    expectUsage(
      await search(["search", "--type", "channel,video", "--channel-type", "any"]),
      "--channel-type requires --type channel"
    )
  })

  test("--type channel exactly is accepted", async () => {
    const result = await search(["search", "--type", "channel", "--channel-type", "any"], {
      pages: [pageOf("[]")]
    })
    expect(result.exitCode).toBe(0)
  })

  test("the video-filter check runs BEFORE the channel-type check", async () => {
    expectUsage(
      await search(["search", "--channel-type", "any", "--video-duration", "short"]),
      "video-specific filters require --type video"
    )
  })
})

// ---------------------------------------------------------------------------
// request assembly
// ---------------------------------------------------------------------------

describe("search — request assembly", () => {
  test("the defaults that are always sent", async () => {
    const result = await search(["search"], { pages: [pageOf("[]")] })
    expect(result.calls[0]!.resource).toBe("search")
    expect(params(result)).toEqual({
      part: "snippet",
      order: "relevance",
      safeSearch: "moderate",
      type: "video,channel,playlist"
    })
  })

  test("--parts overrides part, whitespace-only falls back", async () => {
    const custom = await search(["search", "--parts", "id"], { pages: [pageOf("[]")] })
    expect(params(custom)["part"]).toBe("id")
    const blank = await search(["search", "--parts", "  "], { pages: [pageOf("[]")] })
    expect(params(blank)["part"]).toBe("snippet")
  })

  test("every optional flag maps to its API param name", async () => {
    const result = await search(
      [
        "search",
        "--type",
        "video",
        "--channel",
        "UC1",
        "--region",
        "GB",
        "--language",
        "en",
        "--topic",
        "/m/019_rr",
        "--video-category",
        "10",
        "--video-duration",
        "short",
        "--video-caption",
        "closedCaption",
        "--video-embeddable",
        "true",
        "--video-license",
        "youtube",
        "--video-paid-product-placement",
        "true",
        "--video-syndicated",
        "true",
        "--event-type",
        "live",
        "--published-after",
        "2024-01-01T00:00:00Z",
        "--published-before",
        "2024-12-31T00:00:00Z"
      ],
      { pages: [pageOf("[]")] }
    )
    expect(params(result)).toEqual({
      part: "snippet",
      order: "relevance",
      safeSearch: "moderate",
      type: "video",
      channelId: "UC1",
      regionCode: "GB",
      relevanceLanguage: "en",
      topicId: "/m/019_rr",
      videoCategoryId: "10",
      videoDuration: "short",
      videoCaption: "closedCaption",
      videoEmbeddable: "true",
      videoLicense: "youtube",
      videoPaidProductPlacement: "true",
      videoSyndicated: "true",
      eventType: "live",
      publishedAfter: "2024-01-01T00:00:00Z",
      publishedBefore: "2024-12-31T00:00:00Z"
    })
  })

  test("--channel-type maps to channelType", async () => {
    const result = await search(["search", "--type", "channel", "--channel-type", "show"], {
      pages: [pageOf("[]")]
    })
    expect(params(result)["channelType"]).toBe("show")
  })

  test("--location and --location-radius keep their own names", async () => {
    const result = await search(
      ["search", "--type", "video", "--location", "1,2", "--location-radius", "5km"],
      { pages: [pageOf("[]")] }
    )
    expect(params(result)["location"]).toBe("1,2")
    expect(params(result)["locationRadius"]).toBe("5km")
  })

  test("an explicitly emptied default is dropped entirely", async () => {
    const result = await search(["search", "--order", "", "--safe-search", "", "--type", ""], {
      pages: [pageOf("[]")]
    })
    expect(params(result)).toEqual({ part: "snippet" })
  })

  test("search has NO --hl flag", async () => {
    const result = await search(["search", "--hl", "en"])
    // The framework rejects the unknown flag; exit 2 after main.ts's translation.
    expect(result.exitCode).toBe(2)
    expect(result.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// the kind filter
// ---------------------------------------------------------------------------

describe("searchKindFilter — the predicate itself", () => {
  const accepts = (types: string, item: unknown): boolean =>
    searchKindFilter(types)(item as never)

  test("a matching kind is accepted", () => {
    expect(accepts("video", { id: { kind: "youtube#video" } })).toBe(true)
  })

  test("a non-listed kind is rejected", () => {
    expect(accepts("video", { id: { kind: "youtube#channel" } })).toBe(false)
  })

  test("the type list is split and TRIMMED here, unlike the --type checks", () => {
    expect(accepts("video, channel", { id: { kind: "youtube#channel" } })).toBe(true)
  })

  test("a kind without the youtube# prefix is rejected", () => {
    expect(accepts("video", { id: { kind: "video" } })).toBe(false)
  })

  test("a missing id is rejected", () => {
    expect(accepts("video", { snippet: {} })).toBe(false)
  })

  test("a string id is rejected — search always returns an object id", () => {
    expect(accepts("video", { id: "abc" })).toBe(false)
  })

  test("a missing kind is rejected", () => {
    expect(accepts("video", { id: { videoId: "v" } })).toBe(false)
  })

  test("a non-string kind is rejected", () => {
    expect(accepts("video", { id: { kind: 5 } })).toBe(false)
  })
})

describe("search — the filter runs inside pagination, BEFORE --limit", () => {
  test("non-matching items are dropped from the output", async () => {
    const result = await search(["search", "--type", "video", "--format", "jsonl"], {
      pages: [pageOf(`[${item("video", "v1")},${item("channel", "c1")}]`)]
    })
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
    expect(result.stdout).toContain('"videoId":"v1"')
  })

  test("the filter reaches the page options, not just the output", async () => {
    const result = await search(["search"], { pages: [pageOf("[]")] })
    expect(typeof result.calls[0]!.page!.filter).toBe("function")
  })

  test("a page contributing ZERO items still consumes a request", async () => {
    const result = await search(["search", "--type", "video", "--all", "--limit", "1"], {
      pages: [
        // Page 1: nothing survives the filter.
        pageOf(`[${item("channel", "c1")},${item("playlist", "p1")}]`, "N"),
        pageOf(`[${item("video", "v1")}]`, "")
      ]
    })
    // 1 item emitted, but TWO requests spent.
    expect(result.stderr).toBe(summaryLine(1, 2))
  })

  test("rejected items do not count toward --limit", async () => {
    const result = await search(["search", "--type", "video", "--all", "--limit", "2"], {
      pages: [
        pageOf(`[${item("video", "v1")},${item("channel", "c1")}]`, "N"),
        pageOf(`[${item("channel", "c2")},${item("video", "v2")}]`, "")
      ]
    })
    // Two videos across two pages; the channels are invisible to the limit.
    expect(result.stderr).toBe(summaryLine(2, 2))
  })

  test("without --all exactly one request is made", async () => {
    const result = await search(["search", "--type", "video"], {
      pages: [pageOf(`[${item("video", "v1")}]`, "N")]
    })
    expect(result.calls).toHaveLength(1)
    expect(result.stderr).toBe(summaryLine(1, 1, "N"))
  })

  test("D2: a truncating limit suppresses the resume token", async () => {
    const result = await search(["search", "--type", "video", "--all", "--limit", "1"], {
      pages: [pageOf(`[${item("video", "v1")},${item("video", "v2")}]`, "N")]
    })
    expect(result.stderr).toBe(summaryLine(1, 1))
  })
})

// ---------------------------------------------------------------------------
// --fields injection and kind stripping
// ---------------------------------------------------------------------------

describe("search — items/id/kind injection and stripping", () => {
  test("no --fields sends no selector and leaves kind in place", async () => {
    const result = await search(["search", "--type", "video", "--format", "jsonl"], {
      pages: [pageOf(`[${item("video", "v1")}]`)]
    })
    expect(params(result)).not.toHaveProperty("fields")
    expect(result.stdout).toBe(
      '{"id":{"kind":"youtube#video","videoId":"v1"},"snippet":{"title":"T"}}\n'
    )
  })

  test("a non-covering selector gets items/id/kind appended", async () => {
    const result = await search(["search", "--fields", "items/snippet/title"], {
      pages: [pageOf(`[${item("video", "v1")}]`)]
    })
    expect(params(result)["fields"]).toBe("items/snippet/title,items/id/kind")
  })

  test("the injected kind is deleted from the output, id surviving", async () => {
    const result = await search(
      ["search", "--type", "video", "--fields", "items/id/videoId", "--format", "jsonl"],
      { pages: [pageOf(`[{"id":{"kind":"youtube#video","videoId":"v1"}}]`)] }
    )
    expect(params(result)["fields"]).toBe("items/id/videoId,items/id/kind")
    expect(result.stdout).toBe('{"id":{"videoId":"v1"}}\n')
  })

  test("id is dropped ENTIRELY when kind was its only key", async () => {
    const result = await search(
      ["search", "--type", "video", "--fields", "items/snippet/title", "--format", "jsonl"],
      { pages: [pageOf('[{"id":{"kind":"youtube#video"},"snippet":{"title":"T"}}]')] }
    )
    expect(result.stdout).toBe('{"snippet":{"title":"T"}}\n')
  })

  test("a selector already covering the kind is sent unchanged and NOT stripped", async () => {
    const result = await search(
      ["search", "--type", "video", "--fields", "items/id/kind", "--format", "jsonl"],
      { pages: [pageOf('[{"id":{"kind":"youtube#video"}}]')] }
    )
    expect(params(result)["fields"]).toBe("items/id/kind")
    expect(result.stdout).toBe('{"id":{"kind":"youtube#video"}}\n')
  })

  test("items/id covers the kind as an ancestor", async () => {
    const result = await search(["search", "--fields", "items/id"], {
      pages: [pageOf('[{"id":{"kind":"youtube#video"}}]')]
    })
    expect(params(result)["fields"]).toBe("items/id")
  })

  test("items(id/*,snippet) covers it through the wildcard", async () => {
    const result = await search(["search", "--fields", "items(id/*,snippet/title)"], {
      pages: [pageOf('[{"id":{"kind":"youtube#video"}}]')]
    })
    expect(params(result)["fields"]).toBe("items(id/*,snippet/title)")
  })

  test("items(id/videoId,…) does NOT cover it and triggers injection", async () => {
    const result = await search(["search", "--fields", "items(id/videoId,snippet/title)"], {
      pages: [pageOf('[{"id":{"kind":"youtube#video"}}]')]
    })
    expect(params(result)["fields"]).toBe("items(id/videoId,snippet/title),items/id/kind")
  })
})

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

describe("search — rendering", () => {
  test("the default columns", async () => {
    const result = await search(["search", "--format", "tsv", "--type", "video"], {
      pages: [pageOf(`[${item("video", "v1", "Title")}]`)]
    })
    expect(result.stdout).toBe(
      "ID.KIND\tID.VIDEOID\tID.CHANNELID\tID.PLAYLISTID\tSNIPPET.TITLE\n" +
        "youtube#video\tv1\t\t\tTitle\n"
    )
  })

  test("--columns overrides them", async () => {
    const result = await search(["search", "--format", "tsv", "--columns", "snippet.title"], {
      pages: [pageOf(`[${item("video", "v1", "Title")}]`)]
    })
    expect(result.stdout).toBe("SNIPPET.TITLE\nTitle\n")
  })

  test("--quiet drops the summary", async () => {
    const result = await search(["search", "--quiet"], { pages: [pageOf(`[${item("video", "v")}]`)] })
    expect(result.stderr).toBe("")
  })

  test("json format never emits the summary", async () => {
    const result = await search(["search", "--format", "json"], {
      pages: [pageOf(`[${item("video", "v")}]`)]
    })
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain('"requests": 1')
  })

  test("an empty result set still renders the header", async () => {
    const result = await search(["search", "--format", "tsv", "--columns", "id"], {
      pages: [pageOf("[]")]
    })
    expect(result.stdout).toBe("ID\n")
    // tsv, so no summary — the line is table-only.
    expect(result.stderr).toBe("")
  })

  test("an empty result set on TABLE format still reports 1 request", async () => {
    const result = await search(["search", "--columns", "id"], { pages: [pageOf("[]")] })
    expect(result.stderr).toBe(summaryLine(0, 1))
  })
})

import { describe, expect, test } from "bun:test"
import {
  channelActivitiesCommand,
  channelCommand,
  channelGetCommand,
  channelSectionsCommand,
  channelUploadsCommand
} from "./channel.ts"
import { expectUsage, pageOf, responseOf, runCli, summaryLine } from "./p8aHarness.testutil.ts"
import type { ApiScript, RunResult } from "./p8aHarness.testutil.ts"

/** The five-parameter Command generic differs per command; the harness only mounts it. */
const cmd = (c: unknown) => c as never

const get = (argv: ReadonlyArray<string>, script: ApiScript = {}): Promise<RunResult> =>
  runCli(cmd(channelGetCommand), argv, { script })

const activities = (argv: ReadonlyArray<string>, script: ApiScript = {}): Promise<RunResult> =>
  runCli(cmd(channelActivitiesCommand), argv, { script })

const sections = (argv: ReadonlyArray<string>, script: ApiScript = {}): Promise<RunResult> =>
  runCli(cmd(channelSectionsCommand), argv, { script })

const uploads = (argv: ReadonlyArray<string>, script: ApiScript = {}): Promise<RunResult> =>
  runCli(cmd(channelUploadsCommand), argv, { script })

/** A `channels` lookup response carrying an uploads playlist id. */
const uploadsLookup = (playlistId = "UUxyz") =>
  responseOf(
    `[{"id":"UC1","contentDetails":{"relatedPlaylists":{"uploads":${JSON.stringify(playlistId)}}}}]`
  )

/** A free channel reference: a bare UC… id costs 0 resolution requests. */
const freeChannel = [{ id: "UC1", requests: 0 }]

/** A @handle costs 1 resolution request. */
const paidChannel = [{ id: "UC1", requests: 1 }]

// ---------------------------------------------------------------------------
// channel get
// ---------------------------------------------------------------------------

describe("channel get — validation", () => {
  test("at least one reference is required", async () => {
    expectUsage(await get(["get"]), "expected at least 1 argument(s), received 0")
  })

  test("owner-only parts are rejected", async () => {
    expectUsage(
      await get(["get", "--parts", "auditDetails", "UC1"]),
      'part "auditDetails" requires owner/OAuth access and is not supported'
    )
    expectUsage(
      await get(["get", "--parts", "snippet,contentOwnerDetails", "UC1"]),
      'part "contentOwnerDetails" requires owner/OAuth access and is not supported'
    )
  })

  test("the video-only forbidden parts are NOT forbidden here", async () => {
    const result = await get(["get", "--parts", "fileDetails", "UC1"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: freeChannel
    })
    expect(result.exitCode).toBe(0)
  })

  test("the arg count is checked before the parts", async () => {
    expectUsage(
      await get(["get", "--parts", "auditDetails"]),
      "expected at least 1 argument(s), received 0"
    )
  })
})

describe("channel get — resolution and request accounting", () => {
  test("every reference is resolved, in order", async () => {
    const result = await get(["get", "@a", "@b"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: paidChannel
    })
    const resolves = result.calls.filter((c) => c.kind === "resolveChannel")
    expect(resolves.map((c) => c.resource)).toEqual(["@a", "@b"])
  })

  test("a bare UC id costs 0 resolution requests: total is just the batch", async () => {
    const result = await get(["get", "UC1"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: freeChannel
    })
    expect(result.stderr).toBe(summaryLine(1, 1))
  })

  test("a @handle costs 1: total is resolution + batch", async () => {
    const result = await get(["get", "@handle"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: paidChannel
    })
    expect(result.stderr).toBe(summaryLine(1, 2))
  })

  test("two handles cost 2 resolutions plus 1 batch", async () => {
    const result = await get(["get", "@a", "@b"], {
      get: [responseOf('[{"id":"UC1"},{"id":"UC1"}]')],
      channels: paidChannel
    })
    expect(result.stderr).toBe(summaryLine(2, 3))
  })

  test("the RESOLVED ids are what get sent, not the references", async () => {
    const result = await get(["get", "@handle"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: paidChannel
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params["id"]).toBe("UC1")
  })
})

describe("channel get — request assembly and batching", () => {
  test("the default parts", async () => {
    const result = await get(["get", "UC1"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: freeChannel
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.resource).toBe("channels")
    expect(fetch.params).toEqual({ part: "snippet,contentDetails,statistics", id: "UC1" })
  })

  test("--hl and --fields are forwarded", async () => {
    const result = await get(["get", "--hl", "de", "--fields", "items/id", "UC1"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: freeChannel
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params["hl"]).toBe("de")
    expect(fetch.params["fields"]).toBe("items/id")
  })

  test("51 references batch into 2 requests of 50 + 1", async () => {
    const references = Array.from({ length: 51 }, (_, i) => `UC${i}`)
    const returned = `[${references.map((id) => `{"id":"${id}"}`).join(",")}]`
    const result = await get(["get", ...references], {
      get: [responseOf(returned)],
      channels: references.map((id) => ({ id, requests: 0 }))
    })
    const fetches = result.calls.filter((c) => c.kind === "get")
    expect(fetches).toHaveLength(2)
    expect(fetches[0]!.params["id"]!.split(",")).toHaveLength(50)
    expect(fetches[1]!.params["id"]!.split(",")).toHaveLength(1)
  })
})

describe("channel get — validateRequestedItems and --fields", () => {
  test("a missing channel is exit 4 with the `channels` resource name", async () => {
    const result = await get(["get", "UC1", "UC2"], {
      get: [responseOf('[{"id":"UC1"}]')],
      channels: [
        { id: "UC1", requests: 0 },
        { id: "UC2", requests: 0 }
      ]
    })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe("channels not found: UC2")
  })

  test("the equal-cardinality escape hatch applies here too", async () => {
    const result = await get(["get", "--fields", "items/snippet/title", "UC1", "UC2"], {
      get: [responseOf('[{"snippet":{"title":"a"}},{"snippet":{"title":"b"}}]')],
      channels: [
        { id: "UC1", requests: 0 },
        { id: "UC2", requests: 0 }
      ]
    })
    expect(result.exitCode).toBe(0)
  })

  test("an injected items/id is stripped from the output", async () => {
    const result = await get(
      ["get", "--fields", "items/snippet/title", "--format", "jsonl", "UC1"],
      {
        get: [responseOf('[{"id":"UC1","snippet":{"title":"T"}}]')],
        channels: freeChannel
      }
    )
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params["fields"]).toBe("items/snippet/title,items/id")
    expect(result.stdout).toBe('{"snippet":{"title":"T"}}\n')
  })

  test("the default columns", async () => {
    const result = await get(["get", "--format", "tsv", "UC1"], {
      get: [
        responseOf(
          '[{"id":"UC1","snippet":{"title":"T"},"statistics":{"subscriberCount":"1","videoCount":"2","viewCount":"3"}}]'
        )
      ],
      channels: freeChannel
    })
    expect(result.stdout).toBe(
      "ID\tSNIPPET.TITLE\tSTATISTICS.SUBSCRIBERCOUNT\tSTATISTICS.VIDEOCOUNT\tSTATISTICS.VIEWCOUNT\n" +
        "UC1\tT\t1\t2\t3\n"
    )
  })
})

// ---------------------------------------------------------------------------
// channel activities
// ---------------------------------------------------------------------------

describe("channel activities — validation", () => {
  test("exactly one channel is required", async () => {
    expectUsage(await activities(["activities"]), "expected 1 argument(s), received 0")
    expectUsage(await activities(["activities", "a", "b"]), "expected 1 argument(s), received 2")
  })

  test("--page-size bounds are 1..50", async () => {
    expectUsage(
      await activities(["activities", "--page-size", "51", "UC1"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("bad timestamps are rejected BEFORE resolving the channel", async () => {
    expectUsage(
      await activities(["activities", "--published-after", "nope", "UC1"]),
      "--published-after must be an RFC 3339 timestamp"
    )
    expectUsage(
      await activities(["activities", "--published-before", "nope", "UC1"]),
      "--published-before must be an RFC 3339 timestamp"
    )
  })

  test("pagination is checked before the timestamps", async () => {
    expectUsage(
      await activities(["activities", "--page-size", "99", "--published-after", "nope", "UC1"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("after is checked before before", async () => {
    expectUsage(
      await activities(["activities", "--published-after", "x", "--published-before", "y", "UC1"]),
      "--published-after must be an RFC 3339 timestamp"
    )
  })

  test("a valid RFC 3339 timestamp passes through", async () => {
    const result = await activities(
      ["activities", "--published-after", "2024-01-01T00:00:00Z", "UC1"],
      { pages: [pageOf('[{"id":"a"}]')], channels: freeChannel }
    )
    expect(result.exitCode).toBe(0)
    const list = result.calls.find((c) => c.kind === "list")!
    expect(list.params["publishedAfter"]).toBe("2024-01-01T00:00:00Z")
  })
})

describe("channel activities — requests and assembly", () => {
  test("the resolved channelId, default parts, and page options", async () => {
    const result = await activities(["activities", "UC1"], {
      pages: [pageOf('[{"id":"a"}]')],
      channels: freeChannel
    })
    const list = result.calls.find((c) => c.kind === "list")!
    expect(list.resource).toBe("activities")
    expect(list.params).toEqual({ part: "snippet,contentDetails", channelId: "UC1" })
    expect(list.page!.pageSize).toBe(25)
  })

  test("the resolution cost is added to the list's own count", async () => {
    const result = await activities(["activities", "@handle"], {
      pages: [pageOf('[{"id":"a"}]')],
      channels: paidChannel
    })
    // 1 list request + 1 resolution.
    expect(result.stderr).toBe(summaryLine(1, 2))
  })

  test("a free UC id adds nothing", async () => {
    const result = await activities(["activities", "UC1"], {
      pages: [pageOf('[{"id":"a"}]')],
      channels: freeChannel
    })
    expect(result.stderr).toBe(summaryLine(1, 1))
  })

  test("--all accumulates page requests plus resolution", async () => {
    const result = await activities(["activities", "--all", "@handle"], {
      pages: [pageOf('[{"id":"a"}]', "N"), pageOf('[{"id":"b"}]')],
      channels: paidChannel
    })
    expect(result.stderr).toBe(summaryLine(2, 3))
  })

  test("--fields is passed through with NO injection", async () => {
    const result = await activities(["activities", "--fields", "items/snippet/title", "UC1"], {
      pages: [pageOf('[{"snippet":{"title":"T"}}]')],
      channels: freeChannel
    })
    const list = result.calls.find((c) => c.kind === "list")!
    expect(list.params["fields"]).toBe("items/snippet/title")
  })

  test("the default columns", async () => {
    const result = await activities(["activities", "--format", "tsv", "UC1"], {
      pages: [pageOf('[{"id":"a","snippet":{"publishedAt":"P","type":"upload","title":"T"}}]')],
      channels: freeChannel
    })
    expect(result.stdout).toBe(
      "ID\tSNIPPET.PUBLISHEDAT\tSNIPPET.TYPE\tSNIPPET.TITLE\na\tP\tupload\tT\n"
    )
  })
})

// ---------------------------------------------------------------------------
// channel sections
// ---------------------------------------------------------------------------

describe("channel sections — the exactly-one rule", () => {
  test("neither CHANNEL nor --id fails", async () => {
    expectUsage(await sections(["sections"]), "provide exactly one of CHANNEL or --id")
  })

  test("BOTH CHANNEL and --id fails", async () => {
    expectUsage(
      await sections(["sections", "--id", "S1", "UC1"]),
      "provide exactly one of CHANNEL or --id"
    )
  })

  test("more than one positional is an arg-count error first", async () => {
    expectUsage(await sections(["sections", "a", "b"]), "expected at most 1 argument(s), received 2")
  })

  test("CHANNEL alone works", async () => {
    const result = await sections(["sections", "UC1"], {
      get: [responseOf('[{"id":"S1"}]')],
      channels: freeChannel
    })
    expect(result.exitCode).toBe(0)
  })

  test("--id alone works", async () => {
    const result = await sections(["sections", "--id", "S1"], { get: [responseOf('[{"id":"S1"}]')] })
    expect(result.exitCode).toBe(0)
  })
})

describe("channel sections — requests and assembly", () => {
  test("--id sends id and never resolves a channel", async () => {
    const result = await sections(["sections", "--id", "S1,S2"], {
      get: [responseOf('[{"id":"S1"}]')]
    })
    expect(result.calls.filter((c) => c.kind === "resolveChannel")).toHaveLength(0)
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.resource).toBe("channelSections")
    expect(fetch.params).toEqual({ part: "snippet,contentDetails", id: "S1,S2" })
    // A flat 1 request: no resolution cost.
    expect(result.stderr).toBe(summaryLine(1, 1))
  })

  test("CHANNEL sends channelId and pays the resolution cost", async () => {
    const result = await sections(["sections", "@handle"], {
      get: [responseOf('[{"id":"S1"}]')],
      channels: paidChannel
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params["channelId"]).toBe("UC1")
    expect(fetch.params).not.toHaveProperty("id")
    expect(result.stderr).toBe(summaryLine(1, 2))
  })

  test("a free UC id costs a flat 1", async () => {
    const result = await sections(["sections", "UC1"], {
      get: [responseOf('[{"id":"S1"}]')],
      channels: freeChannel
    })
    expect(result.stderr).toBe(summaryLine(1, 1))
  })

  test("it is a Get, so no pagination params are sent", async () => {
    const result = await sections(["sections", "--id", "S1"], {
      get: [responseOf('[{"id":"S1"}]')]
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params).not.toHaveProperty("maxResults")
    expect(fetch.params).not.toHaveProperty("pageToken")
    expect(fetch.page).toBeUndefined()
  })

  test("--hl and --fields are forwarded", async () => {
    const result = await sections(["sections", "--id", "S1", "--hl", "es", "--fields", "items/id"], {
      get: [responseOf('[{"id":"S1"}]')]
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params["hl"]).toBe("es")
    expect(fetch.params["fields"]).toBe("items/id")
  })

  test("sections does NOT strip ids — there is no injection here", async () => {
    const result = await sections(["sections", "--id", "S1", "--fields", "items/snippet", "--format", "jsonl"], {
      get: [responseOf('[{"id":"S1","snippet":{"type":"t"}}]')]
    })
    const fetch = result.calls.find((c) => c.kind === "get")!
    expect(fetch.params["fields"]).toBe("items/snippet")
    expect(result.stdout).toBe('{"id":"S1","snippet":{"type":"t"}}\n')
  })

  test("the default columns", async () => {
    const result = await sections(["sections", "--id", "S1", "--format", "tsv"], {
      get: [responseOf('[{"id":"S1","snippet":{"type":"singlePlaylist","position":0,"title":"T"}}]')]
    })
    expect(result.stdout).toBe(
      "ID\tSNIPPET.TYPE\tSNIPPET.POSITION\tSNIPPET.TITLE\nS1\tsinglePlaylist\t0\tT\n"
    )
  })
})

// ---------------------------------------------------------------------------
// channel uploads
// ---------------------------------------------------------------------------

describe("channel uploads — validation", () => {
  test("exactly one channel is required", async () => {
    expectUsage(await uploads(["uploads"]), "expected 1 argument(s), received 0")
    expectUsage(await uploads(["uploads", "a", "b"]), "expected 1 argument(s), received 2")
  })

  test("its --page-size DEFAULT is 50, not 25", async () => {
    const result = await uploads(["uploads", "UC1"], {
      get: [uploadsLookup()],
      pages: [pageOf('[{"snippet":{"position":0}}]')],
      channels: freeChannel
    })
    const list = result.calls.find((c) => c.kind === "list")!
    expect(list.page!.pageSize).toBe(50)
  })

  test("its max is still 50", async () => {
    expectUsage(
      await uploads(["uploads", "--page-size", "51", "UC1"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("--limit cannot be negative", async () => {
    expectUsage(await uploads(["uploads", "--limit=-1", "UC1"]), "--limit cannot be negative")
  })
})

describe("channel uploads — the +1 channels lookup", () => {
  test("the lookup sends ONLY part=contentDetails and the resolved id", async () => {
    const result = await uploads(["uploads", "--parts", "snippet", "--fields", "items/x", "UC1"], {
      get: [uploadsLookup()],
      pages: [pageOf('[{"snippet":{"position":0}}]')],
      channels: freeChannel
    })
    const lookup = result.calls.find((c) => c.kind === "get")!
    expect(lookup.resource).toBe("channels")
    // The user's --parts and --fields must NOT leak into this internal probe.
    expect(lookup.params).toEqual({ part: "contentDetails", id: "UC1" })
  })

  test("a free UC id costs 1 lookup + 1 list", async () => {
    const result = await uploads(["uploads", "UC1"], {
      get: [uploadsLookup()],
      pages: [pageOf('[{"snippet":{"position":0}}]')],
      channels: freeChannel
    })
    expect(result.stderr).toBe(summaryLine(1, 2))
  })

  test("a @handle costs 1 resolution + 1 lookup + 1 list", async () => {
    const result = await uploads(["uploads", "@handle"], {
      get: [uploadsLookup()],
      pages: [pageOf('[{"snippet":{"position":0}}]')],
      channels: paidChannel
    })
    expect(result.stderr).toBe(summaryLine(1, 3))
  })

  test("--all adds each extra page on top", async () => {
    const result = await uploads(["uploads", "--all", "@handle"], {
      get: [uploadsLookup()],
      pages: [pageOf('[{"snippet":{"position":0}}]', "N"), pageOf('[{"snippet":{"position":1}}]')],
      channels: paidChannel
    })
    // 1 resolution + 1 lookup + 2 list pages.
    expect(result.stderr).toBe(summaryLine(2, 4))
  })

  test("the uploads playlist id becomes playlistId", async () => {
    const result = await uploads(["uploads", "UC1"], {
      get: [uploadsLookup("UUmyuploads")],
      pages: [pageOf('[{"snippet":{"position":0}}]')],
      channels: freeChannel
    })
    const list = result.calls.find((c) => c.kind === "list")!
    expect(list.resource).toBe("playlistItems")
    expect(list.params["playlistId"]).toBe("UUmyuploads")
    expect(list.params["part"]).toBe("snippet,contentDetails")
  })

  test("--parts and --fields DO reach the playlistItems call", async () => {
    const result = await uploads(["uploads", "--parts", "snippet", "--fields", "items/x", "UC1"], {
      get: [uploadsLookup()],
      pages: [pageOf('[{"snippet":{"position":0}}]')],
      channels: freeChannel
    })
    const list = result.calls.find((c) => c.kind === "list")!
    expect(list.params["part"]).toBe("snippet")
    expect(list.params["fields"]).toBe("items/x")
  })
})

describe("channel uploads — failure modes", () => {
  test("an empty channels lookup is exit 4, quoting the ORIGINAL reference", async () => {
    const result = await uploads(["uploads", "@handle"], {
      get: [responseOf("[]")],
      channels: paidChannel
    })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe('channel "@handle" not found')
  })

  test("no relatedPlaylists is exit 4 with the uploads message", async () => {
    const result = await uploads(["uploads", "@handle"], {
      get: [responseOf('[{"id":"UC1","contentDetails":{}}]')],
      channels: paidChannel
    })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe('channel "@handle" has no public uploads playlist')
  })

  test("an EMPTY uploads id is also 'no public uploads playlist'", async () => {
    const result = await uploads(["uploads", "UC1"], {
      get: [uploadsLookup("")],
      channels: freeChannel
    })
    expect(result.exitCode).toBe(4)
    expect(result.message).toBe('channel "UC1" has no public uploads playlist')
  })

  test("a non-string uploads value is treated as absent", async () => {
    const result = await uploads(["uploads", "UC1"], {
      get: [responseOf('[{"contentDetails":{"relatedPlaylists":{"uploads":42}}}]')],
      channels: freeChannel
    })
    expect(result.exitCode).toBe(4)
  })

  test("neither failure issues a playlistItems request", async () => {
    const result = await uploads(["uploads", "UC1"], {
      get: [responseOf("[]")],
      channels: freeChannel
    })
    expect(result.calls.filter((c) => c.kind === "list")).toHaveLength(0)
  })

  test("the default columns on success", async () => {
    const result = await uploads(["uploads", "--format", "tsv", "UC1"], {
      get: [uploadsLookup()],
      pages: [
        pageOf(
          '[{"snippet":{"position":0,"title":"T","publishedAt":"P"},"contentDetails":{"videoId":"V"}}]'
        )
      ],
      channels: freeChannel
    })
    expect(result.stdout).toBe(
      "SNIPPET.POSITION\tCONTENTDETAILS.VIDEOID\tSNIPPET.TITLE\tSNIPPET.PUBLISHEDAT\n0\tV\tT\tP\n"
    )
  })
})

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

describe("channel — the group command", () => {
  test("bare `oytc channel` prints help and exits 0", async () => {
    const result = await runCli(cmd(channelCommand), ["channel"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(0)
  })

  test("every leaf is reachable through the group", async () => {
    for (const [argv, script] of [
      [["channel", "get", "UC1"], { get: [responseOf('[{"id":"UC1"}]')], channels: freeChannel }],
      [["channel", "activities", "UC1"], { pages: [pageOf("[]")], channels: freeChannel }],
      [["channel", "sections", "--id", "S1"], { get: [responseOf("[]")] }],
      [
        ["channel", "uploads", "UC1"],
        { get: [uploadsLookup()], pages: [pageOf("[]")], channels: freeChannel }
      ]
    ] as ReadonlyArray<readonly [ReadonlyArray<string>, ApiScript]>) {
      const result = await runCli(cmd(channelCommand), argv, { script })
      expect(result.exitCode).toBe(0)
    }
  })
})

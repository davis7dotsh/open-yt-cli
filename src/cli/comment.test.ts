/**
 * `oytc comment {get,replies,threads}`.
 *
 * The two facts this suite exists to pin:
 *   - `comment get` batches in **100s**, not 50s.
 *   - `--order` is compared against the LITERAL DEFAULT `"time"`, so
 *     `--id X --order time` passes and `--id X --order ""` fails.
 *
 * Both, plus every message below, were captured from `/tmp/oytc-ref`.
 */

import { describe, expect, test } from "bun:test"
import { NotFoundError } from "../domain/errors.ts"
import { commentCommand } from "./comment.ts"
import { expectUsage, listOf, responseOf, runCli, summaryLine } from "./harness.testutil.ts"

const run = (argv: ReadonlyArray<string>, options?: Parameters<typeof runCli>[2]) =>
  runCli(commentCommand, argv, options)

// ---------------------------------------------------------------------------
// comment get
// ---------------------------------------------------------------------------

describe("comment get", () => {
  test("requires at least one id, before any request", async () => {
    const result = await run(["comment", "get"])
    expectUsage(result, "expected at least 1 argument(s), received 0")
    expect(result.calls).toEqual([])
  })

  test("the arity check precedes the --text-format enum", async () => {
    const result = await run(["comment", "get", "--text-format", "bogus"])
    expectUsage(result, "expected at least 1 argument(s), received 0")
  })

  test("rejects an unknown --text-format", async () => {
    const result = await run(["comment", "get", "C1", "--text-format", "bogus"])
    expectUsage(result, "--text-format must be one of: plainText, html")
    expect(result.calls).toEqual([])
  })

  test("accepts both allowed text formats", async () => {
    for (const format of ["plainText", "html"]) {
      const result = await run(["comment", "get", "C1", "--text-format", format], {
        script: { get: [responseOf(`[{"id":"C1"}]`)] }
      })
      expect(result.exitCode).toBe(0)
      expect(result.calls[0]!.params["textFormat"]).toBe(format)
    }
  })

  test("defaults part to snippet and textFormat to plainText", async () => {
    const result = await run(["comment", "get", "C1"], {
      script: { get: [responseOf(`[{"id":"C1"}]`)] }
    })
    expect(result.calls[0]!.resource).toBe("comments")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet",
      id: "C1",
      textFormat: "plainText"
    })
  })

  test("BATCHES IN 100s, not 50s", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `C${index}`)
    const script = {
      get: [
        responseOf(JSON.stringify(ids.slice(0, 100).map((id) => ({ id })))),
        responseOf(JSON.stringify(ids.slice(100, 200).map((id) => ({ id })))),
        responseOf(JSON.stringify(ids.slice(200).map((id) => ({ id }))))
      ]
    }
    const result = await run(["comment", "get", ...ids], { script })
    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(3)
    expect(result.calls[0]!.params["id"]!.split(",")).toHaveLength(100)
    expect(result.calls[1]!.params["id"]!.split(",")).toHaveLength(100)
    expect(result.calls[2]!.params["id"]!.split(",")).toHaveLength(50)
    expect(result.stderr).toBe(summaryLine(250, 3))
  })

  test("exactly 100 ids is a single request", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `C${index}`)
    const result = await run(["comment", "get", ...ids], {
      script: { get: [responseOf(JSON.stringify(ids.map((id) => ({ id }))))] }
    })
    expect(result.calls).toHaveLength(1)
  })

  test("101 ids is two requests", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `C${index}`)
    const result = await run(["comment", "get", ...ids], {
      script: {
        get: [
          responseOf(JSON.stringify(ids.slice(0, 100).map((id) => ({ id })))),
          responseOf(JSON.stringify(ids.slice(100).map((id) => ({ id }))))
        ]
      }
    })
    expect(result.calls).toHaveLength(2)
    expect(result.calls[1]!.params["id"]).toBe("C100")
  })

  test("widens --fields to keep items/id and strips it before rendering", async () => {
    const result = await run(["comment", "get", "C1", "--fields", "items/snippet"], {
      script: { get: [responseOf(`[{"id":"C1","snippet":{"textDisplay":"hi"}}]`)] }
    })
    expect(result.calls[0]!.params["fields"]).toBe("items/snippet,items/id")
    expect(result.stdout).not.toContain("C1")
    expect(result.stdout).toContain("hi")
  })

  test("a missing id is a NotFoundError with exit 4", async () => {
    const result = await run(["comment", "get", "C1", "C2"], {
      script: { get: [responseOf(`[{"id":"C1"}]`)] }
    })
    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(result.message).toBe("comments not found: C2")
    expect(result.exitCode).toBe(4)
  })

  test("has no pagination flags and no --hl", async () => {
    for (const flag of [
      ["--page-size", "5"],
      ["--hl", "en"],
      ["--all"]
    ]) {
      const result = await run(["comment", "get", "C1", ...flag])
      expect(result.exitCode).toBe(2)
      expect(result.calls).toEqual([])
    }
  })

  test("renders the shared comment columns", async () => {
    const result = await run(["comment", "get", "C1"], {
      script: {
        get: [
          responseOf(
            `[{"id":"C1","snippet":{"authorDisplayName":"A","textDisplay":"T","likeCount":2,"publishedAt":"2024-01-01T00:00:00Z"}}]`
          )
        ]
      }
    })
    // Byte-for-byte against `output.Render(..., Format: "table")` in Go.
    expect(result.stdout).toBe(
      "ID  SNIPPET.AUTHORDISPLAYNAME  SNIPPET.TEXTDISPLAY  SNIPPET.LIKECOUNT  SNIPPET.PUBLISHEDAT\n" +
        "C1  A                          T                    2                  2024-01-01T00:00:00Z\n"
    )
  })
})

// ---------------------------------------------------------------------------
// comment replies
// ---------------------------------------------------------------------------

describe("comment replies", () => {
  test("requires exactly one parent id", async () => {
    expectUsage(await run(["comment", "replies"]), "expected 1 argument(s), received 0")
    expectUsage(await run(["comment", "replies", "a", "b"]), "expected 1 argument(s), received 2")
  })

  test("the arity check precedes the page-size bound", async () => {
    const result = await run(["comment", "replies", "--page-size", "999"])
    expectUsage(result, "expected 1 argument(s), received 0")
  })

  test("page size defaults to 20", async () => {
    const result = await run(["comment", "replies", "C1"], { script: { list: [listOf("[]")] } })
    expect(result.calls[0]!.page?.pageSize).toBe(20)
  })

  test("page size maxes at 100, NOT 50", async () => {
    const ok = await run(["comment", "replies", "C1", "--page-size", "100"], {
      script: { list: [listOf("[]")] }
    })
    expect(ok.exitCode).toBe(0)
    expect(ok.calls[0]!.page?.pageSize).toBe(100)

    const over = await run(["comment", "replies", "C1", "--page-size", "101"])
    expectUsage(over, "--page-size must be between 1 and 100")
  })

  test("page size 0 is rejected", async () => {
    expectUsage(
      await run(["comment", "replies", "C1", "--page-size", "0"]),
      "--page-size must be between 1 and 100"
    )
  })

  test("the page-size bound precedes the --text-format enum", async () => {
    const result = await run([
      "comment",
      "replies",
      "C1",
      "--text-format",
      "bogus",
      "--page-size",
      "101"
    ])
    expectUsage(result, "--page-size must be between 1 and 100")
  })

  test("--limit cannot be negative, and that precedes --text-format", async () => {
    const result = await run([
      "comment",
      "replies",
      "C1",
      "--limit=-1",
      "--text-format",
      "bogus"
    ])
    expectUsage(result, "--limit cannot be negative")
  })

  test("rejects an unknown --text-format", async () => {
    expectUsage(
      await run(["comment", "replies", "C1", "--text-format", "bogus"]),
      "--text-format must be one of: plainText, html"
    )
  })

  test("assembles parentId and forwards textFormat and fields", async () => {
    const result = await run(
      ["comment", "replies", "C1", "--text-format", "html", "--fields", "items"],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.resource).toBe("comments")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet",
      parentId: "C1",
      textFormat: "html",
      fields: "items"
    })
  })

  test("--parts overrides the default part", async () => {
    const result = await run(["comment", "replies", "C1", "--parts", "id"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params["part"]).toBe("id")
  })

  test("has no --hl flag", async () => {
    const result = await run(["comment", "replies", "C1", "--hl", "en"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// comment threads
// ---------------------------------------------------------------------------

describe("comment threads", () => {
  test("takes no positional arguments", async () => {
    expectUsage(await run(["comment", "threads", "extra"]), "expected 0 argument(s), received 1")
  })

  test("the arity check precedes the page-size bound", async () => {
    const result = await run(["comment", "threads", "extra", "--page-size", "999"])
    expectUsage(result, "expected 0 argument(s), received 1")
  })

  test("page size defaults to 20 and maxes at 100", async () => {
    const ok = await run(["comment", "threads", "--video", "V1"], {
      script: { list: [listOf("[]")] }
    })
    expect(ok.calls[0]!.page?.pageSize).toBe(20)

    expectUsage(
      await run(["comment", "threads", "--video", "V1", "--page-size", "101"]),
      "--page-size must be between 1 and 100"
    )
  })

  test("the page-size bound precedes every semantic check", async () => {
    // No filter is set AND --order is bogus, yet the page size still wins.
    const result = await run(["comment", "threads", "--order", "bogus", "--page-size", "999"])
    expectUsage(result, "--page-size must be between 1 and 100")
  })

  test("--text-format is checked before --order", async () => {
    const result = await run([
      "comment",
      "threads",
      "--order",
      "bogus",
      "--text-format",
      "bogus"
    ])
    expectUsage(result, "--text-format must be one of: plainText, html")
  })

  test("rejects an unknown --order with the golden message", async () => {
    const result = await run(["comment", "threads", "--order", "bogus"])
    expectUsage(result, "--order must be one of: time, relevance")
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("--order is checked before the filter XOR", async () => {
    // Both would fail; --order comes first in Go's RunE.
    const result = await run(["comment", "threads", "--order", "bogus", "--video", "V", "--channel", "C"])
    expectUsage(result, "--order must be one of: time, relevance")
  })

  test("requires exactly one of --video, --channel or --id", async () => {
    expectUsage(
      await run(["comment", "threads"]),
      "provide exactly one of --video, --channel, or --id"
    )
    expectUsage(
      await run(["comment", "threads", "--video", "V", "--channel", "C"]),
      "provide exactly one of --video, --channel, or --id"
    )
    expectUsage(
      await run(["comment", "threads", "--video", "V", "--channel", "C", "--id", "I"]),
      "provide exactly one of --video, --channel, or --id"
    )
  })

  test("a valid --order alone still fails the filter check", async () => {
    expectUsage(
      await run(["comment", "threads", "--order", "relevance"]),
      "provide exactly one of --video, --channel, or --id"
    )
  })

  test("--id with a non-default --order is rejected", async () => {
    expectUsage(
      await run(["comment", "threads", "--id", "T1", "--order", "relevance"]),
      "--order and --search are incompatible with --id"
    )
  })

  test("--id with --search is rejected", async () => {
    expectUsage(
      await run(["comment", "threads", "--id", "T1", "--search", "foo"]),
      "--order and --search are incompatible with --id"
    )
  })

  test("LITERAL DEFAULT: --id with an explicit --order time is ACCEPTED", async () => {
    const result = await run(["comment", "threads", "--id", "T1", "--order", "time"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.params["order"]).toBe("time")
  })

  test("LITERAL DEFAULT: --id with an empty --order is REJECTED", async () => {
    // "" passes validateEnum but is != "time", so the --id check fires.
    expectUsage(
      await run(["comment", "threads", "--id", "T1", "--order="]),
      "--order and --search are incompatible with --id"
    )
  })

  test("--id alone is accepted and sends id, not videoId", async () => {
    const result = await run(["comment", "threads", "--id", "T1,T2"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.resource).toBe("commentThreads")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,replies",
      id: "T1,T2",
      order: "time",
      textFormat: "plainText"
    })
  })

  test("--video maps to videoId", async () => {
    const result = await run(["comment", "threads", "--video", "V1", "--search", "hi"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,replies",
      videoId: "V1",
      order: "time",
      searchTerms: "hi",
      textFormat: "plainText"
    })
  })

  test("--channel maps to allThreadsRelatedToChannelId", async () => {
    const result = await run(["comment", "threads", "--channel", "UC1"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params["allThreadsRelatedToChannelId"]).toBe("UC1")
    expect(result.calls[0]!.params["channelId"]).toBeUndefined()
  })

  test("the default part is snippet,replies", async () => {
    const result = await run(["comment", "threads", "--video", "V1"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params["part"]).toBe("snippet,replies")
  })

  test("renders the thread default columns", async () => {
    const result = await run(["comment", "threads", "--video", "V1"], {
      script: {
        list: [
          listOf(
            `[{"id":"T1","snippet":{"topLevelComment":{"snippet":{"authorDisplayName":"A","textDisplay":"D"}},"totalReplyCount":4}}]`
          )
        ]
      }
    })
    // Byte-for-byte against `output.Render(..., Format: "table")` in Go.
    expect(result.stdout).toBe(
      "ID  SNIPPET.TOPLEVELCOMMENT.SNIPPET.AUTHORDISPLAYNAME  SNIPPET.TOPLEVELCOMMENT.SNIPPET.TEXTDISPLAY  SNIPPET.TOTALREPLYCOUNT\n" +
        "T1  A                                                  D                                            4\n"
    )
  })

  test("has no --hl flag", async () => {
    const result = await run(["comment", "threads", "--video", "V1", "--hl", "en"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// group command
// ---------------------------------------------------------------------------

describe("the comment group", () => {
  test("bare `oytc comment` prints help and exits 0", async () => {
    const result = await run(["comment"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
  })
})

/**
 * `oytc subscription list`.
 *
 * Pins the RunE check order — parts, then order, then the channel/id XOR, then
 * the `--id` incompatibility — and the literal-default `--order` comparison
 * against `"relevance"`. Every message came from `/tmp/oytc-ref`.
 */

import { describe, expect, test } from "bun:test"
import { subscriptionCommand } from "./subscription.ts"
import { expectUsage, listOf, runCli } from "./harness.testutil.ts"

const run = (argv: ReadonlyArray<string>, options?: Parameters<typeof runCli>[2]) =>
  runCli(subscriptionCommand, argv, options)

describe("subscription list", () => {
  test("takes no positional arguments", async () => {
    expectUsage(await run(["subscription", "list", "extra"]), "expected 0 argument(s), received 1")
  })

  test("page size defaults to 25 and maxes at 50", async () => {
    const ok = await run(["subscription", "list", "--channel", "UC1"], {
      script: { list: [listOf("[]")] }
    })
    expect(ok.calls[0]!.page?.pageSize).toBe(25)

    expectUsage(
      await run(["subscription", "list", "--channel", "UC1", "--page-size", "51"]),
      "--page-size must be between 1 and 50"
    )
  })

  test("the page-size bound precedes every semantic check", async () => {
    // Bad --order, bad --parts and no filter, yet the page size still wins.
    const result = await run([
      "subscription",
      "list",
      "--order",
      "bogus",
      "--parts",
      "subscriberSnippet",
      "--page-size",
      "999"
    ])
    expectUsage(result, "--page-size must be between 1 and 50")
  })

  test("--limit cannot be negative", async () => {
    expectUsage(
      await run(["subscription", "list", "--channel", "UC1", "--limit=-1"]),
      "--limit cannot be negative"
    )
  })

  test("rejects the owner-only subscriberSnippet part", async () => {
    const result = await run(["subscription", "list", "--parts", "subscriberSnippet"])
    expectUsage(result, 'part "subscriberSnippet" requires owner/OAuth access and is not supported')
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("subscriberSnippet is caught anywhere in the parts list", async () => {
    expectUsage(
      await run(["subscription", "list", "--parts", "snippet,subscriberSnippet", "--channel", "UC1"]),
      'part "subscriberSnippet" requires owner/OAuth access and is not supported'
    )
  })

  test("subscriberSnippet is caught even when padded with spaces", async () => {
    expectUsage(
      await run(["subscription", "list", "--parts", " subscriberSnippet ", "--channel", "UC1"]),
      'part "subscriberSnippet" requires owner/OAuth access and is not supported'
    )
  })

  /**
   * Go trims with `strings.TrimSpace` (unicode.IsSpace), NOT with JS
   * `String.prototype.trim()`. The two sets differ in BOTH directions and each
   * case below was run against `/tmp/oytc-ref`:
   *
   *   U+0085 NEL / U+00A0 NBSP — Go space, JS not. Go trims them off and
   *     rejects the part; a JS `trim()` port would have sent it to the API.
   *   U+FEFF ZWNBSP — JS space, Go not. Go leaves it attached, so the segment
   *     is NOT `subscriberSnippet` and the request goes out; a JS `trim()` port
   *     would have wrongly rejected it.
   */
  test("trimming follows Go's unicode.IsSpace, not JS trim()", async () => {
    expectUsage(
      await run(["subscription", "list", "--parts", "subscriberSnippet", "--channel", "UC1"]),
      'part "subscriberSnippet" requires owner/OAuth access and is not supported'
    )
    expectUsage(
      await run(["subscription", "list", "--parts", " subscriberSnippet", "--channel", "UC1"]),
      'part "subscriberSnippet" requires owner/OAuth access and is not supported'
    )

    // U+FEFF is not Go whitespace: the part is accepted and sent verbatim.
    const feff = await run(
      ["subscription", "list", "--parts", "﻿subscriberSnippet", "--channel", "UC1"],
      { script: { list: [listOf("[]")] } }
    )
    expect(feff.exitCode).toBe(0)
    expect(feff.calls[0]!.params["part"]).toBe("﻿subscriberSnippet")
  })

  /**
   * `partsOr`'s "is this unset?" test uses the same Go trim. A NEL-only value
   * falls back to the default parts; a U+FEFF-only value does not.
   */
  test("partsOr's blank test also follows Go's whitespace set", async () => {
    const nel = await run(["subscription", "list", "--parts", "", "--channel", "UC1"], {
      script: { list: [listOf("[]")] }
    })
    expect(nel.calls[0]!.params["part"]).toBe("snippet,contentDetails")

    const feff = await run(["subscription", "list", "--parts", "﻿", "--channel", "UC1"], {
      script: { list: [listOf("[]")] }
    })
    expect(feff.calls[0]!.params["part"]).toBe("﻿")
  })

  test("the parts check precedes the --order enum", async () => {
    expectUsage(
      await run(["subscription", "list", "--order", "bogus", "--parts", "subscriberSnippet"]),
      'part "subscriberSnippet" requires owner/OAuth access and is not supported'
    )
  })

  test("rejects an unknown --order, with a DIFFERENT allowed set from comment threads", async () => {
    const result = await run(["subscription", "list", "--order", "bogus"])
    expectUsage(result, "--order must be one of: alphabetical, relevance")
  })

  test("the --order enum precedes the channel/id XOR", async () => {
    // No filter set either, but --order is checked first.
    expectUsage(
      await run(["subscription", "list", "--order", "bogus"]),
      "--order must be one of: alphabetical, relevance"
    )
  })

  test("requires exactly one of --channel or --id", async () => {
    expectUsage(await run(["subscription", "list"]), "provide exactly one of --channel or --id")
    expectUsage(
      await run(["subscription", "list", "--channel", "UC1", "--id", "S1"]),
      "provide exactly one of --channel or --id"
    )
  })

  test("--id with a non-default --order is rejected", async () => {
    expectUsage(
      await run(["subscription", "list", "--id", "S1", "--order", "alphabetical"]),
      "--for-channel and --order are incompatible with --id"
    )
  })

  test("--id with --for-channel is rejected", async () => {
    expectUsage(
      await run(["subscription", "list", "--id", "S1", "--for-channel", "UC2"]),
      "--for-channel and --order are incompatible with --id"
    )
  })

  test("LITERAL DEFAULT: --id with an explicit --order relevance is ACCEPTED", async () => {
    const result = await run(["subscription", "list", "--id", "S1", "--order", "relevance"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.params["order"]).toBe("relevance")
  })

  test("LITERAL DEFAULT: --id with an empty --order is REJECTED", async () => {
    expectUsage(
      await run(["subscription", "list", "--id", "S1", "--order="]),
      "--for-channel and --order are incompatible with --id"
    )
  })

  test("assembles channelId, order and the default part", async () => {
    const result = await run(["subscription", "list", "--channel", "UC1"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.resource).toBe("subscriptions")
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails",
      channelId: "UC1",
      order: "relevance"
    })
  })

  test("--for-channel maps to forChannelId and --fields is forwarded", async () => {
    const result = await run(
      [
        "subscription",
        "list",
        "--channel",
        "UC1",
        "--for-channel",
        "UC2",
        "--order",
        "alphabetical",
        "--fields",
        "items"
      ],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.params).toEqual({
      part: "snippet,contentDetails",
      channelId: "UC1",
      forChannelId: "UC2",
      order: "alphabetical",
      fields: "items"
    })
  })

  test("a custom --parts is sent verbatim and also scanned", async () => {
    const result = await run(["subscription", "list", "--channel", "UC1", "--parts", "id"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params["part"]).toBe("id")
  })

  test("forwards --all, --limit and --page-token", async () => {
    const result = await run(
      [
        "subscription",
        "list",
        "--channel",
        "UC1",
        "--all",
        "--limit",
        "7",
        "--page-token",
        "TOK"
      ],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.page).toEqual({
      all: true,
      limit: 7,
      pageSize: 25,
      pageToken: "TOK"
    })
  })

  test("has no --hl flag", async () => {
    const result = await run(["subscription", "list", "--channel", "UC1", "--hl", "en"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("renders the subscription default columns", async () => {
    const result = await run(["subscription", "list", "--channel", "UC1"], {
      script: {
        list: [
          listOf(
            `[{"id":"S1","snippet":{"resourceId":{"channelId":"UC9"},"title":"T"},"contentDetails":{"totalItemCount":11}}]`
          )
        ]
      }
    })
    // Byte-for-byte against `output.Render(..., Format: "table")` in Go.
    expect(result.stdout).toBe(
      "ID  SNIPPET.RESOURCEID.CHANNELID  SNIPPET.TITLE  CONTENTDETAILS.TOTALITEMCOUNT\n" +
        "S1  UC9                           T              11\n"
    )
  })

  test("the stderr summary is emitted for table output", async () => {
    const result = await run(["subscription", "list", "--channel", "UC1"], {
      script: { list: [listOf(`[{"id":"S1"}]`, 1)] }
    })
    expect(result.stderr).toBe("1 item(s), 1 request(s)\n")
  })
})

describe("the subscription group", () => {
  test("bare `oytc subscription` prints help and exits 0", async () => {
    const result = await run(["subscription"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
  })
})

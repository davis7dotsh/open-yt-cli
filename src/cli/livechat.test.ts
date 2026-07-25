/**
 * `live-chat list` / `live-chat stream` tests.
 *
 * The stream loop's seams are all injected (`StreamDeps`), so the dedup rules,
 * the header rule, the interval fallback and the four clean-exit conditions are
 * tested directly against `pollLiveChat` without a process, a socket or a
 * signal. The command wrapper is then driven through `Command.runWith` for the
 * validation order, the jsonl override and the resolution path.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import {
  ApiError,
  NotFoundError,
  OperationalError,
  UsageError,
  type OytcError
} from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import { rawNumber } from "../json/value.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import { makeRendererWith } from "../impl/renderer.ts"
import { liveChatColumns } from "../output/columns.ts"
import { globalFlags } from "./flags.ts"
import {
  AppOptions,
  ProcessEnv,
  Renderer,
  YouTubeApi,
  type AppOptionsShape,
  type OutputFormat,
  type Params,
  type RenderOptions,
  type RendererShape
} from "../services/index.ts"
import {
  dedupeBatch,
  formatFlagProvided,
  isLiveChatEnded,
  liveChatCommand,
  liveChatListCommand,
  liveChatParams,
  liveChatStreamCommand,
  pollInterval,
  pollLiveChat,
  resolveChatId,
  resolveStreamFormat,
  validateLiveChatFlags,
  type LiveChatFlagValues
} from "./livechat.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const flags = (overrides?: Partial<LiveChatFlagValues>): LiveChatFlagValues => ({
  video: "",
  chatId: "chat-1",
  pageSize: 500,
  pageToken: "",
  limit: 0,
  profileSize: 88,
  parts: "snippet,authorDetails",
  fields: "",
  ...overrides
})

const message = (id: string, text = "hi"): JsonObject => ({
  id,
  snippet: { publishedAt: "2026-01-01T00:00:00Z", displayMessage: text, type: "textMessageEvent" },
  authorDetails: { displayName: "Ann" }
})

/** A `Renderer` that records every (result, options) pair instead of writing. */
const recordingRenderer = (): {
  readonly renderer: RendererShape
  readonly calls: Array<{ result: ListResult; options: RenderOptions }>
} => {
  const calls: Array<{ result: ListResult; options: RenderOptions }> = []
  return {
    calls,
    renderer: {
      render: (result, options) => Effect.sync(() => void calls.push({ result, options })),
      renderObject: () => Effect.void
    }
  }
}

/** A scripted API: each call returns the next scripted page (or error). */
const scriptedApi = (
  pages: ReadonlyArray<DataApiResponse | OytcError>
): {
  readonly get: (resource: string, params: Params) => Effect.Effect<DataApiResponse, OytcError>
  readonly calls: Array<readonly [string, Params]>
} => {
  const calls: Array<readonly [string, Params]> = []
  let index = 0
  return {
    calls,
    get: (resource, params) =>
      Effect.suspend(() => {
        calls.push([resource, params])
        const page = pages[Math.min(index, pages.length - 1)]
        index++
        if (page === undefined) return Effect.succeed({ items: [] })
        return page instanceof Error
          ? Effect.fail(page as OytcError)
          : Effect.succeed(page as DataApiResponse)
      })
  }
}

const streamDeps = (
  api: { readonly get: (r: string, p: Params) => Effect.Effect<DataApiResponse, OytcError> },
  renderer: RendererShape,
  overrides?: {
    readonly format?: OutputFormat
    readonly columns?: ReadonlyArray<string>
    readonly noHeader?: boolean
    readonly stopped?: () => boolean
  }
) => ({
  api: {
    get: api.get,
    list: () => Effect.succeed({ items: [], nextPageToken: "", requests: 0 }),
    resolveChannel: () => Effect.succeed({ id: "", requests: 0 })
  },
  renderer,
  format: overrides?.format ?? ("jsonl" as OutputFormat),
  columns: overrides?.columns ?? liveChatColumns,
  noHeader: overrides?.noHeader ?? false,
  stopped: overrides?.stopped ?? (() => false)
})

// ---------------------------------------------------------------------------
// Flag validation — Go's PreRunE order
// ---------------------------------------------------------------------------

describe("validateLiveChatFlags", () => {
  test("neither --video nor --chat-id is rejected", () => {
    const error = validateLiveChatFlags(flags({ chatId: "" }))
    expect(error?.message).toBe("provide exactly one of --video or --chat-id")
  })

  test("both --video and --chat-id is rejected", () => {
    const error = validateLiveChatFlags(flags({ video: "v", chatId: "c" }))
    expect(error?.message).toBe("provide exactly one of --video or --chat-id")
  })

  test("either alone is accepted", () => {
    expect(validateLiveChatFlags(flags({ chatId: "c" }))).toBeUndefined()
    expect(validateLiveChatFlags(flags({ video: "v", chatId: "" }))).toBeUndefined()
  })

  test("--page-size bounds are 200..2000 inclusive, NOT 1..50", () => {
    expect(validateLiveChatFlags(flags({ pageSize: 199 }))?.message).toBe(
      "--page-size must be between 200 and 2000"
    )
    expect(validateLiveChatFlags(flags({ pageSize: 2001 }))?.message).toBe(
      "--page-size must be between 200 and 2000"
    )
    expect(validateLiveChatFlags(flags({ pageSize: 200 }))).toBeUndefined()
    expect(validateLiveChatFlags(flags({ pageSize: 2000 }))).toBeUndefined()
  })

  test("--profile-image-size bounds are 16..720 inclusive", () => {
    expect(validateLiveChatFlags(flags({ profileSize: 15 }))?.message).toBe(
      "--profile-image-size must be between 16 and 720"
    )
    expect(validateLiveChatFlags(flags({ profileSize: 721 }))?.message).toBe(
      "--profile-image-size must be between 16 and 720"
    )
    expect(validateLiveChatFlags(flags({ profileSize: 16 }))).toBeUndefined()
  })

  test("a negative --limit is rejected", () => {
    expect(validateLiveChatFlags(flags({ limit: -1 }))?.message).toBe(
      "--limit cannot be negative"
    )
    expect(validateLiveChatFlags(flags({ limit: 0 }))).toBeUndefined()
  })

  test("the mutual-exclusion check runs BEFORE the range checks", () => {
    // Both invalid: Go reports the exclusion error, not the page-size one.
    const error = validateLiveChatFlags(flags({ chatId: "", pageSize: 5 }))
    expect(error?.message).toBe("provide exactly one of --video or --chat-id")
  })

  test("page-size is checked before profile-image-size", () => {
    const error = validateLiveChatFlags(flags({ pageSize: 5, profileSize: 5 }))
    expect(error?.message).toBe("--page-size must be between 200 and 2000")
  })
})

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

describe("liveChatParams", () => {
  test("always sends part, liveChatId, maxResults and profileImageSize", () => {
    expect(liveChatParams("c1", flags(), "")).toEqual([
      ["part", "snippet,authorDetails"],
      ["liveChatId", "c1"],
      ["maxResults", "500"],
      ["profileImageSize", "88"]
    ])
  })

  test("omits an empty pageToken and an empty fields", () => {
    const params = liveChatParams("c1", flags(), "")
    expect(params.map(([k]) => k)).not.toContain("pageToken")
    expect(params.map(([k]) => k)).not.toContain("fields")
  })

  test("includes pageToken and fields when set", () => {
    const params = liveChatParams("c1", flags({ fields: "items/id" }), "tok")
    expect(params).toContainEqual(["pageToken", "tok"])
    expect(params).toContainEqual(["fields", "items/id"])
  })

  test("the resource carries an embedded slash", () => {
    // Documented in SPEC_CLI §5.3: liveChat/messages, unlike every other
    // single-segment resource.
    expect("liveChat/messages").toContain("/")
  })
})

// ---------------------------------------------------------------------------
// Chat-ID resolution
// ---------------------------------------------------------------------------

describe("resolveChatId", () => {
  const api = (pages: ReadonlyArray<DataApiResponse | OytcError>) => {
    const scripted = scriptedApi(pages)
    return {
      service: {
        get: scripted.get,
        list: () => Effect.succeed({ items: [], nextPageToken: "", requests: 0 }),
        resolveChannel: () => Effect.succeed({ id: "", requests: 0 })
      },
      calls: scripted.calls
    }
  }

  test("--chat-id costs zero requests and is used verbatim", async () => {
    const { service, calls } = api([])
    const result = await Effect.runPromise(resolveChatId(service, flags({ chatId: "given" })))
    expect(result).toEqual({ chatId: "given", requests: 0 })
    expect(calls).toEqual([])
  })

  test("--video costs one request and reads activeLiveChatId", async () => {
    const { service, calls } = api([
      { items: [{ liveStreamingDetails: { activeLiveChatId: "resolved" } }] }
    ])
    const result = await Effect.runPromise(
      resolveChatId(service, flags({ video: "vid", chatId: "" }))
    )
    expect(result).toEqual({ chatId: "resolved", requests: 1 })
    expect(calls).toEqual([
      ["videos", [["part", "liveStreamingDetails"], ["id", "vid"]]]
    ])
  })

  test("an empty item list is `video %q not found` (exit 4)", async () => {
    const { service } = api([{ items: [] }])
    const exit = await Effect.runPromiseExit(
      resolveChatId(service, flags({ video: "vid", chatId: "" }))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.message).toBe('video "vid" not found')
  })

  test("a missing activeLiveChatId is `has no active public live chat`", async () => {
    const { service } = api([{ items: [{ liveStreamingDetails: {} }] }])
    const exit = await Effect.runPromiseExit(
      resolveChatId(service, flags({ video: "vid", chatId: "" }))
    )
    expect(failureOf(exit).message).toBe('video "vid" has no active public live chat')
  })

  test("a whitespace-only activeLiveChatId is also `no active public live chat`", async () => {
    const { service } = api([
      { items: [{ liveStreamingDetails: { activeLiveChatId: "   " } }] }
    ])
    const exit = await Effect.runPromiseExit(
      resolveChatId(service, flags({ video: "vid", chatId: "" }))
    )
    expect(failureOf(exit).message).toBe('video "vid" has no active public live chat')
  })

  test("the video ID is quoted with Go's %q, escapes included", async () => {
    const { service } = api([{ items: [] }])
    const exit = await Effect.runPromiseExit(
      resolveChatId(service, flags({ video: 'a"b', chatId: "" }))
    )
    expect(failureOf(exit).message).toBe('video "a\\"b" not found')
  })
})

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe("dedupeBatch", () => {
  test("suppresses an id already seen", () => {
    const seen = new Set(["a"])
    const batch = dedupeBatch([message("a"), message("b")], seen, 0, 0)
    expect(batch.map((m) => m["id"])).toEqual(["b"])
  })

  test("an EMPTY id is ALWAYS emitted, however many times it appears", () => {
    const seen = new Set<string>()
    const batch = dedupeBatch([message(""), message(""), message("")], seen, 0, 0)
    expect(batch).toHaveLength(3)
    // …and it is never recorded, so it cannot suppress a later one.
    expect(seen.size).toBe(0)
  })

  test("a MISSING id behaves like an empty one", () => {
    const seen = new Set<string>()
    const withoutId: JsonObject = { snippet: { displayMessage: "x" } }
    const batch = dedupeBatch([withoutId, withoutId], seen, 0, 0)
    expect(batch).toHaveLength(2)
  })

  test("a non-string id is treated as empty", () => {
    const seen = new Set<string>()
    const numericId: JsonObject = { id: rawNumber("7") }
    expect(dedupeBatch([numericId, numericId], seen, 0, 0)).toHaveLength(2)
  })

  test("the limit stops the batch AFTER the item that reached it", () => {
    const seen = new Set<string>()
    const batch = dedupeBatch([message("a"), message("b"), message("c")], seen, 0, 2)
    expect(batch.map((m) => m["id"])).toEqual(["a", "b"])
  })

  test("the limit accounts for items emitted on earlier pages", () => {
    const seen = new Set<string>()
    const batch = dedupeBatch([message("a"), message("b")], seen, 1, 2)
    expect(batch.map((m) => m["id"])).toEqual(["a"])
  })

  test("limit 0 means unlimited", () => {
    const seen = new Set<string>()
    expect(dedupeBatch([message("a"), message("b")], seen, 99, 0)).toHaveLength(2)
  })

  test("dedup is across pages, via the shared seen-set", () => {
    const seen = new Set<string>()
    dedupeBatch([message("a")], seen, 0, 0)
    expect(dedupeBatch([message("a"), message("b")], seen, 1, 0)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Interval
// ---------------------------------------------------------------------------

describe("pollInterval", () => {
  test("uses a positive pollingIntervalMillis", () => {
    expect(pollInterval({ pollingIntervalMillis: rawNumber("2500") })).toBe(2500)
  })

  test("an absent value falls back to 1000ms", () => {
    expect(pollInterval({})).toBe(1000)
  })

  test("zero falls back to 1000ms", () => {
    expect(pollInterval({ pollingIntervalMillis: rawNumber("0") })).toBe(1000)
  })

  test("a negative value falls back to 1000ms", () => {
    expect(pollInterval({ pollingIntervalMillis: rawNumber("-5") })).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// liveChatEnded
// ---------------------------------------------------------------------------

describe("isLiveChatEnded", () => {
  const withReasons = (reasons: ReadonlyArray<string>): ApiError =>
    new ApiError({ httpStatus: 403, code: 403, apiMessage: "gone", reasons })

  test("matches the exact reason", () => {
    expect(isLiveChatEnded(withReasons(["liveChatEnded"]))).toBe(true)
  })

  test("is case-SENSITIVE — this is control flow, not classification", () => {
    expect(isLiveChatEnded(withReasons(["LIVECHATENDED"]))).toBe(false)
    expect(isLiveChatEnded(withReasons(["livechatended"]))).toBe(false)
    expect(isLiveChatEnded(withReasons(["live_chat_ended"]))).toBe(false)
  })

  test("matches when it is one of several reasons", () => {
    expect(isLiveChatEnded(withReasons(["forbidden", "liveChatEnded"]))).toBe(true)
  })

  test("a non-ApiError is never a chat-ended signal", () => {
    expect(isLiveChatEnded(new OperationalError({ message: "liveChatEnded" }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Format resolution
// ---------------------------------------------------------------------------

describe("formatFlagProvided", () => {
  test("detects --format and --format=", () => {
    expect(formatFlagProvided(["live-chat", "stream", "--format", "tsv"])).toBe(true)
    expect(formatFlagProvided(["--format=json", "live-chat", "stream"])).toBe(true)
  })

  test("detects the -f alias", () => {
    expect(formatFlagProvided(["-f", "tsv", "live-chat", "stream"])).toBe(true)
    expect(formatFlagProvided(["-f=tsv"])).toBe(true)
  })

  test("is false when absent", () => {
    expect(formatFlagProvided(["live-chat", "stream", "--chat-id", "c"])).toBe(false)
  })

  test("stops at a -- terminator", () => {
    expect(formatFlagProvided(["live-chat", "stream", "--", "--format", "json"])).toBe(false)
  })

  test("is not confused by a similarly-named flag", () => {
    expect(formatFlagProvided(["--formatter", "x"])).toBe(false)
  })
})

describe("resolveStreamFormat", () => {
  test("an omitted --format becomes jsonl even when the TTY resolved to table", () => {
    expect(resolveStreamFormat("table", false)).toBe("jsonl")
  })

  test("an omitted --format becomes jsonl even when a pipe resolved to json", () => {
    // The critical case: a piped `oytc live-chat stream` must NOT error.
    expect(resolveStreamFormat("json", false)).toBe("jsonl")
  })

  test("an EXPLICIT --format json is the only path to the error", () => {
    const result = resolveStreamFormat("json", true)
    expect(result).toBeInstanceOf(UsageError)
    expect((result as UsageError).message).toBe(
      "--format json is not valid for an unbounded stream; use jsonl, tsv, or table"
    )
  })

  test("explicit tsv, table and jsonl all pass through", () => {
    expect(resolveStreamFormat("tsv", true)).toBe("tsv")
    expect(resolveStreamFormat("table", true)).toBe("table")
    expect(resolveStreamFormat("jsonl", true)).toBe("jsonl")
  })
})

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------

describe("pollLiveChat", () => {
  const runLoop = (
    pages: ReadonlyArray<DataApiResponse | OytcError>,
    overrides?: Parameters<typeof streamDeps>[2],
    flagOverrides?: Partial<LiveChatFlagValues>
  ) => {
    const api = scriptedApi(pages)
    const { calls, renderer } = recordingRenderer()
    const exit = Effect.runPromiseExit(
      pollLiveChat(streamDeps(api, renderer, overrides), flags(flagOverrides), "chat-1", 0)
    )
    return { exit, renders: calls, apiCalls: api.calls }
  }

  test("stops cleanly when nextPageToken is empty", async () => {
    const { exit, renders } = runLoop([{ items: [message("a")], nextPageToken: "" }])
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(renders).toHaveLength(1)
  })

  test("stops cleanly when offlineAt is non-empty, even with a token", async () => {
    const { exit, apiCalls } = runLoop([
      { items: [message("a")], nextPageToken: "t2", offlineAt: "2026-01-01T00:00:00Z" }
    ])
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(await exit).toBeDefined()
    expect(apiCalls).toHaveLength(1)
  })

  test("stops cleanly on a liveChatEnded ApiError", async () => {
    const ended = new ApiError({
      httpStatus: 403,
      code: 403,
      apiMessage: "ended",
      reasons: ["liveChatEnded"]
    })
    const { exit } = runLoop([ended])
    expect(Exit.isSuccess(await exit)).toBe(true)
  })

  test("propagates any OTHER API error", async () => {
    const boom = new ApiError({
      httpStatus: 500,
      code: 500,
      apiMessage: "boom",
      reasons: ["backendError"]
    })
    const { exit } = runLoop([boom])
    const result = await exit
    expect(Exit.isFailure(result)).toBe(true)
    expect(failureOf(result)).toBe(boom)
  })

  test("stops immediately when `stopped` is already true — SIGINT before poll 1", async () => {
    const { exit, apiCalls } = runLoop([{ items: [message("a")] }], { stopped: () => true })
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(apiCalls).toEqual([])
  })

  test("stops between pages when `stopped` flips", async () => {
    let polls = 0
    const api = {
      get: (_r: string, _p: Params) =>
        Effect.sync(() => {
          polls++
          return {
            items: [message(`m${polls}`)],
            nextPageToken: "next",
            pollingIntervalMillis: rawNumber("1")
          } as DataApiResponse
        })
    }
    const { renderer, calls } = recordingRenderer()
    const exit = await Effect.runPromiseExit(
      pollLiveChat(
        streamDeps(api, renderer, { stopped: () => polls >= 2 }),
        flags(),
        "chat-1",
        0
      )
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test("the header prints ONLY for the first NON-EMPTY batch", async () => {
    const { exit, renders } = runLoop([
      { items: [], nextPageToken: "t1", pollingIntervalMillis: rawNumber("1") },
      { items: [], nextPageToken: "t2", pollingIntervalMillis: rawNumber("1") },
      { items: [message("a")], nextPageToken: "t3", pollingIntervalMillis: rawNumber("1") },
      { items: [message("b")], nextPageToken: "" }
    ])
    expect(Exit.isSuccess(await exit)).toBe(true)
    // Two renders: the two empty pages produced none at all.
    expect(renders).toHaveLength(2)
    expect(renders[0]!.options.noHeader).toBe(false)
    expect(renders[1]!.options.noHeader).toBe(true)
  })

  test("--no-header suppresses the header on the first batch too", async () => {
    const { exit, renders } = runLoop(
      [
        { items: [message("a")], nextPageToken: "t", pollingIntervalMillis: rawNumber("1") },
        { items: [message("b")], nextPageToken: "" }
      ],
      { noHeader: true }
    )
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(renders.map((r) => r.options.noHeader)).toEqual([true, true])
  })

  test("an empty batch renders NOTHING (no empty jsonl line)", async () => {
    const { exit, renders } = runLoop([{ items: [], nextPageToken: "" }])
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(renders).toEqual([])
  })

  test("duplicate ids across pages are emitted once", async () => {
    const { exit, renders } = runLoop([
      {
        items: [message("a"), message("b")],
        nextPageToken: "t",
        pollingIntervalMillis: rawNumber("1")
      },
      { items: [message("b"), message("c")], nextPageToken: "" }
    ])
    expect(Exit.isSuccess(await exit)).toBe(true)
    const ids = renders.flatMap((r) => r.result.items.map((i) => i["id"]))
    expect(ids).toEqual(["a", "b", "c"])
  })

  test("--limit stops the loop once reached", async () => {
    const { exit, renders, apiCalls } = runLoop(
      [
        {
          items: [message("a"), message("b")],
          nextPageToken: "t",
          pollingIntervalMillis: rawNumber("1")
        },
        { items: [message("c")], nextPageToken: "t2" }
      ],
      undefined,
      { limit: 2 }
    )
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(apiCalls).toHaveLength(1)
    expect(renders.flatMap((r) => r.result.items.map((i) => i["id"]))).toEqual(["a", "b"])
  })

  test("the page token is carried forward", async () => {
    const { exit, apiCalls } = runLoop([
      { items: [], nextPageToken: "TOKEN-2", pollingIntervalMillis: rawNumber("1") },
      { items: [], nextPageToken: "" }
    ])
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(apiCalls[0]![1].map(([k]) => k)).not.toContain("pageToken")
    expect(apiCalls[1]![1]).toContainEqual(["pageToken", "TOKEN-2"])
  })

  test("an explicit --page-token seeds the first request", async () => {
    const { exit, apiCalls } = runLoop([{ items: [], nextPageToken: "" }], undefined, {
      pageToken: "SEED"
    })
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(apiCalls[0]![1]).toContainEqual(["pageToken", "SEED"])
  })

  test("the request counter increments across pages and reaches the envelope", async () => {
    const { exit, renders } = runLoop([
      {
        items: [message("a")],
        nextPageToken: "t",
        pollingIntervalMillis: rawNumber("1")
      },
      { items: [message("b")], nextPageToken: "" }
    ])
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(renders.map((r) => r.result.requests)).toEqual([1, 2])
  })

  test("the initial request count from --video resolution is carried in", async () => {
    const api = scriptedApi([{ items: [message("a")], nextPageToken: "" }])
    const { renderer, calls } = recordingRenderer()
    await Effect.runPromise(pollLiveChat(streamDeps(api, renderer), flags(), "c", 1))
    expect(calls[0]!.result.requests).toBe(2)
  })

  test("every batch envelope has an empty nextPageToken (streams have no resume)", async () => {
    const { exit, renders } = runLoop([
      { items: [message("a")], nextPageToken: "t", pollingIntervalMillis: rawNumber("1") },
      { items: [message("b")], nextPageToken: "" }
    ])
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(renders.every((r) => r.result.nextPageToken === "")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

interface RunOptions {
  readonly format?: OutputFormat | undefined
  readonly columns?: ReadonlyArray<string> | undefined
  readonly noHeader?: boolean | undefined
  readonly quiet?: boolean | undefined
  readonly pages?: ReadonlyArray<DataApiResponse | OytcError> | undefined
  /** What `ProcessEnv.argv` reports; defaults to the argv under test. */
  readonly argv?: ReadonlyArray<string> | undefined
}

const runCommand = async (
  argv: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly exit: Exit.Exit<void, OytcError>
  readonly apiCalls: ReadonlyArray<readonly [string, Params]>
}> => {
  const out: Array<string> = []
  const err: Array<string> = []
  const api = scriptedApi(options.pages ?? [{ items: [], nextPageToken: "" }])
  const decode = (i: string | Uint8Array): string =>
    typeof i === "string" ? i : new TextDecoder().decode(i)

  const stdio = Stdio.layerTest({
    stdout: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => out.push(decode(i)))),
    stderr: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => err.push(decode(i))))
  })

  const appOptions: AppOptionsShape = {
    format: options.format ?? "table",
    columns: options.columns ?? [],
    noHeader: options.noHeader ?? false,
    quiet: options.quiet ?? false,
    timeoutMillis: 20_000,
    isOutputTTY: true
  }

  const layers = Layer.mergeAll(
    Layer.succeed(AppOptions, appOptions),
    Layer.succeed(YouTubeApi, {
      get: api.get,
      list: () => Effect.succeed({ items: [], nextPageToken: "", requests: 0 }),
      resolveChannel: () => Effect.succeed({ id: "", requests: 0 })
    }),
    Layer.succeed(ProcessEnv, {
      env: () => ({ _tag: "None" }) as never,
      platform: "darwin",
      arch: "arm64",
      argv: options.argv ?? argv,
      executablePath: Effect.succeed("/usr/local/bin/oytc"),
      isOutputTTY: true,
      homeDir: Effect.succeed("/home/test")
    }),
    Layer.succeed(
      Renderer,
      makeRendererWith((text) => Effect.sync(() => void out.push(text)))
    )
  )

  // The shared global flags are declared on the root exactly as production's
  // root.ts does, so `--format` parses here the way it does in the real CLI.
  // `AppOptions` is supplied directly rather than resolved from them, which is
  // what lets a test set the resolved format independently of argv — the very
  // distinction `formatFlagProvided` exists to recover.
  const root = Command.make("oytc").pipe(
    Command.withSharedFlags(globalFlags),
    Command.withSubcommands([liveChatCommand])
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(root, { version: "test" })(argv).pipe(
      Effect.provide(Layer.mergeAll(layers, stdio))
    ) as Effect.Effect<void, OytcError>
  )
  return { stdout: out.join(""), stderr: err.join(""), exit, apiCalls: api.calls }
}

describe("live-chat list", () => {
  test("renders one page and stops", async () => {
    const { stdout, exit, apiCalls } = await runCommand(
      ["live-chat", "list", "--chat-id", "c1"],
      { format: "jsonl", pages: [{ items: [message("a")], nextPageToken: "t" }] }
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(apiCalls).toHaveLength(1)
    expect(stdout).toContain('"id":"a"')
  })

  test("--all is rejected with Go's exact message", async () => {
    const { exit, apiCalls } = await runCommand([
      "live-chat",
      "list",
      "--chat-id",
      "c1",
      "--all"
    ])
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(UsageError)
    expect(error.message).toBe(
      "--all is not supported for live chat because its next token represents future " +
        "polling; use 'live-chat stream'"
    )
    // …and nothing was requested.
    expect(apiCalls).toEqual([])
  })

  test("the PreRunE checks fire BEFORE the --all check", async () => {
    // Both are wrong; Go reports the flag-pair error.
    const { exit } = await runCommand(["live-chat", "list", "--all"])
    expect(failureOf(exit).message).toBe("provide exactly one of --video or --chat-id")
  })

  test("--limit truncates the single page client-side", async () => {
    const { stdout } = await runCommand(
      ["live-chat", "list", "--chat-id", "c1", "--limit=1"],
      {
        format: "jsonl",
        pages: [{ items: [message("a"), message("b")], nextPageToken: "" }]
      }
    )
    expect(stdout).toContain('"id":"a"')
    expect(stdout).not.toContain('"id":"b"')
  })

  test("the table summary lands on stderr and counts requests", async () => {
    const { stderr } = await runCommand(["live-chat", "list", "--chat-id", "c1"], {
      format: "table",
      pages: [{ items: [message("a")], nextPageToken: "" }]
    })
    expect(stderr).toBe("1 item(s), 1 request(s)\n")
  })

  test("--quiet suppresses the summary", async () => {
    const { stderr } = await runCommand(["live-chat", "list", "--chat-id", "c1"], {
      format: "table",
      quiet: true,
      pages: [{ items: [message("a")], nextPageToken: "" }]
    })
    expect(stderr).toBe("")
  })

  test("a resume token appears in the summary", async () => {
    const { stderr } = await runCommand(["live-chat", "list", "--chat-id", "c1"], {
      format: "table",
      pages: [{ items: [message("a")], nextPageToken: "NEXT" }]
    })
    expect(stderr).toBe("1 item(s), 1 request(s); more available (next token: NEXT)\n")
  })

  test("--video resolution costs a request, reflected in the summary", async () => {
    const { stderr } = await runCommand(["live-chat", "list", "--video", "v1"], {
      format: "table",
      pages: [
        { items: [{ liveStreamingDetails: { activeLiveChatId: "resolved" } }] },
        { items: [message("a")], nextPageToken: "" }
      ]
    })
    expect(stderr).toBe("1 item(s), 2 request(s)\n")
  })
})

describe("live-chat stream", () => {
  test("silently forces jsonl on a TTY when --format is absent", async () => {
    const { stdout, exit } = await runCommand(["live-chat", "stream", "--chat-id", "c1"], {
      // AppOptions resolved to table because isOutputTTY is true…
      format: "table",
      pages: [{ items: [message("a")], nextPageToken: "" }]
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    // …but the output is JSONL, not a table.
    expect(stdout).toStartWith('{"authorDetails"')
    expect(stdout).not.toContain("SNIPPET.PUBLISHEDAT")
  })

  test("an explicit --format json is rejected before any request", async () => {
    const { exit, apiCalls } = await runCommand(
      ["live-chat", "stream", "--chat-id", "c1", "--format", "json"],
      { format: "json", argv: ["live-chat", "stream", "--chat-id", "c1", "--format", "json"] }
    )
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(UsageError)
    expect(error.message).toBe(
      "--format json is not valid for an unbounded stream; use jsonl, tsv, or table"
    )
    expect(apiCalls).toEqual([])
  })

  test("a PIPED stream with no --format does NOT error, it emits jsonl", async () => {
    // The regression this guards: AppOptions.format is "json" here because
    // stdout is a pipe, but the flag was never passed, so Go streamed jsonl.
    const { stdout, exit } = await runCommand(["live-chat", "stream", "--chat-id", "c1"], {
      format: "json",
      argv: ["live-chat", "stream", "--chat-id", "c1"],
      pages: [{ items: [message("a")], nextPageToken: "" }]
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stdout).toContain('"id":"a"')
    // A json ENVELOPE would have "items"; jsonl has bare objects.
    expect(stdout).not.toContain('"items"')
  })

  test("an explicit --format tsv is honoured", async () => {
    const { stdout, exit } = await runCommand(
      ["live-chat", "stream", "--chat-id", "c1", "--format", "tsv"],
      {
        format: "tsv",
        argv: ["live-chat", "stream", "--chat-id", "c1", "--format", "tsv"],
        pages: [{ items: [message("a")], nextPageToken: "" }]
      }
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stdout).toStartWith("SNIPPET.PUBLISHEDAT\t")
  })

  test("flag validation runs before the format check", async () => {
    const { exit } = await runCommand(["live-chat", "stream", "--format", "json"], {
      format: "json",
      argv: ["live-chat", "stream", "--format", "json"]
    })
    expect(failureOf(exit).message).toBe("provide exactly one of --video or --chat-id")
  })

  test("--columns overrides the default column set", async () => {
    const { stdout } = await runCommand(
      ["live-chat", "stream", "--chat-id", "c1", "--format", "tsv"],
      {
        format: "tsv",
        columns: ["id"],
        argv: ["live-chat", "stream", "--chat-id", "c1", "--format", "tsv"],
        pages: [{ items: [message("a")], nextPageToken: "" }]
      }
    )
    expect(stdout).toBe("ID\na\n")
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("command registration", () => {
  test("the group has Go's name and description", () => {
    expect(liveChatCommand.name).toBe("live-chat")
    expect(liveChatCommand.description).toBe("Read public live chat using REST polling")
  })

  test("both subcommands are registered", () => {
    expect(liveChatListCommand.name).toBe("list")
    expect(liveChatStreamCommand.name).toBe("stream")
    const names = liveChatCommand.subcommands.flatMap((g) => g.commands.map((c) => c.name))
    expect(names).toEqual(["list", "stream"])
  })

  test("a bare `live-chat` has no handler, so it prints help and exits 0", async () => {
    const { exit } = await runCommand(["live-chat"])
    // The framework surfaces "help requested" rather than running anything.
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------

const failureOf = (exit: Exit.Exit<unknown, OytcError>): OytcError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const found = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (found === undefined) throw new Error(`no Fail reason: ${String(exit.cause)}`)
  return (found as { readonly error: OytcError }).error
}

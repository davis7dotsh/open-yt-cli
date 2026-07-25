/**
 * `live-chat {list,stream}` — the port of `internal/cli/live_chat.go`.
 *
 * `list` fetches exactly one page. `stream` is a hand-rolled polling loop; it
 * is the only command in the CLI that renders more than once, and almost every
 * detail of it is observable:
 *
 *   - **Dedup by `id`, but an EMPTY id is always emitted.** An item whose `id`
 *     is missing or blank is never recorded in the seen-set and never
 *     suppressed, so a partial-response selector that strips ids degrades to
 *     "emit everything" rather than to "emit the first item and nothing else".
 *   - **The header prints for the first NON-EMPTY batch only.** `firstPage`
 *     flips inside the `if items.length > 0` branch, so a run that polls three
 *     empty pages before its first message still gets its header.
 *   - **1000 ms is the fallback interval.** `pollingIntervalMillis` is used
 *     when positive; zero, negative and absent all mean one second.
 *   - **Four clean-exit conditions, all exit code 0:** a non-empty `offlineAt`,
 *     an empty `nextPageToken`, an API error carrying the reason
 *     `liveChatEnded` (exact, case-SENSITIVE — it is a control-flow signal, not
 *     a classification heuristic), and SIGINT. DEVIATIONS.md lists the SIGINT
 *     case as deliberate parity even though it contradicts "130 = interrupted".
 *   - **`--format` silently becomes `jsonl` when the user did not pass it**,
 *     even on a TTY. Only an EXPLICIT `--format json` reaches the error.
 *
 * ## Why the explicit-flag test reads argv
 *
 * Go branched on `a.format == ""`, i.e. on whether the flag was supplied, not
 * on its resolved value. `AppOptions.format` has already collapsed that
 * distinction: on a TTY an omitted flag and an explicit `--format table` both
 * arrive as `"table"`, and when piped an omitted flag and an explicit
 * `--format json` both arrive as `"json"` — yet Go streams JSONL for the first
 * and errors for the second. The distinction therefore has to come from
 * somewhere else, and `ProcessEnv.argv` is the seam that has it. Redeclaring
 * `--format` on the leaf does NOT work: the root's shared flag consumes the
 * value and the leaf's copy is always `None` (verified against the framework).
 *
 * ## Why the loop installs its own SIGINT handler
 *
 * `runMain` interrupts the main fiber on SIGINT and its teardown maps an
 * interrupt-only cause to exit **130**. Catching the interrupt inside the
 * handler does not help — the fiber is already unwinding and the teardown has
 * already decided. Taking the signal over for the duration of the loop, and
 * restoring the previous listeners afterwards, is what produces the exit 0 Go
 * produced. Verified end-to-end under Bun.
 */

import { Effect, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import {
  ApiError,
  NotFoundError,
  OperationalError,
  UsageError,
  type OytcError
} from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import { goQuote } from "../impl/resolveChannel.ts"
import { pollingIntervalMillis, videoActiveLiveChatId } from "../schema/accessors.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import { liveChatColumns } from "../output/columns.ts"
import {
  AppOptions,
  ProcessEnv,
  Renderer,
  YouTubeApi,
  type AppOptionsShape,
  type OutputFormat,
  type Params,
  type RendererShape,
  type YouTubeApiShape
} from "../services/index.ts"

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * `addLiveChatFlags`. A DISTINCT set from `addListFlags`/`addAPIFlags`: note
 * the 500 page size with a 200-2000 range, and the non-empty `--parts` default.
 */
const liveChatFlags = {
  video: Flag.string("video").pipe(
    Flag.withDefault(""),
    Flag.withDescription("live video ID (resolved to activeLiveChatId)")
  ),
  chatId: Flag.string("chat-id").pipe(
    Flag.withDefault(""),
    Flag.withDescription("live chat ID")
  ),
  pageSize: Flag.integer("page-size").pipe(
    Flag.withDefault(500),
    Flag.withDescription("messages per request (200-2000)")
  ),
  pageToken: Flag.string("page-token").pipe(
    Flag.withDefault(""),
    Flag.withDescription("resume at this live chat page token")
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDefault(0),
    Flag.withDescription("stop after this many emitted messages (0 means unlimited)")
  ),
  profileSize: Flag.integer("profile-image-size").pipe(
    Flag.withDefault(88),
    Flag.withDescription("author image size in pixels (16-720)")
  ),
  parts: Flag.string("parts").pipe(
    Flag.withDefault("snippet,authorDetails"),
    Flag.withDescription("comma-separated API resource parts")
  ),
  fields: Flag.string("fields").pipe(
    Flag.withDefault(""),
    Flag.withDescription("Google partial-response fields selector")
  )
} as const

export interface LiveChatFlagValues {
  readonly video: string
  readonly chatId: string
  readonly pageSize: number
  readonly pageToken: string
  readonly limit: number
  readonly profileSize: number
  readonly parts: string
  readonly fields: string
}

/**
 * The `PreRunE` block both subcommands share, in Go's exact order. Runs before
 * the `RunE` semantic checks and before anything touches the network.
 */
export const validateLiveChatFlags = (flags: LiveChatFlagValues): UsageError | undefined => {
  if ((flags.video === "") === (flags.chatId === "")) {
    return new UsageError({ message: "provide exactly one of --video or --chat-id" })
  }
  if (flags.pageSize < 200 || flags.pageSize > 2000) {
    return new UsageError({ message: "--page-size must be between 200 and 2000" })
  }
  if (flags.profileSize < 16 || flags.profileSize > 720) {
    return new UsageError({ message: "--profile-image-size must be between 16 and 720" })
  }
  if (flags.limit < 0) {
    return new UsageError({ message: "--limit cannot be negative" })
  }
  return undefined
}

/** `liveChatParams` — `pageToken` and `fields` only when non-empty. */
export const liveChatParams = (
  chatId: string,
  flags: LiveChatFlagValues,
  pageToken: string
): Params => {
  const params: Array<readonly [string, string]> = [
    ["part", flags.parts],
    ["liveChatId", chatId],
    ["maxResults", String(flags.pageSize)],
    ["profileImageSize", String(flags.profileSize)]
  ]
  if (pageToken !== "") params.push(["pageToken", pageToken])
  if (flags.fields !== "") params.push(["fields", flags.fields])
  return params
}

// ---------------------------------------------------------------------------
// Chat-ID resolution
// ---------------------------------------------------------------------------

export interface ResolvedChat {
  readonly chatId: string
  /** Requests already spent resolving: 0 for `--chat-id`, 1 for `--video`. */
  readonly requests: number
}

/**
 * `liveChatClientAndID`. Both failure messages are matched by the exit-code
 * classifier's substring rules (`not found`, `no active public live chat`), so
 * both are `NotFoundError` / exit 4.
 */
export const resolveChatId = (
  api: YouTubeApiShape,
  flags: LiveChatFlagValues
): Effect.Effect<ResolvedChat, OytcError> =>
  Effect.gen(function* () {
    if (flags.chatId !== "") return { chatId: flags.chatId, requests: 0 }

    const response = yield* api.get("videos", [
      ["part", "liveStreamingDetails"],
      ["id", flags.video]
    ])
    const items = (response.items ?? []) as ReadonlyArray<JsonObject>
    if (items.length === 0) {
      return yield* Effect.fail(
        new NotFoundError({ message: `video ${goQuote(flags.video)} not found` })
      )
    }
    // The accessor already rejects a missing key, a non-string, and an empty
    // string; Go additionally trimmed, so a whitespace-only id is "no chat".
    const resolved = videoActiveLiveChatId(items[0]!)
    if (Option.isNone(resolved) || resolved.value.trim() === "") {
      return yield* Effect.fail(
        new NotFoundError({
          message: `video ${goQuote(flags.video)} has no active public live chat`
        })
      )
    }
    return { chatId: resolved.value, requests: 1 }
  })

// ---------------------------------------------------------------------------
// live-chat list
// ---------------------------------------------------------------------------

const writeErr = (text: string): Effect.Effect<void, OperationalError, Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stderr()).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write output", cause }))
      )
    )
  })

/**
 * `renderResult` — render, then the stderr summary for `--format table` only,
 * and only without `--quiet`. P8a owns the shared copy in `render.ts`; it is
 * still a stub, so an identical local one lives here.
 */
const renderResult = (
  result: ListResult,
  defaultColumns: ReadonlyArray<string>,
  options: AppOptionsShape
) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer
    yield* renderer.render(result, {
      format: options.format,
      columns: options.columns.length > 0 ? options.columns : defaultColumns,
      noHeader: options.noHeader
    })
    if (options.quiet || options.format !== "table") return
    const more =
      result.nextPageToken === ""
        ? ""
        : `; more available (next token: ${result.nextPageToken})`
    yield* writeErr(`${result.items.length} item(s), ${result.requests} request(s)${more}\n`)
  })

/**
 * `Args: exactArgs(0)` in Go (live_chat.go:38,67). Observed variadically
 * because the framework otherwise drops extra positionals silently.
 */
const noPositionals = { extra: Argument.string("").pipe(Argument.variadic()) }

const rejectExtraArgs = (extra: ReadonlyArray<string>) =>
  extra.length === 0
    ? undefined
    : new UsageError({ message: `expected 0 argument(s), received ${extra.length}` })

export const liveChatListCommand = Command.make(
  "list",
  {
    ...noPositionals,
    ...liveChatFlags,
    all: Flag.boolean("all").pipe(
      Flag.withDescription("not supported for finite live chat; use stream")
    )
  },
  (config) =>
    Effect.gen(function* () {
      // Arity is cobra's `Args`, which runs before PreRunE.
      const arity = rejectExtraArgs(config.extra)
      if (arity !== undefined) return yield* Effect.fail(arity)
      // PreRunE first…
      const invalid = validateLiveChatFlags(config)
      if (invalid !== undefined) return yield* Effect.fail(invalid)
      // …then RunE's own check. `--all` exists ONLY to produce this message.
      if (config.all) {
        return yield* Effect.fail(
          new UsageError({
            message:
              "--all is not supported for live chat because its next token represents " +
              "future polling; use 'live-chat stream'"
          })
        )
      }

      const api = yield* YouTubeApi
      const { chatId, requests } = yield* resolveChatId(api, config)
      const response = yield* api.get(
        "liveChat/messages",
        liveChatParams(chatId, config, config.pageToken)
      )

      let items = (response.items ?? []) as ReadonlyArray<JsonObject>
      if (config.limit > 0 && items.length > config.limit) items = items.slice(0, config.limit)

      const options = yield* AppOptions
      yield* renderResult(
        {
          items,
          nextPageToken: response.nextPageToken ?? "",
          requests: requests + 1
        },
        liveChatColumns,
        options
      )
    })
).pipe(
  Command.withDescription(
    "Fetch one finite page of public live chat messages. Use stream for continuous, " +
      "polling-aware output."
  )
)

// ---------------------------------------------------------------------------
// live-chat stream
// ---------------------------------------------------------------------------

/**
 * Whether `--format` (or its `-f` alias) appears in argv.
 *
 * `live-chat stream` takes no positional arguments, so any `--format` token is
 * unambiguously the flag; there is no value position it could be occupying.
 * Both the `--format value` and `--format=value` spellings are recognised, and
 * a `--` terminator ends the scan the way a POSIX parser would.
 */
export const formatFlagProvided = (argv: ReadonlyArray<string>): boolean => {
  for (const argument of argv) {
    if (argument === "--") return false
    if (argument === "--format" || argument.startsWith("--format=")) return true
    if (argument === "-f" || argument.startsWith("-f=")) return true
  }
  return false
}

/**
 * `stream`'s format resolution, which is unlike every other command's.
 *
 * Returns the format to render with, or a `UsageError` for the one rejected
 * case. Note that an omitted flag NEVER errors: it becomes jsonl even on a
 * TTY, so `oytc live-chat stream` alone emits JSONL rather than a table.
 */
export const resolveStreamFormat = (
  resolved: OutputFormat,
  provided: boolean
): OutputFormat | UsageError => {
  if (!provided) return "jsonl"
  if (resolved === "json") {
    return new UsageError({
      message: "--format json is not valid for an unbounded stream; use jsonl, tsv, or table"
    })
  }
  return resolved
}

/** `apiErrorHasReason(err, "liveChatEnded")` — exact, case-SENSITIVE. */
export const isLiveChatEnded = (error: OytcError): boolean =>
  error instanceof ApiError && error.reasons.includes("liveChatEnded")

/** `pollingIntervalMillis` when positive, otherwise one second. */
export const pollInterval = (response: DataApiResponse): number => {
  const millis = pollingIntervalMillis(response)
  if (Option.isNone(millis)) return 1000
  return millis.value > 0 ? millis.value : 1000
}

/**
 * One batch's worth of dedup, in Go's exact shape.
 *
 * `seen` is mutated. The limit test runs AFTER the item is appended, matching
 * `if flags.limit > 0 && emitted+len(items) >= flags.limit { break }`.
 */
export const dedupeBatch = (
  items: ReadonlyArray<JsonObject>,
  seen: Set<string>,
  emitted: number,
  limit: number
): ReadonlyArray<JsonObject> => {
  const batch: Array<JsonObject> = []
  for (const item of items) {
    const id = typeof item["id"] === "string" ? item["id"] : ""
    if (id !== "") {
      if (seen.has(id)) continue
      seen.add(id)
    }
    batch.push(item)
    if (limit > 0 && emitted + batch.length >= limit) break
  }
  return batch
}

/**
 * The interruptible wait.
 *
 * Sliced rather than a single `Effect.sleep` because the loop owns SIGINT for
 * its duration: `runMain`'s fiber interrupt is not available to cut a sleep
 * short, so a 5-second polling interval would otherwise keep the process alive
 * for up to five seconds after Ctrl-C. 50 ms of granularity is invisible to a
 * user and bounded regardless of what the server asks for.
 */
const waitFor = (millis: number, stopped: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    let remaining = millis
    while (remaining > 0) {
      if (stopped()) return
      const slice = Math.min(remaining, 50)
      yield* Effect.sleep(slice)
      remaining -= slice
    }
  })

export interface StreamDeps {
  readonly api: YouTubeApiShape
  readonly renderer: RendererShape
  readonly format: OutputFormat
  readonly columns: ReadonlyArray<string>
  readonly noHeader: boolean
  /** Polled between and during waits; `true` ends the loop cleanly. */
  readonly stopped: () => boolean
}

/**
 * The poll loop itself, with every seam injected so tests drive it without a
 * process, a socket or a signal.
 */
export const pollLiveChat = (
  deps: StreamDeps,
  flags: LiveChatFlagValues,
  chatId: string,
  initialRequests: number
): Effect.Effect<void, OytcError> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    let emitted = 0
    let firstPage = true
    let requests = initialRequests
    let pageToken = flags.pageToken

    for (;;) {
      if (deps.stopped()) return

      const attempt = yield* Effect.result(
        deps.api.get("liveChat/messages", liveChatParams(chatId, flags, pageToken))
      )
      if (attempt._tag === "Failure") {
        // A chat that has ended is a normal termination, not an error.
        if (isLiveChatEnded(attempt.failure)) return
        return yield* Effect.fail(attempt.failure)
      }
      const response = attempt.success
      requests++

      const batch = dedupeBatch(
        (response.items ?? []) as ReadonlyArray<JsonObject>,
        seen,
        emitted,
        flags.limit
      )

      if (batch.length > 0) {
        yield* deps.renderer.render(
          { items: batch, nextPageToken: "", requests },
          {
            format: deps.format,
            columns: deps.columns,
            // The header belongs to the first batch that actually has rows.
            noHeader: deps.noHeader || !firstPage
          }
        )
        emitted += batch.length
        firstPage = false
      }

      if (flags.limit > 0 && emitted >= flags.limit) return
      const offlineAt = response.offlineAt ?? ""
      const nextPageToken = response.nextPageToken ?? ""
      if (offlineAt !== "" || nextPageToken === "") return

      pageToken = nextPageToken
      yield* waitFor(pollInterval(response), deps.stopped)
    }
  })

/**
 * Own SIGINT for the duration of `effect`, restoring the previous listeners
 * however it ends.
 *
 * The `yieldNow` matters: `runMain` installs its own handler around the fiber
 * it forks, and on the very first synchronous run of the program that has not
 * happened yet — removing listeners before it would leave `runMain` free to
 * add its own afterwards and interrupt anyway. One scheduler tick is enough.
 */
const withOwnSigint = <A, E, R>(
  use: (stopped: () => boolean) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    yield* Effect.yieldNow
    const previous = process.listeners("SIGINT") as ReadonlyArray<NodeJS.SignalsListener>
    let stopped = false
    const onSignal = (): void => {
      stopped = true
    }
    process.removeAllListeners("SIGINT")
    process.on("SIGINT", onSignal)
    return yield* use(() => stopped).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.removeListener("SIGINT", onSignal)
          for (const listener of previous) process.on("SIGINT", listener)
        })
      )
    )
  })

export const liveChatStreamCommand = Command.make(
  "stream",
  { ...noPositionals, ...liveChatFlags },
  (config) =>
  Effect.gen(function* () {
    const arity = rejectExtraArgs(config.extra)
    if (arity !== undefined) return yield* Effect.fail(arity)
    const invalid = validateLiveChatFlags(config)
    if (invalid !== undefined) return yield* Effect.fail(invalid)

    const options = yield* AppOptions
    const env = yield* ProcessEnv
    const format = resolveStreamFormat(options.format, formatFlagProvided(env.argv))
    if (format instanceof UsageError) return yield* Effect.fail(format)

    const api = yield* YouTubeApi
    const { chatId, requests } = yield* resolveChatId(api, config)
    const renderer = yield* Renderer

    yield* withOwnSigint((stopped) =>
      pollLiveChat(
        {
          api,
          renderer,
          format,
          columns: options.columns.length > 0 ? options.columns : liveChatColumns,
          noHeader: options.noHeader,
          stopped
        },
        config,
        chatId,
        requests
      )
    )
  })
).pipe(
  Command.withDescription(
    "Continuously polls liveChatMessages.list, respects pollingIntervalMillis, carries page " +
      "tokens, and deduplicates IDs. This first draft is a REST polling fallback, not the " +
      "official gRPC streamList method. JSONL is the default stream format."
  )
)

/** The group; no handler, so a bare `oytc live-chat` prints help and exits 0. */
export const liveChatCommand = Command.make("live-chat").pipe(
  Command.withDescription("Read public live chat using REST polling"),
  Command.withSubcommands([liveChatListCommand, liveChatStreamCommand])
)

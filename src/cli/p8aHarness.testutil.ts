/**
 * Test harness for the P8a command tests (`search`, `channel`, `video`).
 *
 * Not a `.test.ts` — bun would try to run it as a suite. Imported by
 * `search.test.ts`, `channel.test.ts` and `video.test.ts`.
 *
 * `runCli` drives a command through the REAL `Command.runWith` with explicit
 * argv, the real `RendererLive` over a capturing `Stdio`, and scripted
 * `YouTubeApi` / `HttpCore` services that record every request. Flag parsing,
 * defaulting, validation order, param assembly, pagination options and
 * rendering are therefore all under test end-to-end; only the network is faked.
 *
 * A local root mirrors `src/cli/root.ts` (which P8a must not edit and which does
 * not yet register these subcommands): same shared global flags, same
 * `Command.provide` order, same `resolveGlobals`. `isOutputTTY` defaults to true
 * so the default format is `table` and the stderr summary line is exercised.
 *
 * P8b has its own `harness.testutil.ts`; this one is separate because P8a needs
 * `HttpCore` (for `video trainability`) and a real `list` implementation that
 * runs the client-side filter (for `search`), neither of which that harness
 * models.
 */

import { Cause, Effect, Exit, Layer, Result, Runtime, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import { exitCodeFor, UsageError } from "../domain/errors.ts"
import type {
  ApiError,
  MissingKeyError,
  MissingOAuthError,
  OAuthError,
  OperationalError,
  OytcError
} from "../domain/errors.ts"
import type { ListResult, PageOptions } from "../domain/listResult.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { RendererLive } from "../impl/renderer.ts"
import { AppOptions, HttpCore, YouTubeApi } from "../services/index.ts"
import type {
  HttpCoreRequest,
  HttpCoreShape,
  Params,
  ResolvedChannel,
  YouTubeApiShape
} from "../services/index.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import { globalFlags } from "./flags.ts"
import { resolveGlobals } from "./globals.ts"

/** One recorded call into a faked service. */
export interface RecordedCall {
  readonly kind: "get" | "list" | "resolveChannel" | "getJson"
  readonly resource: string
  /** Params as a plain object; every command sends each key at most once. */
  readonly params: Record<string, string>
  readonly page?: PageOptions | undefined
  /** `getJson` only. */
  readonly authenticate?: boolean | undefined
}

/** One faked page of a `list` call, before the client-side filter runs. */
export interface Page {
  readonly items: ReadonlyArray<JsonObject>
  readonly nextPageToken?: string | undefined
}

export interface ApiScript {
  /** Consumed in order by `get`; the last entry repeats. */
  readonly get?: ReadonlyArray<DataApiResponse> | undefined
  /**
   * Pages served by `list`. The harness runs the REAL pagination algorithm over
   * them — filter first, then limit, then the `--all` termination rules — so
   * `search`'s filter/limit interaction is genuinely exercised.
   */
  readonly pages?: ReadonlyArray<Page> | undefined
  /** Consumed in order by `getJson`; the last entry repeats. */
  readonly json?: ReadonlyArray<JsonValue> | undefined
  /** Resolved channel ids, in call order; the last entry repeats. */
  readonly channels?: ReadonlyArray<ResolvedChannel> | undefined
  /** When set, every call fails with this error instead. */
  readonly fail?: OytcError | undefined
  /**
   * `HttpCore.getJson`'s error channel is narrower than `OytcError` (it cannot
   * produce a `UsageError` or `NotFoundError`), so a `fail` aimed at the
   * transport goes here instead.
   */
  readonly failJson?: HttpCoreError | undefined
}

/** The exact error union `HttpCore.getJson` may fail with. */
type HttpCoreError =
  | ApiError
  | MissingKeyError
  | MissingOAuthError
  | OAuthError
  | OperationalError

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  /** 0 on success, else the error's `exitCodeFor`. */
  readonly exitCode: number
  /** `undefined` on success. */
  readonly error: OytcError | undefined
  /** The error message exactly as `main.ts` would print it after `oytc: `. */
  readonly message: string | undefined
  readonly calls: ReadonlyArray<RecordedCall>
}

/** Parse a JSON literal into items, for building fake responses concisely. */
export const items = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

/** Parse a JSON literal into one object. */
export const object = (text: string): JsonObject => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as JsonObject
}

/** A `DataApiResponse` from a JSON array literal. */
export const responseOf = (text: string): DataApiResponse => ({
  items: items(text) as DataApiResponse["items"]
})

/** One page from a JSON array literal. */
export const pageOf = (text: string, nextPageToken = ""): Page => ({
  items: items(text),
  nextPageToken
})

const paramsToObject = (params: Params): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of params) out[key] = value
  return out
}

/**
 * The REAL `List` algorithm from `src/impl/youtubeApi.ts`, over scripted pages.
 *
 * Reproduced rather than imported because the impl is welded to `HttpCore`;
 * the loop below is a line-for-line transcription, INCLUDING deviation D2 (a
 * page from which items were discarded reports no resume token).
 */
const runList = (
  pages: ReadonlyArray<Page>,
  options: PageOptions,
  onRequest: () => void
): ListResult => {
  const kept: Array<JsonObject> = []
  let requests = 0
  let nextPageToken = ""
  let index = 0

  for (;;) {
    const page = pages[Math.min(index, Math.max(pages.length - 1, 0))] ?? { items: [] }
    onRequest()
    requests++
    index++

    let pageItems = [...page.items]
    // The filter runs BEFORE the limit, so rejected items do not count toward
    // it and a page can contribute zero items while still consuming a request.
    if (options.filter !== undefined) pageItems = pageItems.filter(options.filter)

    let truncated = false
    if (options.limit > 0 && kept.length + pageItems.length > options.limit) {
      pageItems = pageItems.slice(0, options.limit - kept.length)
      truncated = true
    }
    kept.push(...pageItems)
    nextPageToken = truncated ? "" : (page.nextPageToken ?? "")

    if (
      !options.all ||
      nextPageToken === "" ||
      (options.limit > 0 && kept.length >= options.limit)
    ) {
      break
    }
  }

  return { items: kept, nextPageToken, requests }
}

export interface RunOptions {
  /** Defaults to true, so the default format is `table`. */
  readonly isOutputTTY?: boolean | undefined
  readonly script?: ApiScript | undefined
}

/**
 * Run one command with explicit argv.
 *
 * The command under test is mounted under a root that reproduces root.ts's
 * mandatory composition order: `withSharedFlags` -> `withSubcommands` ->
 * `provide`.
 */
export const runCli = (
  // The concrete Command type is a five-parameter generic whose Input differs
  // per command; the harness only ever passes it to `withSubcommands`.
  command: never,
  argv: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<RunResult> => {
  const isOutputTTY = options.isOutputTTY ?? true
  const script = options.script ?? {}
  const calls: Array<RecordedCall> = []
  const stdout: Array<string> = []
  const stderr: Array<string> = []

  let getIndex = 0
  let jsonIndex = 0
  let channelIndex = 0

  const pick = <A>(source: ReadonlyArray<A> | undefined, index: number, fallback: A): A => {
    if (source === undefined || source.length === 0) return fallback
    return source[Math.min(index, source.length - 1)]!
  }

  const api: YouTubeApiShape = {
    get: (resource, params) =>
      Effect.suspend(() => {
        calls.push({ kind: "get", resource, params: paramsToObject(params) })
        if (script.fail !== undefined) return Effect.fail(script.fail)
        const response = pick(script.get, getIndex, { items: [] } as DataApiResponse)
        getIndex++
        return Effect.succeed(response)
      }),
    list: (resource, params, page) =>
      Effect.suspend(() => {
        if (script.fail !== undefined) {
          calls.push({ kind: "list", resource, params: paramsToObject(params), page })
          return Effect.fail(script.fail)
        }
        const pages = script.pages ?? [{ items: [] }]
        const result = runList(pages, page, () => {
          calls.push({ kind: "list", resource, params: paramsToObject(params), page })
        })
        return Effect.succeed(result)
      }),
    resolveChannel: (reference) =>
      Effect.suspend(() => {
        calls.push({ kind: "resolveChannel", resource: reference, params: {} })
        if (script.fail !== undefined) return Effect.fail(script.fail)
        const resolved = pick(script.channels, channelIndex, {
          id: reference,
          requests: 1
        } satisfies ResolvedChannel)
        channelIndex++
        return Effect.succeed(resolved)
      })
  }

  const core: HttpCoreShape = {
    getJson: (request: HttpCoreRequest) =>
      Effect.suspend(() => {
        calls.push({
          kind: "getJson",
          resource: request.resource,
          params: paramsToObject(request.params),
          authenticate: request.authenticate
        })
        if (script.failJson !== undefined) return Effect.fail(script.failJson)
        const body: JsonValue = pick(script.json, jsonIndex, {} as JsonValue)
        jsonIndex++
        return Effect.succeed(body)
      })
  }

  const decode = (input: string | Uint8Array): string =>
    typeof input === "string" ? input : new TextDecoder().decode(input)

  const stdio = Stdio.layerTest({
    stdout: () =>
      Sink.forEach((input: string | Uint8Array) => Effect.sync(() => stdout.push(decode(input)))),
    stderr: () =>
      Sink.forEach((input: string | Uint8Array) => Effect.sync(() => stderr.push(decode(input))))
  })

  const testLayer = Layer.mergeAll(
    stdio,
    Layer.succeed(YouTubeApi, api),
    Layer.succeed(HttpCore, core),
    RendererLive.pipe(Layer.provide(stdio))
  )

  const root = mountRoot(command, isOutputTTY)

  return Effect.runPromise(
    Effect.exit(
      Command.runWith(root, { version: "test" })(argv).pipe(
        Effect.provide(testLayer)
      ) as Effect.Effect<void, unknown>
    )
  ).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return {
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode: 0,
        error: undefined,
        message: undefined,
        calls
      }
    }
    const squashed = Cause.squash(exit.cause) as {
      readonly _tag?: string
      readonly message?: string
      readonly [Runtime.errorExitCode]?: number
    }
    const tagged = isOytcError(squashed) ? squashed : undefined
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode: tagged === undefined ? frameworkExitCode(squashed) : exitCodeFor(tagged),
      error: tagged,
      message: tagged?.message ?? squashed.message,
      calls
    }
  })
}

/**
 * Exit code for an error raised by the CLI framework rather than by a handler.
 *
 * `CliError.ShowHelp` carries `Runtime.errorExitCode` directly, and it is **0**
 * when `errors` is empty — that is the `oytc video` / `--help` path, which Go
 * also exits 0 on. A non-empty `errors` list (unknown flag, unknown subcommand,
 * bad choice) is exit 1 in the framework where Go exits 2, so it is translated
 * here exactly as `main.ts` does.
 */
const frameworkExitCode = (error: { readonly [Runtime.errorExitCode]?: number }): number => {
  const code = error[Runtime.errorExitCode]
  return code === 0 ? 0 : 2
}

const OYTC_TAGS = new Set([
  "UsageError",
  "MissingKeyError",
  "MissingOAuthError",
  "ApiError",
  "OAuthError",
  "AuthHintError",
  "NotFoundError",
  "OperationalError",
  "CancelledError"
])

const isOytcError = (u: { readonly _tag?: string }): u is OytcError =>
  typeof u._tag === "string" && OYTC_TAGS.has(u._tag)

/** The local stand-in for `src/cli/root.ts`. */
const mountRoot = (command: never, isOutputTTY: boolean) =>
  Command.make("oytc").pipe(
    Command.withSharedFlags(globalFlags),
    Command.withSubcommands([command]),
    Command.provide((input) =>
      Layer.effect(
        AppOptions,
        Effect.suspend(() => {
          const resolved = resolveGlobals(input, { isOutputTTY })
          return Result.isFailure(resolved)
            ? Effect.fail(resolved.failure)
            : Effect.succeed(resolved.success)
        })
      )
    )
  )

/** The single stderr line a table render appends. */
export const summaryLine = (itemCount: number, requests: number, nextPageToken = ""): string =>
  `${itemCount} item(s), ${requests} request(s)${
    nextPageToken === "" ? "" : `; more available (next token: ${nextPageToken})`
  }\n`

/** Assert a usage failure with an exact message, and that no request was made. */
export const expectUsage = (result: RunResult, message: string): void => {
  if (!(result.error instanceof UsageError)) {
    throw new Error(
      `expected UsageError, got ${String(result.error?._tag)}: ${String(result.message)}`
    )
  }
  if (result.message !== message) {
    throw new Error(
      `expected message ${JSON.stringify(message)}, got ${JSON.stringify(result.message)}`
    )
  }
  if (result.exitCode !== 2) throw new Error(`expected exit 2, got ${result.exitCode}`)
  if (result.calls.length !== 0) {
    throw new Error(`expected no requests, got ${result.calls.length}`)
  }
}

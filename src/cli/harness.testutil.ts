/**
 * Test harness for the P8b command tests.
 *
 * Not a `.test.ts` — bun would try to run it as a suite. It is imported by
 * `playlist.test.ts`, `comment.test.ts`, `subscription.test.ts` and
 * `catalog.test.ts`.
 *
 * `runCli` drives a command through the REAL `Command.runWith` with explicit
 * argv, a real `RendererLive` over a capturing `Stdio`, and a scripted
 * `YouTubeApi` that records every request. That means flag parsing, defaulting,
 * validation order, param assembly, pagination options and rendering are all
 * under test end-to-end — only the network is faked.
 *
 * A local root command mirrors `src/cli/root.ts` (which this package must not
 * edit and which does not yet register these subcommands): same shared global
 * flags, same `Command.provide` order, same `resolveGlobals`. `isOutputTTY`
 * defaults to true so the default format is `table` and the stderr summary line
 * is exercised.
 */

import { Cause, Effect, Exit, Layer, Result, Runtime, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import { exitCodeFor, UsageError } from "../domain/errors.ts"
import type { OytcError } from "../domain/errors.ts"
import type { ListResult, PageOptions } from "../domain/listResult.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonObject } from "../json/value.ts"
import { RendererLive } from "../impl/renderer.ts"
import { AppOptions, YouTubeApi } from "../services/index.ts"
import type { Params, ResolvedChannel, YouTubeApiShape } from "../services/index.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import { globalFlags } from "./flags.ts"
import { resolveGlobals } from "./globals.ts"

/** One recorded call into the fake YouTube API. */
export interface RecordedCall {
  readonly kind: "get" | "list" | "resolveChannel"
  readonly resource: string
  /** Params as a plain object; every command sends each key at most once. */
  readonly params: Record<string, string>
  readonly page?: PageOptions | undefined
}

export interface ApiScript {
  /** Consumed in order by `get`; the last entry repeats. */
  readonly get?: ReadonlyArray<DataApiResponse> | undefined
  /** Consumed in order by `list`; the last entry repeats. */
  readonly list?: ReadonlyArray<ListResult> | undefined
  /** When set, every call fails with this error instead. */
  readonly fail?: OytcError | undefined
}

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

/** A `ListResult` from a JSON array literal. */
export const listOf = (text: string, requests = 1, nextPageToken = ""): ListResult => ({
  items: items(text),
  nextPageToken,
  requests
})

/** A `DataApiResponse` from a JSON array literal. */
export const responseOf = (text: string): DataApiResponse => ({
  items: items(text) as DataApiResponse["items"]
})

const paramsToObject = (params: Params): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of params) out[key] = value
  return out
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command: any,
  argv: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<RunResult> => {
  const isOutputTTY = options.isOutputTTY ?? true
  const script = options.script ?? {}
  const calls: Array<RecordedCall> = []
  const stdout: Array<string> = []
  const stderr: Array<string> = []

  let getIndex = 0
  let listIndex = 0

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
        calls.push({ kind: "list", resource, params: paramsToObject(params), page })
        if (script.fail !== undefined) return Effect.fail(script.fail)
        const result = pick(script.list, listIndex, {
          items: [],
          nextPageToken: "",
          requests: 1
        } as ListResult)
        listIndex++
        return Effect.succeed(result)
      }),
    resolveChannel: (reference) =>
      Effect.suspend(() => {
        calls.push({ kind: "resolveChannel", resource: reference, params: {} })
        if (script.fail !== undefined) return Effect.fail(script.fail)
        return Effect.succeed({ id: reference, requests: 1 } satisfies ResolvedChannel)
      })
  }

  const stdio = Stdio.layerTest({
    stdout: () =>
      Sink.forEach((input: string | Uint8Array) =>
        Effect.sync(() => {
          stdout.push(typeof input === "string" ? input : new TextDecoder().decode(input))
        })
      ),
    stderr: () =>
      Sink.forEach((input: string | Uint8Array) =>
        Effect.sync(() => {
          stderr.push(typeof input === "string" ? input : new TextDecoder().decode(input))
        })
      )
  })

  const testLayer = Layer.mergeAll(
    stdio,
    Layer.succeed(YouTubeApi, api),
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
 * when `errors` is empty — that is the `oytc playlist` / `--help` path, which
 * Go also exits 0 on. A non-empty `errors` list (unknown flag, unknown
 * subcommand, bad choice) is exit 1 in the framework where Go exits 2, so it is
 * translated here.
 */
const frameworkExitCode = (error: { readonly [Runtime.errorExitCode]?: number }): number => {
  const code = error[Runtime.errorExitCode]
  if (code === 0) return 0
  return 2
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountRoot = (command: any, isOutputTTY: boolean) =>
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

/** Assert helper: the single stderr line a table render appends. */
export const summaryLine = (itemCount: number, requests: number, nextPageToken = ""): string =>
  `${itemCount} item(s), ${requests} request(s)${
    nextPageToken === "" ? "" : `; more available (next token: ${nextPageToken})`
  }\n`

/** Every usage failure in this package must precede any HTTP call. */
export const expectUsage = (result: RunResult, message: string): void => {
  if (!(result.error instanceof UsageError)) {
    throw new Error(`expected UsageError, got ${String(result.error?._tag)}: ${String(result.message)}`)
  }
  if (result.message !== message) {
    throw new Error(`expected message ${JSON.stringify(message)}, got ${JSON.stringify(result.message)}`)
  }
}

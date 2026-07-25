/**
 * `oytc playlist {get,list,items}` — ports `playlistCommand()` and friends from
 * `internal/cli/resources.go`.
 *
 * ---------------------------------------------------------------------------
 * SHARED HELPERS LIVE HERE, TEMPORARILY
 * ---------------------------------------------------------------------------
 * P8a owns `src/cli/{fields,validate,render}.ts` and is expected to export the
 * same helpers this file defines below (`fieldsWithRequired`, `validateEnum`,
 * `renderResult`, …). Those modules were still empty stubs when this package
 * was written, so the helpers are defined here — in a file this package owns —
 * rather than imported from a stub that would not compile.
 *
 * They are direct ports of the Go originals, so once P8a lands the orchestrator
 * can replace the marked section with re-exports from those modules.
 * `comment.ts`, `subscription.ts` and `catalog.ts` import them from here, so one
 * re-export keeps those three files untouched.
 * ---------------------------------------------------------------------------
 */

import { Effect, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { NotFoundError, OperationalError, UsageError } from "../domain/errors.ts"
import type { OytcError } from "../domain/errors.ts"
import type { ListResult, PageOptions } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import {
  playlistGetColumns,
  playlistItemsColumns,
  playlistListColumns
} from "../output/columns.ts"
import { AppOptions, Renderer, YouTubeApi } from "../services/index.ts"
import type { AppOptionsShape, Params, RendererShape, YouTubeApiShape } from "../services/index.ts"
// Read-only import of P8a's shared helper. `goTrimSpace` is `strings.TrimSpace`
// (unicode.IsSpace), which is NOT the same set as JS `String.prototype.trim()`:
// JS trims U+FEFF, which Go does not consider space, and JS does not trim U+0085
// (NEL) or U+00A0 (NBSP), which Go does. Both directions were confirmed against
// /tmp/oytc-ref via `subscription list --parts "<space>subscriberSnippet"`.
import { goTrimSpace } from "./validate.ts"

// ===========================================================================
// BEGIN shared helpers — mirrors P8a src/cli/{validate,fields,render}.ts
// ===========================================================================

/** Everything a data command needs from the environment. */
export type CommandServices = AppOptionsShape | RendererShape | Stdio.Stdio | YouTubeApiShape

// ---------------------------------------------------------------------------
// Flag groups (Go: addListFlags / addAPIFlags)
// ---------------------------------------------------------------------------

/**
 * `addListFlags(cmd, &flags, defaultSize, maxSize)`.
 *
 * Bounds are NOT uniform: `comment replies`/`threads` are 1..100 default 20,
 * `playlist items` defaults to 50, `playlist list`/`subscription list` default
 * to 25 max 50, and the catalog commands take no pagination flags at all.
 * `maxSize` is threaded to `validateListFlags` because it appears verbatim in
 * both the flag description and the error message.
 */
export const listFlags = (defaultSize: number, maxSize: number) =>
  ({
    // cobra appends `(default N)` for any non-zero default; Effect's help
    // renderer does not, so the suffix is written into the description to keep
    // `--help` output comparable. Flags whose default is a zero value (`--limit
    // 0`, `--page-token ""`, `--all false`) get no suffix, matching cobra.
    pageSize: Flag.integer("page-size").pipe(
      Flag.withDefault(defaultSize),
      Flag.withDescription(`results per request (1-${maxSize}) (default ${defaultSize})`)
    ),
    pageToken: Flag.string("page-token").pipe(
      Flag.withDefault(""),
      Flag.withDescription("start at this API page token")
    ),
    all: Flag.boolean("all").pipe(Flag.withDescription("fetch all available pages")),
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(0),
      Flag.withDescription("maximum items to emit (0 means no additional limit)")
    )
  }) as const

export interface ListFlagValues {
  readonly pageSize: number
  readonly pageToken: string
  readonly all: boolean
  readonly limit: number
}

/**
 * Go's `cmd.PreRunE`: page size first, then limit. Both fire before any HTTP
 * request and before the RunE semantic checks — verified against the reference
 * binary, e.g. `playlist list --page-size 999` reports the page size even
 * though `--channel` is also missing.
 */
export const validateListFlags = (
  flags: ListFlagValues,
  maxSize: number
): UsageError | undefined => {
  if (flags.pageSize < 1 || flags.pageSize > maxSize) {
    return new UsageError({ message: `--page-size must be between 1 and ${maxSize}` })
  }
  if (flags.limit < 0) return new UsageError({ message: "--limit cannot be negative" })
  return undefined
}

/** `listFlags` -> the client's `PageOptions`. */
export const pageOptions = (flags: ListFlagValues): PageOptions => ({
  all: flags.all,
  limit: flags.limit,
  pageSize: flags.pageSize,
  pageToken: flags.pageToken
})

/** `addAPIFlags(cmd, &api, false)` — no `--hl`. */
export const apiFlags = {
  parts: Flag.string("parts").pipe(
    Flag.withDefault(""),
    Flag.withDescription("comma-separated API resource parts")
  ),
  fields: Flag.string("fields").pipe(
    Flag.withDefault(""),
    Flag.withDescription("Google partial-response fields selector")
  )
} as const

/** `addAPIFlags(cmd, &api, true)` — adds `--hl`. */
export const apiFlagsWithHl = {
  ...apiFlags,
  hl: Flag.string("hl").pipe(
    Flag.withDefault(""),
    Flag.withDescription("localization language code")
  )
} as const

// ---------------------------------------------------------------------------
// Parameter assembly (Go: partsOr / setValues)
// ---------------------------------------------------------------------------

/**
 * `partsOr` — whitespace-only counts as unset, but the value is NOT trimmed.
 *
 * `goTrimSpace`, not `String.prototype.trim`: `--parts "<U+FEFF>"` must reach
 * the API verbatim (Go does not treat U+FEFF as space), while `--parts "<NEL>"`
 * must fall back to the default (Go does).
 */
export const partsOr = (value: string, fallback: string): string =>
  goTrimSpace(value) === "" ? fallback : value

/**
 * `setValues(params, map)` — appends every entry with a non-empty value. Go
 * ranges over a map so its order is unspecified; here it is the caller's, and
 * `HttpCore` sorts at encode time either way.
 */
export const setValues = (
  params: Params,
  entries: ReadonlyArray<readonly [string, string]>
): Params => [...params, ...entries.filter(([, value]) => value !== "")]

// ---------------------------------------------------------------------------
// Enum / part validation (Go: validateEnum / validateParts)
// ---------------------------------------------------------------------------

/**
 * `validateEnum` — an EMPTY value always passes. Load-bearing: most of these
 * flags default to `""` meaning "do not send this parameter at all".
 */
export const validateEnum = (
  flag: string,
  value: string,
  ...allowed: ReadonlyArray<string>
): UsageError | undefined => {
  if (value === "") return undefined
  if (allowed.includes(value)) return undefined
  return new UsageError({ message: `${flag} must be one of: ${allowed.join(", ")}` })
}

/**
 * `validateParts` — rejects owner-only parts. Each comma-separated segment is
 * trimmed with Go's `strings.TrimSpace` first, so `--parts " subscriberSnippet "`
 * is caught too (confirmed against the reference binary), and a U+FEFF-prefixed
 * segment is NOT (Go does not treat it as space, so the part is sent as-is).
 */
export const validateParts = (
  parts: string,
  ...forbidden: ReadonlyArray<string>
): UsageError | undefined => {
  for (const value of parts.split(",")) {
    for (const blocked of forbidden) {
      if (goTrimSpace(value) === blocked) {
        return new UsageError({
          message: `part "${blocked}" requires owner/OAuth access and is not supported`
        })
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Positional arity (Go: exactArgs / minimumArgs)
// ---------------------------------------------------------------------------

/**
 * Arity is checked in the handler rather than by the `Argument` primitive.
 *
 * Three framework options were measured, none of which reproduces Go exactly:
 *
 *   - `Argument.variadic({ min, max })` rejects at parse time but emits the
 *     framework's own text ("Invalid value for argument <ID>: \"0 values\"").
 *   - `Argument.between(1, 1)` silently DISCARDS extra positionals rather than
 *     failing, so `playlist items a b` would succeed.
 *   - `Argument.filter(pred, onFalse)` orders correctly (it runs before
 *     `Command.provide`) but wraps the message as
 *     `Invalid value for argument <ID>: "a,b". Expected: <text>` and routes it
 *     through `ShowHelp`, which dumps the help block Go's `SilenceUsage`
 *     suppresses.
 *
 * The verbatim messages are golden-verified in `/tmp/goldens/validation.txt`
 * ("expected 1 argument(s), received 0"), so an unbounded `Argument.variadic()`
 * plus these handler-side checks is the faithful port.
 *
 * KNOWN DIVERGENCE (single case, not golden-pinned): a global-flag failure now
 * beats an arity failure, because `Command.provide` builds `AppOptions` before
 * the handler runs. `oytc --timeout 0 playlist items` reports
 * `--timeout must be positive` where Go reports
 * `expected 1 argument(s), received 0`. Every OTHER ordering matches, including
 * the golden `--format bogus … --page-size 999 x` case, because a bad
 * `--format` is rejected by `Flag.choice` at parse time. Fixing this would
 * require `AppOptions` to be forced lazily inside the handler, which means
 * changing `root.ts`/`globals.ts` — files this package does not own.
 */
export const exactArgs = (count: number, args: ReadonlyArray<string>): UsageError | undefined =>
  args.length === count
    ? undefined
    : new UsageError({ message: `expected ${count} argument(s), received ${args.length}` })

export const minimumArgs = (count: number, args: ReadonlyArray<string>): UsageError | undefined =>
  args.length >= count
    ? undefined
    : new UsageError({
        message: `expected at least ${count} argument(s), received ${args.length}`
      })

// ---------------------------------------------------------------------------
// Field selector grammar (Go: internal/cli/fields.go)
// ---------------------------------------------------------------------------

const NAME_STOP = "/(), \t\r\n"
const SPACE = " \t\r\n"

class FieldSelectorParser {
  position = 0
  constructor(readonly selector: string) {}

  parseList(prefix: ReadonlyArray<string>, terminator: string): Array<string> {
    const paths: Array<string> = []
    while (this.position < this.selector.length) {
      this.skipSpacesAndCommas()
      if (this.position >= this.selector.length) break
      if (terminator !== "" && this.selector[this.position] === terminator) {
        this.position++
        break
      }
      paths.push(...this.parseField(prefix))
    }
    return paths
  }

  parseField(prefix: ReadonlyArray<string>): Array<string> {
    const name = this.readName()
    if (name === "") {
      this.position++
      return []
    }
    const path = [...prefix, name]
    this.skipSpaces()
    if (this.position >= this.selector.length) return [path.join("/")]
    switch (this.selector[this.position]) {
      case "/":
        this.position++
        this.skipSpaces()
        return this.parseField(path)
      case "(":
        this.position++
        return this.parseList(path, ")")
      default:
        return [path.join("/")]
    }
  }

  readName(): string {
    const start = this.position
    while (
      this.position < this.selector.length &&
      !NAME_STOP.includes(this.selector[this.position]!)
    ) {
      this.position++
    }
    return this.selector.slice(start, this.position)
  }

  skipSpacesAndCommas(): void {
    while (this.position < this.selector.length) {
      const ch = this.selector[this.position]!
      if (ch !== "," && !SPACE.includes(ch)) break
      this.position++
    }
  }

  skipSpaces(): void {
    while (this.position < this.selector.length && SPACE.includes(this.selector[this.position]!)) {
      this.position++
    }
  }
}

/** `fieldSelectorIncludes` — does `selector` already cover `target`? */
export const fieldSelectorIncludes = (selector: string, target: string): boolean => {
  for (const path of new FieldSelectorParser(selector).parseList([], "")) {
    const wildcardParent = path.endsWith("/*") ? path.slice(0, -2) : path
    if (
      path === "*" ||
      path === "items" ||
      path === target ||
      path.startsWith(`${target}/`) ||
      target.startsWith(`${path}/`) ||
      (wildcardParent !== path && target.startsWith(`${wildcardParent}/`))
    ) {
      return true
    }
  }
  return false
}

/**
 * `fieldsWithRequired(fields, required)` -> `[requestFields, preserve]`.
 *
 * When `--fields` does not already cover `required`, the selector is widened so
 * the API still returns the field the CLI needs internally, and `preserve` comes
 * back false so that field is deleted again before rendering.
 */
export const fieldsWithRequired = (
  fields: string,
  required: string
): readonly [string, boolean] =>
  fields === "" || fieldSelectorIncludes(fields, required)
    ? [fields, true]
    : [`${fields},${required}`, false]

/** `stripItemIDs` — drops the injected `id` key when it was not requested. */
export const stripItemIDs = (
  items: ReadonlyArray<JsonObject>,
  preserve: boolean
): ReadonlyArray<JsonObject> => {
  if (preserve) return items
  return items.map((item) => {
    const { id: _id, ...rest } = item
    return rest as JsonObject
  })
}

// ---------------------------------------------------------------------------
// Batched by-ID lookups (Go: batch / validateRequestedItems)
// ---------------------------------------------------------------------------

/** `batch(values, size)`. */
export const batch = <A>(
  values: ReadonlyArray<A>,
  size: number
): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < values.length; i += size) batches.push(values.slice(i, i + size))
  return batches
}

/**
 * `validateRequestedItems`.
 *
 * The equal-cardinality escape hatch matters: `--fields` may legitimately omit
 * `id`, so when NO item carries an id and the count equals the number of
 * distinct requested ids, the lookup is accepted rather than reported as
 * entirely missing.
 */
export const validateRequestedItems = (
  resource: string,
  requested: ReadonlyArray<string>,
  items: ReadonlyArray<JsonObject>
): NotFoundError | undefined => {
  const seen = new Set<string>()
  const uniqueRequested: Array<string> = []
  for (const id of requested) {
    if (!seen.has(id)) {
      seen.add(id)
      uniqueRequested.push(id)
    }
  }

  const returned = new Set<string>()
  for (const item of items) {
    const id = item["id"]
    if (typeof id === "string" && id !== "") returned.add(id)
  }
  if (returned.size === 0 && items.length === uniqueRequested.length) return undefined

  let missing: ReadonlyArray<string> = []
  if (returned.size > 0) {
    missing = uniqueRequested.filter((id) => !returned.has(id))
  } else if (items.length < uniqueRequested.length) {
    missing = uniqueRequested
  }
  if (missing.length === 0) return undefined
  return new NotFoundError({ message: `${resource} not found: ${missing.join(", ")}` })
}

// ---------------------------------------------------------------------------
// Rendering (Go: App.renderResult)
// ---------------------------------------------------------------------------

const writeStderr = (text: string): Effect.Effect<void, OperationalError, Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stderr()).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write summary", cause }))
      )
    )
  })

/**
 * Render the result, then — only for `table` output and only when `--quiet` is
 * unset — emit the one-line request summary on stderr:
 * `"%d item(s), %d request(s)"`, optionally `"; more available (next token: %s)"`.
 */
export const renderResult = (
  result: ListResult,
  defaultColumns: ReadonlyArray<string>
): Effect.Effect<void, OytcError, AppOptionsShape | RendererShape | Stdio.Stdio> =>
  Effect.gen(function* () {
    const options = yield* AppOptions
    const renderer = yield* Renderer
    const columns = options.columns.length > 0 ? options.columns : defaultColumns
    yield* renderer.render(result, {
      format: options.format,
      columns,
      noHeader: options.noHeader
    })
    if (options.quiet || options.format !== "table") return
    const more =
      result.nextPageToken === "" ? "" : `; more available (next token: ${result.nextPageToken})`
    yield* writeStderr(`${result.items.length} item(s), ${result.requests} request(s)${more}\n`)
  })

/**
 * `App.runList`.
 *
 * The credential check lives inside `YouTubeApi`, so every usage error raised
 * before this call is guaranteed to precede any HTTP traffic — the property
 * `/tmp/goldens/validation.txt` pins.
 */
export const runList = (
  resource: string,
  params: Params,
  flags: ListFlagValues,
  defaultColumns: ReadonlyArray<string>
): Effect.Effect<void, OytcError, CommandServices> =>
  Effect.gen(function* () {
    const api = yield* YouTubeApi
    const result = yield* api.list(resource, params, pageOptions(flags))
    yield* renderResult(result, defaultColumns)
  })

/**
 * The shared body of `playlist get` and `comment get`: one request per batch of
 * ids, results concatenated, then the not-found check.
 *
 * `batchSize` is 50 for playlists and **100** for comments.
 */
export const runBatchGet = (options: {
  readonly resource: string
  readonly ids: ReadonlyArray<string>
  readonly batchSize: number
  readonly part: string
  readonly fields: string
  /** Extra params per request, excluding `part`, `id` and `fields`. */
  readonly extra: ReadonlyArray<readonly [string, string]>
  readonly defaultColumns: ReadonlyArray<string>
}): Effect.Effect<void, OytcError, CommandServices> =>
  Effect.gen(function* () {
    const api = yield* YouTubeApi
    const [requestFields, preserveID] = fieldsWithRequired(options.fields, "items/id")

    const collected: Array<JsonObject> = []
    let requests = 0
    for (const group of batch(options.ids, options.batchSize)) {
      const params = setValues(
        [
          ["part", options.part],
          ["id", group.join(",")]
        ],
        [...options.extra, ["fields", requestFields]]
      )
      const response = yield* api.get(options.resource, params)
      collected.push(...((response.items ?? []) as ReadonlyArray<JsonObject>))
      requests++
    }

    const notFound = validateRequestedItems(options.resource, options.ids, collected)
    if (notFound !== undefined) return yield* Effect.fail(notFound)

    yield* renderResult(
      { items: stripItemIDs(collected, preserveID), nextPageToken: "", requests },
      options.defaultColumns
    )
  })

// ===========================================================================
// END shared helpers
// ===========================================================================

/** `playlist get <PLAYLIST_ID>...` — batch size 50, `minimumArgs(1)`. */
export const playlistGetCommand = Command.make(
  "get",
  {
    args: Argument.string("PLAYLIST_ID").pipe(Argument.variadic()),
    ...apiFlagsWithHl
  },
  (input) =>
    Effect.gen(function* () {
      const arity = minimumArgs(1, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      yield* runBatchGet({
        resource: "playlists",
        ids: input.args,
        batchSize: 50,
        part: partsOr(input.parts, "snippet,contentDetails,status"),
        fields: input.fields,
        extra: [["hl", input.hl]],
        defaultColumns: playlistGetColumns
      })
    })
).pipe(Command.withDescription("Get playlists by ID"))

/**
 * `playlist list --channel <ID>`.
 *
 * `--channel` is required, and that check runs in RunE — AFTER the pagination
 * bounds, which is why `playlist list --page-size 999` reports the page size
 * rather than the missing channel.
 */
export const playlistListCommand = Command.make(
  "list",
  {
    args: Argument.string("ARG").pipe(Argument.variadic()),
    channel: Flag.string("channel").pipe(
      Flag.withDefault(""),
      Flag.withDescription("channel ID (required)")
    ),
    ...listFlags(25, 50),
    ...apiFlagsWithHl
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(0, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const bounds = validateListFlags(input, 50)
      if (bounds !== undefined) return yield* Effect.fail(bounds)
      if (input.channel === "") {
        return yield* Effect.fail(new UsageError({ message: "--channel is required" }))
      }
      const params = setValues(
        [
          ["part", partsOr(input.parts, "snippet,contentDetails,status")],
          ["channelId", input.channel]
        ],
        [
          ["hl", input.hl],
          ["fields", input.fields]
        ]
      )
      yield* runList("playlists", params, input, playlistListColumns)
    })
).pipe(Command.withDescription("List a channel's public playlists"))

/** `playlist items <PLAYLIST_ID>` — default page size 50 (not 25), max 50, no `--hl`. */
export const playlistItemsCommand = Command.make(
  "items",
  {
    args: Argument.string("PLAYLIST_ID").pipe(Argument.variadic()),
    video: Flag.string("video").pipe(
      Flag.withDefault(""),
      Flag.withDescription("only items for this video ID")
    ),
    ...listFlags(50, 50),
    ...apiFlags
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(1, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const bounds = validateListFlags(input, 50)
      if (bounds !== undefined) return yield* Effect.fail(bounds)
      const params = setValues(
        [
          ["part", partsOr(input.parts, "snippet,contentDetails,status")],
          ["playlistId", input.args[0]!]
        ],
        [
          ["videoId", input.video],
          ["fields", input.fields]
        ]
      )
      yield* runList("playlistItems", params, input, playlistItemsColumns)
    })
).pipe(Command.withDescription("List items in a playlist"))

/** The `playlist` group. Bare `oytc playlist` prints help and exits 0. */
export const playlistCommand = Command.make("playlist").pipe(
  Command.withDescription("Read playlists and playlist items"),
  Command.withSubcommands([playlistGetCommand, playlistListCommand, playlistItemsCommand])
)

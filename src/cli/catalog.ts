/**
 * `oytc category list`, `oytc language list`, `oytc region list` — ports
 * `categoryCommand()`, `languageCommand()` and `regionCommand()` from
 * `internal/cli/resources.go`.
 *
 * These three are the CLI's only list commands with **no pagination flags at
 * all**: Go passes a zero-valued `listFlags{}` to `runList`, so `--page-size`,
 * `--page-token`, `--all` and `--limit` do not exist (the reference binary
 * answers `unknown flag: --page-size`), `maxResults` is never sent, and there is
 * no PreRunE bounds check to run. They do take the metadata flags — `--parts`,
 * `--fields` and `--hl` — plus, for `category`, `--region` and `--id`.
 *
 * Each is its own TOP-LEVEL group: `oytc category`, `oytc language`,
 * `oytc region`. They are exported individually and as `catalogCommands` so the
 * orchestrator can splat all three into root's subcommand list.
 */

import { Effect } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { UsageError } from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import { categoryListColumns, languageListColumns, regionListColumns } from "../output/columns.ts"
import { YouTubeApi } from "../services/index.ts"
import type { OytcError } from "../domain/errors.ts"
import type { Params } from "../services/index.ts"
import {
  apiFlagsWithHl,
  exactArgs,
  partsOr,
  renderResult,
  setValues,
  type CommandServices
} from "./playlist.ts"

/**
 * `runList` with Go's zero-valued `listFlags{}`.
 *
 * Spelled out rather than reusing `pageOptions`, because the point is that
 * nothing here comes from a flag: `pageSize: 0` means "send no maxResults" and
 * `all: false` means "one request, never follow nextPageToken".
 */
const runCatalogList = (
  resource: string,
  params: Params,
  defaultColumns: ReadonlyArray<string>
): Effect.Effect<void, OytcError, CommandServices> =>
  Effect.gen(function* () {
    const api = yield* YouTubeApi
    const result: ListResult = yield* api.list(resource, params, {
      all: false,
      limit: 0,
      pageSize: 0,
      pageToken: ""
    })
    yield* renderResult(result, defaultColumns)
  })

/**
 * `category list` — exactly one of `--region` or `--id`.
 *
 * Go's `(region == "") == (ids == "")` rejects both-set and neither-set with the
 * same message.
 */
export const categoryListCommand = Command.make(
  "list",
  {
    args: Argument.string("ARG").pipe(Argument.variadic()),
    region: Flag.string("region").pipe(
      Flag.withDefault(""),
      Flag.withDescription("ISO 3166-1 alpha-2 region code")
    ),
    id: Flag.string("id").pipe(
      Flag.withDefault(""),
      Flag.withDescription("comma-separated category IDs")
    ),
    ...apiFlagsWithHl
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(0, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      if ((input.region === "") === (input.id === "")) {
        return yield* Effect.fail(
          new UsageError({ message: "provide exactly one of --region or --id" })
        )
      }
      const params = setValues(
        [["part", partsOr(input.parts, "snippet")]],
        [
          ["regionCode", input.region],
          ["id", input.id],
          ["hl", input.hl],
          ["fields", input.fields]
        ]
      )
      yield* runCatalogList("videoCategories", params, categoryListColumns)
    })
).pipe(Command.withDescription("List categories by region or IDs"))

export const categoryCommand = Command.make("category").pipe(
  Command.withDescription("Read YouTube video categories"),
  Command.withSubcommands([categoryListCommand])
)

/** `language list` — no filters beyond the metadata flags. */
export const languageListCommand = Command.make(
  "list",
  {
    args: Argument.string("ARG").pipe(Argument.variadic()),
    ...apiFlagsWithHl
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(0, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const params = setValues(
        [["part", partsOr(input.parts, "snippet")]],
        [
          ["hl", input.hl],
          ["fields", input.fields]
        ]
      )
      yield* runCatalogList("i18nLanguages", params, languageListColumns)
    })
).pipe(Command.withDescription("List supported YouTube UI languages"))

export const languageCommand = Command.make("language").pipe(
  Command.withDescription("Read supported YouTube UI languages"),
  Command.withSubcommands([languageListCommand])
)

/** `region list` — identical shape to `language list`, different resource. */
export const regionListCommand = Command.make(
  "list",
  {
    args: Argument.string("ARG").pipe(Argument.variadic()),
    ...apiFlagsWithHl
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(0, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const params = setValues(
        [["part", partsOr(input.parts, "snippet")]],
        [
          ["hl", input.hl],
          ["fields", input.fields]
        ]
      )
      yield* runCatalogList("i18nRegions", params, regionListColumns)
    })
).pipe(Command.withDescription("List supported YouTube regions"))

export const regionCommand = Command.make("region").pipe(
  Command.withDescription("Read supported YouTube regions"),
  Command.withSubcommands([regionListCommand])
)

/** All three catalog groups, in the order Go's `root.AddCommand` registers them. */
export const catalogCommands = [categoryCommand, languageCommand, regionCommand] as const

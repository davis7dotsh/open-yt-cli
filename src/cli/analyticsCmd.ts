/**
 * `analytics {report,overview,video,traffic-sources,demographics}` — the port
 * of `internal/cli/analytics.go`.
 *
 * Four subcommands are fixed presets over one shared runner; only `report`
 * takes user-supplied metrics and dimensions. All five carry the same
 * `--start/--end/--filters/--sort/--limit` flag set.
 *
 * ## The date defaults are materialized at CONSTRUCTION time
 *
 * Go computed `end = now().UTC().AddDate(0,0,-1)` and `start = end - 27 days`
 * inside `addAnalyticsFlags`, i.e. while building the command tree, and passed
 * the formatted strings as the flag defaults. Two consequences the port must
 * keep:
 *
 *   - the literal dates appear in `--help` output;
 *   - a long-running process would keep the window it started with.
 *
 * `DEFAULT_RANGE` is therefore a module-level constant, evaluated once when the
 * command module is first imported. The window is 28 INCLUSIVE days ending
 * yesterday (`end - 27`, not `end - 28`) and is computed in UTC, so a machine
 * in UTC+13 reports the same window as one in UTC-8.
 *
 * ## Filter merging
 *
 * `analytics video <ID>` sets a built-in filter `video==<ID>`. When `--filters`
 * is ALSO supplied the two are joined with a semicolon, built-in first:
 * `video==ID;<user>`. For the other four subcommands the filter is just
 * `--filters`. An empty built-in filter and an empty user filter both collapse
 * to no `filters` parameter at all.
 *
 * ## Validation order
 *
 * Subcommand-specific check (`--metrics` required / `--by` enum) runs FIRST,
 * then dates, then `--limit`, then the credential load. Every one of those
 * precedes any network traffic. The date check is a round-trip reformat, so
 * `2026-1-05` is rejected even though Go's parser accepts it — the reformatted
 * value differs from the input.
 */

import { Effect, Stdio, Stream } from "effect"
import { Command, Flag, Argument } from "../effect.ts"
import { MissingOAuthError, OperationalError, UsageError } from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import { oauthAuthHint } from "./auth.ts"
import {
  analyticsListResult,
  defaultDateRange,
  MAX_RESULTS
} from "../impl/analyticsApi.ts"
import {
  analyticsDemographicsColumns,
  analyticsOverviewColumns,
  analyticsOverviewMetrics,
  analyticsReportColumns,
  analyticsTrafficSourcesColumns,
  analyticsVideoColumns
} from "../output/columns.ts"
import {
  AnalyticsApi,
  AppOptions,
  CredentialStore,
  Renderer,
  type AppOptionsShape
} from "../services/index.ts"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Go's `renderResult`: render, then a one-line stderr summary but ONLY for
 * `--format table` and only when `--quiet` is absent.
 *
 * P8a owns `src/cli/render.ts` and will export the shared version of this; it
 * is still a stub, so an identical local copy lives here. Analytics results
 * always carry `nextPageToken === ""` (there is no token pagination on the
 * reports endpoint), so the "more available" clause is unreachable — it is
 * kept anyway so the two implementations can be diffed literally.
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
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.make(`${result.items.length} item(s), ${result.requests} request(s)${more}\n`),
      stdio.stderr()
    ).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write output", cause }))
      )
    )
  })

/**
 * Go's `csvValues`: split on `,`, trim each entry, drop the empties. So
 * `--metrics " , "` yields zero entries and triggers the required-flag error.
 */
export const csvValues = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

/** Go's `validateEnum`; the empty string always passes. */
export const validateEnum = (
  flag: string,
  value: string,
  allowed: ReadonlyArray<string>
): UsageError | undefined =>
  value === "" || allowed.includes(value)
    ? undefined
    : new UsageError({ message: `${flag} must be one of: ${allowed.join(", ")}` })

/**
 * `time.Parse(time.DateOnly, s)` followed by a reformat equality check.
 *
 * Go's parser accepts `2026-1-05`, but reformatting yields `2026-01-05`, which
 * differs from the input — so the non-canonical form is rejected. Reproduced
 * exactly: parse strictly on the digit shape, then re-render and compare.
 */
export const parseDateOnly = (value: string): Date | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  const [, year, month, day] = match as unknown as [string, string, string, string]
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  // Rejects 2026-02-31 and friends: Date.UTC rolls them over, so the
  // round-tripped components no longer match the input.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return undefined
  }
  return date
}

/** `validateAnalyticsDates`: start format, end format, then ordering. */
export const validateAnalyticsDates = (
  start: string,
  end: string
): UsageError | undefined => {
  const startDate = parseDateOnly(start)
  if (startDate === undefined) return new UsageError({ message: "--start must use YYYY-MM-DD" })
  const endDate = parseDateOnly(end)
  if (endDate === undefined) return new UsageError({ message: "--end must use YYYY-MM-DD" })
  if (startDate.getTime() > endDate.getTime()) {
    return new UsageError({ message: "--start cannot be after --end" })
  }
  return undefined
}

/** Built-in filter first, user filter second, joined by `;` when both exist. */
export const mergeFilters = (builtIn: string, user: string): string => {
  if (builtIn === "") return user
  if (user === "") return builtIn
  return `${builtIn};${user}`
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Computed ONCE, at module import. See the header: Go materialized these into
 * the flag defaults while constructing the command tree, so they show up
 * verbatim in `--help`.
 */
export const DEFAULT_RANGE = defaultDateRange(new Date())

const analyticsFlags = {
  start: Flag.string("start").pipe(
    Flag.withDefault(DEFAULT_RANGE.start),
    Flag.withDescription("report start date (YYYY-MM-DD; default: 28 days ending yesterday)")
  ),
  end: Flag.string("end").pipe(
    Flag.withDefault(DEFAULT_RANGE.end),
    Flag.withDescription("report end date (YYYY-MM-DD; default: yesterday)")
  ),
  filters: Flag.string("filters").pipe(
    Flag.withDefault(""),
    Flag.withDescription("Analytics filter expression")
  ),
  sort: Flag.string("sort").pipe(
    Flag.withDefault(""),
    Flag.withDescription("comma-separated Analytics sort fields")
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDefault(MAX_RESULTS),
    Flag.withDescription(`maximum rows (1-${MAX_RESULTS})`)
  )
} as const

interface AnalyticsFlagValues {
  readonly start: string
  readonly end: string
  readonly filters: string
  readonly sort: string
  readonly limit: number
}

/**
 * `Args: exactArgs(0)` in Go (analytics.go:44,71,108,124). Without a variadic
 * argument the framework drops extra positionals silently and the handler runs
 * anyway, so `oytc analytics overview extra` would issue a real API call.
 */
const noPositionals = { extra: Argument.string("").pipe(Argument.variadic()) }

/** Go's arity check, run before anything else in each analytics handler. */
const rejectExtraArgs = (extra: ReadonlyArray<string>) =>
  extra.length === 0
    ? undefined
    : new UsageError({ message: `expected 0 argument(s), received ${extra.length}` })

// ---------------------------------------------------------------------------
// The shared runner
// ---------------------------------------------------------------------------

interface AnalyticsRequest {
  readonly metrics: ReadonlyArray<string>
  readonly dimensions: ReadonlyArray<string>
  /** The subcommand's own filter, before `--filters` is merged in. */
  readonly builtInFilter: string
  readonly columns: ReadonlyArray<string>
}

const runAnalytics = (flags: AnalyticsFlagValues, request: AnalyticsRequest) =>
  Effect.gen(function* () {
    const dateError = validateAnalyticsDates(flags.start, flags.end)
    if (dateError !== undefined) return yield* Effect.fail(dateError)

    if (flags.limit < 1 || flags.limit > MAX_RESULTS) {
      return yield* Effect.fail(
        new UsageError({ message: `--limit must be between 1 and ${MAX_RESULTS}` })
      )
    }

    const store = yield* CredentialStore
    const credentials = yield* store.load
    if (credentials.oauth === undefined) {
      return yield* Effect.fail(
        new MissingOAuthError({ suffix: "; analytics requires OAuth" })
      )
    }

    const analytics = yield* AnalyticsApi
    // Go: `if err != nil { return oauthAuthHint(err) }`. Without this a 401 or
    // an `insufficientPermissions` 403 from the reports endpoint reaches the
    // user as a bare `YouTube API error (…)` with no "re-run 'oytc login
    // --oauth'" hint — the single most common analytics failure, and the one
    // case where the message has to tell the user what to do. `status --check`
    // already routes its OAuth probe through the same helper.
    const response = yield* analytics
      .report({
        metrics: request.metrics.join(","),
        dimensions: request.dimensions.join(","),
        filters: mergeFilters(request.builtInFilter, flags.filters),
        sort: flags.sort,
        startDate: flags.start,
        endDate: flags.end,
        limit: flags.limit,
        startIndex: 0
      })
      .pipe(Effect.mapError(oauthAuthHint))

    const options = yield* AppOptions
    yield* renderResult(analyticsListResult(response), request.columns, options)
  })

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export const analyticsReportCommand = Command.make(
  "report",
  {
    ...noPositionals,
    ...analyticsFlags,
    metrics: Flag.string("metrics").pipe(
      Flag.withDefault(""),
      Flag.withDescription("required comma-separated Analytics metrics")
    ),
    dimensions: Flag.string("dimensions").pipe(
      Flag.withDefault(""),
      Flag.withDescription("comma-separated Analytics dimensions")
    )
  },
  (config) =>
    Effect.gen(function* () {
      const arity = rejectExtraArgs(config.extra)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const metrics = csvValues(config.metrics)
      // Runs before the date and limit checks, and before any credential load.
      if (metrics.length === 0) {
        return yield* Effect.fail(new UsageError({ message: "--metrics is required" }))
      }
      const dimensions = csvValues(config.dimensions)
      yield* runAnalytics(config, {
        metrics,
        dimensions,
        builtInFilter: "",
        columns: analyticsReportColumns(dimensions, metrics)
      })
    })
).pipe(Command.withDescription("Run a raw YouTube Analytics report"))

export const analyticsOverviewCommand = Command.make(
  "overview",
  {
    ...noPositionals,
    ...analyticsFlags,
    by: Flag.string("by").pipe(
      Flag.withDefault(""),
      Flag.withDescription("group by day or month")
    )
  },
  (config) =>
    Effect.gen(function* () {
      const arity = rejectExtraArgs(config.extra)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const enumError = validateEnum("--by", config.by, ["day", "month"])
      if (enumError !== undefined) return yield* Effect.fail(enumError)
      // `--by` goes through csvValues, so a whitespace-only value contributes
      // no dimension at all rather than an empty one.
      const dimensions = csvValues(config.by)
      yield* runAnalytics(config, {
        metrics: analyticsOverviewMetrics,
        dimensions,
        builtInFilter: "",
        columns: analyticsOverviewColumns(config.by)
      })
    })
).pipe(
  Command.withDescription("Show channel views, watch time, retention, and subscribers gained")
)

export const analyticsVideoCommand = Command.make(
  "video",
  // `Args: exactArgs(1)`. A plain `Argument.string` reports the framework's own
  // "Missing required argument" for 0 args and silently DROPS extras, so the
  // arity is observed variadically and checked here, as everywhere else.
  {
    ...analyticsFlags,
    ids: Argument.string("VIDEO_ID").pipe(Argument.variadic())
  },
  (config) =>
    Effect.gen(function* () {
      if (config.ids.length !== 1) {
        return yield* Effect.fail(
          new UsageError({
            message: `expected 1 argument(s), received ${config.ids.length}`
          })
        )
      }
      yield* runAnalytics(config, {
        metrics: analyticsVideoColumns,
        dimensions: [],
        builtInFilter: `video==${config.ids[0]!}`,
        columns: analyticsVideoColumns
      })
    })
).pipe(Command.withDescription("Show core analytics metrics for one owned video"))

export const analyticsTrafficSourcesCommand = Command.make(
  "traffic-sources",
  { ...noPositionals, ...analyticsFlags },
  (config) =>
    Effect.gen(function* () {
      const arity = rejectExtraArgs(config.extra)
      if (arity !== undefined) return yield* Effect.fail(arity)
      yield* runAnalytics(config, {
        metrics: ["views", "estimatedMinutesWatched"],
        dimensions: ["insightTrafficSourceType"],
        builtInFilter: "",
        columns: analyticsTrafficSourcesColumns
      })
    })
).pipe(Command.withDescription("Break views and watch time down by traffic source"))

export const analyticsDemographicsCommand = Command.make(
  "demographics",
  { ...noPositionals, ...analyticsFlags },
  (config) =>
    Effect.gen(function* () {
      const arity = rejectExtraArgs(config.extra)
      if (arity !== undefined) return yield* Effect.fail(arity)
      yield* runAnalytics(config, {
        metrics: ["viewerPercentage"],
        dimensions: ["ageGroup", "gender"],
        builtInFilter: "",
        columns: analyticsDemographicsColumns
      })
    })
).pipe(Command.withDescription("Break viewer percentage down by age group and gender"))

/** The group; no handler, so a bare `oytc analytics` prints help and exits 0. */
export const analyticsCommand = Command.make("analytics").pipe(
  Command.withDescription("Read analytics for your authorized YouTube channel (OAuth required)"),
  Command.withSubcommands([
    analyticsReportCommand,
    analyticsOverviewCommand,
    analyticsVideoCommand,
    analyticsTrafficSourcesCommand,
    analyticsDemographicsCommand
  ])
)

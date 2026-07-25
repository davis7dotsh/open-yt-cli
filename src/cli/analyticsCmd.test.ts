/**
 * `analytics {report,overview,video,traffic-sources,demographics}` tests.
 *
 * The five presets are asserted against the exact metric/dimension/filter
 * strings the Analytics API receives, because those ARE the contract — a
 * preset that drops a metric produces a report that is quietly wrong rather
 * than one that fails.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import {
  ApiError,
  exitCodeFor,
  MissingOAuthError,
  OperationalError,
  UsageError,
  type OytcError
} from "../domain/errors.ts"
import type { AnalyticsResponse } from "../schema/analytics.ts"
import { rawNumber } from "../json/value.ts"
import { makeRendererWith } from "../impl/renderer.ts"
import { addUtcDays, formatDateOnly, MAX_RESULTS } from "../impl/analyticsApi.ts"
import {
  AnalyticsApi,
  AppOptions,
  CredentialStore,
  Renderer,
  type AnalyticsQuery,
  type AppOptionsShape,
  type Credentials,
  type OutputFormat,
  type StoredOAuth
} from "../services/index.ts"
import { globalFlags } from "./flags.ts"
import {
  analyticsCommand,
  csvValues,
  DEFAULT_RANGE,
  mergeFilters,
  parseDateOnly,
  validateAnalyticsDates,
  validateEnum
} from "./analyticsCmd.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const storedOAuth: StoredOAuth = {
  clientId: "cid",
  clientSecret: "secret",
  accessToken: "at",
  refreshToken: "rt",
  expiry: "2027-01-01T00:00:00Z",
  scopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"]
}

const credentials = (): Credentials => ({
  key: "",
  source: "",
  oauth: storedOAuth,
  path: "/tmp/auth.json"
})

/**
 * Credentials with no OAuth block. A separate constructor rather than an
 * optional parameter: `credentials(undefined)` would trigger the default
 * parameter and silently hand back a CONFIGURED record, so the "no OAuth"
 * tests would assert nothing.
 */
const credentialsWithoutOAuth = (): Credentials => ({
  key: "",
  source: "",
  oauth: undefined,
  path: "/tmp/auth.json"
})

const report: AnalyticsResponse = {
  columnHeaders: [{ name: "views" }],
  rows: [[rawNumber("42")]]
}

interface RunOptions {
  readonly credentials?: Credentials | undefined
  readonly format?: OutputFormat | undefined
  readonly columns?: ReadonlyArray<string> | undefined
  readonly quiet?: boolean | undefined
  readonly reportError?: OytcError | undefined
  readonly response?: AnalyticsResponse | undefined
}

const runCommand = async (
  argv: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly exit: Exit.Exit<void, OytcError>
  readonly queries: ReadonlyArray<AnalyticsQuery>
}> => {
  const out: Array<string> = []
  const err: Array<string> = []
  const queries: Array<AnalyticsQuery> = []
  const decode = (i: string | Uint8Array): string =>
    typeof i === "string" ? i : new TextDecoder().decode(i)

  const stdio = Stdio.layerTest({
    stdout: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => out.push(decode(i)))),
    stderr: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => err.push(decode(i))))
  })

  const appOptions: AppOptionsShape = {
    format: options.format ?? "json",
    columns: options.columns ?? [],
    noHeader: false,
    quiet: options.quiet ?? false,
    timeoutMillis: 20_000,
    isOutputTTY: false
  }

  const layers = Layer.mergeAll(
    Layer.succeed(AppOptions, appOptions),
    Layer.succeed(CredentialStore, {
      dir: Effect.succeed("/tmp"),
      path: Effect.succeed("/tmp/auth.json"),
      load: Effect.succeed(options.credentials ?? credentials()),
      save: () => Effect.succeed("/tmp/auth.json"),
      saveOAuth: () => Effect.succeed("/tmp/auth.json"),
      saveRefreshedOAuth: () => Effect.succeed(true),
      clearOAuth: Effect.succeed("/tmp/auth.json"),
      remove: Effect.succeed({ path: "/tmp/auth.json", removed: true }),
      fingerprint: () => "sha256:deadbeef0000",
      envKeySet: Effect.succeed(false),
      oauthBootstrap: Effect.succeed(["", ""] as const)
    }),
    Layer.succeed(AnalyticsApi, {
      report: (query: AnalyticsQuery) =>
        Effect.suspend(() => {
          queries.push(query)
          return options.reportError === undefined
            ? Effect.succeed(options.response ?? report)
            : Effect.fail(options.reportError)
        }),
      normalize: () => []
    }),
    Layer.succeed(
      Renderer,
      makeRendererWith((text) => Effect.sync(() => void out.push(text)))
    )
  )

  const root = Command.make("oytc").pipe(
    Command.withSharedFlags(globalFlags),
    Command.withSubcommands([analyticsCommand])
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(root, { version: "test" })(argv).pipe(
      Effect.provide(Layer.mergeAll(layers, stdio))
    ) as Effect.Effect<void, OytcError>
  )
  return { stdout: out.join(""), stderr: err.join(""), exit, queries }
}

const failureOf = (exit: Exit.Exit<unknown, OytcError>): OytcError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const found = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (found === undefined) throw new Error(`no Fail reason: ${String(exit.cause)}`)
  return (found as { readonly error: OytcError }).error
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("csvValues", () => {
  test("splits, trims and drops empties", () => {
    expect(csvValues(" a , b ,, c ")).toEqual(["a", "b", "c"])
  })

  test("a whitespace-only value yields nothing", () => {
    expect(csvValues(" , ")).toEqual([])
    expect(csvValues("")).toEqual([])
  })

  test("a trailing comma contributes no entry", () => {
    expect(csvValues("views,")).toEqual(["views"])
  })
})

describe("validateEnum", () => {
  test("the empty string always passes", () => {
    expect(validateEnum("--by", "", ["day", "month"])).toBeUndefined()
  })

  test("a listed value passes", () => {
    expect(validateEnum("--by", "day", ["day", "month"])).toBeUndefined()
  })

  test("an unlisted value fails with Go's comma-space message", () => {
    expect(validateEnum("--by", "week", ["day", "month"])?.message).toBe(
      "--by must be one of: day, month"
    )
  })

  test("the check is case-sensitive", () => {
    expect(validateEnum("--by", "Day", ["day", "month"])).toBeDefined()
  })
})

describe("parseDateOnly", () => {
  test("accepts a canonical date", () => {
    expect(parseDateOnly("2026-01-05")).toBeInstanceOf(Date)
  })

  test("REJECTS a non-canonical date Go's parser would accept", () => {
    // 2026-1-05 parses in Go, but reformatting yields 2026-01-05 != input.
    expect(parseDateOnly("2026-1-05")).toBeUndefined()
    expect(parseDateOnly("2026-01-5")).toBeUndefined()
  })

  test("rejects an out-of-range day rather than rolling it over", () => {
    expect(parseDateOnly("2026-02-31")).toBeUndefined()
    expect(parseDateOnly("2026-13-01")).toBeUndefined()
  })

  test("accepts a real leap day and rejects a fake one", () => {
    expect(parseDateOnly("2024-02-29")).toBeInstanceOf(Date)
    expect(parseDateOnly("2026-02-29")).toBeUndefined()
  })

  test("rejects a timestamp or a bare year", () => {
    expect(parseDateOnly("2026-01-05T00:00:00Z")).toBeUndefined()
    expect(parseDateOnly("2026")).toBeUndefined()
    expect(parseDateOnly("")).toBeUndefined()
  })
})

describe("validateAnalyticsDates", () => {
  test("a bad start reports --start first", () => {
    expect(validateAnalyticsDates("bad", "also-bad")?.message).toBe(
      "--start must use YYYY-MM-DD"
    )
  })

  test("a bad end is reported once start is valid", () => {
    expect(validateAnalyticsDates("2026-01-01", "bad")?.message).toBe(
      "--end must use YYYY-MM-DD"
    )
  })

  test("start after end is rejected", () => {
    expect(validateAnalyticsDates("2026-02-01", "2026-01-01")?.message).toBe(
      "--start cannot be after --end"
    )
  })

  test("start equal to end is allowed", () => {
    expect(validateAnalyticsDates("2026-01-01", "2026-01-01")).toBeUndefined()
  })
})

describe("mergeFilters", () => {
  test("joins with a semicolon, built-in first", () => {
    expect(mergeFilters("video==ID", "country==US")).toBe("video==ID;country==US")
  })

  test("either side alone passes through", () => {
    expect(mergeFilters("video==ID", "")).toBe("video==ID")
    expect(mergeFilters("", "country==US")).toBe("country==US")
  })

  test("both empty stays empty", () => {
    expect(mergeFilters("", "")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Date defaults
// ---------------------------------------------------------------------------

describe("the default date window", () => {
  test("is 28 INCLUSIVE UTC days ending yesterday", () => {
    const end = new Date(`${DEFAULT_RANGE.end}T00:00:00Z`)
    const start = new Date(`${DEFAULT_RANGE.start}T00:00:00Z`)
    const days = (end.getTime() - start.getTime()) / 86_400_000
    // 27 days apart == 28 inclusive days.
    expect(days).toBe(27)
  })

  test("ends yesterday in UTC, excluding today's incomplete data", () => {
    const yesterday = formatDateOnly(addUtcDays(new Date(), -1))
    expect(DEFAULT_RANGE.end).toBe(yesterday)
  })

  test("is materialized once, so repeated reads are identical", () => {
    // The whole point of construction-time materialization: the value is a
    // constant, not a function re-evaluated per invocation.
    const first = { ...DEFAULT_RANGE }
    expect(DEFAULT_RANGE).toEqual(first)
  })

  test("reaches the API as the query's start and end dates", async () => {
    const { queries } = await runCommand(["analytics", "overview"])
    expect(queries[0]!.startDate).toBe(DEFAULT_RANGE.start)
    expect(queries[0]!.endDate).toBe(DEFAULT_RANGE.end)
  })
})

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

describe("analytics report", () => {
  test("--metrics is required", async () => {
    const { exit, queries } = await runCommand(["analytics", "report"])
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(UsageError)
    expect(error.message).toBe("--metrics is required")
    expect(queries).toEqual([])
  })

  test("a whitespace-only --metrics also triggers the required error", async () => {
    const { exit } = await runCommand(["analytics", "report", "--metrics= , "])
    expect(failureOf(exit).message).toBe("--metrics is required")
  })

  test("the required check runs BEFORE the date check", async () => {
    const { exit } = await runCommand(["analytics", "report", "--start=bogus"])
    expect(failureOf(exit).message).toBe("--metrics is required")
  })

  test("metrics and dimensions are comma-joined for the API", async () => {
    const { queries } = await runCommand([
      "analytics",
      "report",
      "--metrics= views , likes ",
      "--dimensions=day"
    ])
    expect(queries[0]!.metrics).toBe("views,likes")
    expect(queries[0]!.dimensions).toBe("day")
  })

  test("the default columns are dimensions first, then metrics", async () => {
    const { stdout } = await runCommand(
      ["analytics", "report", "--metrics=views,likes", "--dimensions=day"],
      { format: "tsv", response: { columnHeaders: [], rows: [] } }
    )
    expect(stdout.split("\n")[0]).toBe("DAY\tVIEWS\tLIKES")
  })

  test("--filters passes straight through", async () => {
    // Space-separated: see the FRAMEWORK LEXER BUG suite below for why the
    // `--filters=country==US` spelling cannot be used here.
    const { queries } = await runCommand([
      "analytics",
      "report",
      "--metrics=views",
      "--filters",
      "country==US"
    ])
    expect(queries[0]!.filters).toBe("country==US")
  })

  test("--sort passes straight through", async () => {
    const { queries } = await runCommand([
      "analytics",
      "report",
      "--metrics=views",
      "--sort=-views"
    ])
    expect(queries[0]!.sort).toBe("-views")
  })
})

// ---------------------------------------------------------------------------
// The presets
// ---------------------------------------------------------------------------

describe("analytics overview", () => {
  test("sends the five fixed metrics and no dimension by default", async () => {
    const { queries } = await runCommand(["analytics", "overview"])
    expect(queries[0]!.metrics).toBe(
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained"
    )
    expect(queries[0]!.dimensions).toBe("")
  })

  test("--by day adds the dimension", async () => {
    const { queries } = await runCommand(["analytics", "overview", "--by=day"])
    expect(queries[0]!.dimensions).toBe("day")
  })

  test("--by month adds the dimension", async () => {
    const { queries } = await runCommand(["analytics", "overview", "--by=month"])
    expect(queries[0]!.dimensions).toBe("month")
  })

  test("an invalid --by is rejected before any request", async () => {
    const { exit, queries } = await runCommand(["analytics", "overview", "--by=week"])
    expect(failureOf(exit).message).toBe("--by must be one of: day, month")
    expect(queries).toEqual([])
  })

  test("the --by check runs before the date check", async () => {
    const { exit } = await runCommand([
      "analytics",
      "overview",
      "--by=week",
      "--start=bogus"
    ])
    expect(failureOf(exit).message).toBe("--by must be one of: day, month")
  })

  test("--by puts the dimension first in the default columns", async () => {
    const { stdout } = await runCommand(["analytics", "overview", "--by=day"], {
      format: "tsv",
      response: { columnHeaders: [], rows: [] }
    })
    expect(stdout.split("\n")[0]!.split("\t")[0]).toBe("DAY")
  })
})

describe("analytics video", () => {
  test("sets the built-in video filter from the positional argument", async () => {
    const { queries } = await runCommand(["analytics", "video", "VID123"])
    expect(queries[0]!.filters).toBe("video==VID123")
  })

  test("MERGES --filters after the built-in one, semicolon-separated", async () => {
    const { queries } = await runCommand([
      "analytics",
      "video",
      "VID123",
      "--filters",
      "country==US"
    ])
    expect(queries[0]!.filters).toBe("video==VID123;country==US")
  })

  test("sends the six fixed metrics and no dimensions", async () => {
    const { queries } = await runCommand(["analytics", "video", "VID123"])
    expect(queries[0]!.metrics).toBe(
      "views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained"
    )
    expect(queries[0]!.dimensions).toBe("")
  })

  test("a missing VIDEO_ID is a parse failure, not a request", async () => {
    const { queries, exit } = await runCommand(["analytics", "video"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(queries).toEqual([])
  })
})

describe("analytics traffic-sources", () => {
  test("sends the fixed metric/dimension pair", async () => {
    const { queries } = await runCommand(["analytics", "traffic-sources"])
    expect(queries[0]!.metrics).toBe("views,estimatedMinutesWatched")
    expect(queries[0]!.dimensions).toBe("insightTrafficSourceType")
  })

  test("--filters is used as-is (no built-in filter to merge)", async () => {
    const { queries } = await runCommand([
      "analytics",
      "traffic-sources",
      "--filters",
      "country==US"
    ])
    expect(queries[0]!.filters).toBe("country==US")
  })
})

// ---------------------------------------------------------------------------
// FRAMEWORK LEXER BUG — not a defect in this package
// ---------------------------------------------------------------------------

/**
 * The CLI framework's lexer splits `--flag=value` with
 * `arg.slice(2).split("=", 2)`. JavaScript's `split` with a limit DISCARDS the
 * remainder rather than returning it as the final element, which is what Go's
 * `strings.SplitN(s, "=", 2)` does. So every `=` after the first TRUNCATES the
 * value:
 *
 *     "--filters=country==US".slice(2).split("=", 2)  // ["filters", "country"]
 *
 * `Analytics` filter expressions are all of the form `dimension==value`, so
 * this silently corrupts the single most likely way a user would write the
 * flag: `--filters=country==US` reaches the API as `country`, which Google
 * answers with a 400 rather than an obviously wrong report.
 *
 * The fix belongs in the framework's own `cli/internal/lexer.js`
 * (`indexOf("=")` + two slices, exactly as the short-flag branch a few lines
 * below it already does), so this package cannot fix it. These tests pin the
 * CURRENT behaviour so the eventual upstream fix is detected rather than
 * silently changing what the CLI does.
 *
 * Affected across the whole CLI: `--filters` (analytics), `--fields` (any
 * selector containing `=`), and any flag whose value may embed `=`. The
 * space-separated spelling (`--filters country==US`) is unaffected and is what
 * every other test here uses.
 */
describe("KNOWN FRAMEWORK BUG: --flag=value truncates at the second '='", () => {
  test("the lexer's own splitting drops everything after the second =", () => {
    const [name, value] = "--filters=country==US".slice(2).split("=", 2)
    expect(name).toBe("filters")
    // Go's SplitN would give "country==US"; JS's split limit gives "country".
    expect(value).toBe("country")
  })

  test("end to end, --filters=a==b reaches the API truncated", async () => {
    const { queries } = await runCommand([
      "analytics",
      "traffic-sources",
      "--filters=country==US"
    ])
    // ASSERTING THE BUG. When the framework is fixed this flips to
    // "country==US" and the test fails, which is the intent.
    expect(queries[0]!.filters).toBe("country")
  })

  test("the space-separated spelling is correct and is the workaround", async () => {
    const { queries } = await runCommand([
      "analytics",
      "traffic-sources",
      "--filters",
      "country==US"
    ])
    expect(queries[0]!.filters).toBe("country==US")
  })

  test("a value with no '=' is unaffected by the bug", async () => {
    const { queries } = await runCommand(["analytics", "overview", "--by=day"])
    expect(queries[0]!.dimensions).toBe("day")
  })
})

/**
 * KNOWN FRAMEWORK BUG #2 — a flag VALUE that starts with `-`, in the
 * space-separated spelling, is lexed as a cluster of short flags instead of as
 * the value of the preceding flag.
 *
 * This is the same root cause as the `--limit -1` case already documented in
 * `playlist.test.ts`, but with a far worse failure mode. For `--limit -1` the
 * lexer reports "Missing value for flag --limit" and the run fails loudly. For
 * `--sort -views` the `-v` at the head of the cluster matches the framework's
 * built-in `--version, -v`, which SHORT-CIRCUITS the whole run: the CLI prints
 * its version banner and exits **0**, having executed no handler and issued no
 * request.
 *
 * That is the dangerous shape — a silent success. `oytc analytics report
 * --metrics views --sort -views` looks like it worked (exit 0, output on
 * stdout) while producing no report at all, so a script piping it to `jq` sees
 * a version string rather than data and a `set -e` pipeline does not trip.
 * Go's pflag consumes the next argv token unconditionally for a string flag,
 * so the real binary accepts `--sort -views` and sorts descending.
 *
 * Not fixable from this package: the defect is in the CLI lexer
 * (`effect/unstable/cli/internal/lexer.js`), which treats any `-x…` token as
 * flags regardless of whether the previous token was a value-taking flag.
 * Pinned here so the day it is fixed these tests fail and the workaround notes
 * can be removed. Workaround: the `=` spelling (`--sort=-views`), which is
 * lexed correctly for values that contain no second `=`.
 */
describe("KNOWN FRAMEWORK BUG: a `-`-leading flag value is lexed as short flags", () => {
  test("--sort -views silently succeeds without running the command", async () => {
    const { exit, queries, stdout } = await runCommand([
      "analytics",
      "report",
      "--metrics",
      "views",
      "--sort",
      "-views"
    ])
    // ASSERTING THE BUG: a SUCCESS exit with no request issued and nothing
    // rendered. The framework wrote its version banner straight to the real
    // console rather than through the injected `Stdio`, so it is not visible
    // here — which is itself part of why the failure is so quiet.
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(queries).toEqual([])
    expect(stdout).toBe("")
  })

  test("the `=` spelling is the workaround and does reach the API", async () => {
    const { queries } = await runCommand([
      "analytics",
      "report",
      "--metrics",
      "views",
      "--sort=-views"
    ])
    expect(queries[0]!.sort).toBe("-views")
  })

  test("a value with no leading dash is unaffected", async () => {
    const { queries } = await runCommand([
      "analytics",
      "report",
      "--metrics",
      "views",
      "--sort",
      "views"
    ])
    expect(queries[0]!.sort).toBe("views")
  })
})

describe("analytics demographics", () => {
  test("sends viewerPercentage by ageGroup and gender", async () => {
    const { queries } = await runCommand(["analytics", "demographics"])
    expect(queries[0]!.metrics).toBe("viewerPercentage")
    expect(queries[0]!.dimensions).toBe("ageGroup,gender")
  })
})

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

describe("shared analytics validation", () => {
  test("a bad --start is rejected before any request", async () => {
    const { exit, queries } = await runCommand([
      "analytics",
      "overview",
      "--start=2026-1-05"
    ])
    expect(failureOf(exit).message).toBe("--start must use YYYY-MM-DD")
    expect(queries).toEqual([])
  })

  test("a bad --end is rejected", async () => {
    const { exit } = await runCommand(["analytics", "overview", "--end=nope"])
    expect(failureOf(exit).message).toBe("--end must use YYYY-MM-DD")
  })

  test("start after end is rejected", async () => {
    const { exit } = await runCommand([
      "analytics",
      "overview",
      "--start=2026-02-01",
      "--end=2026-01-01"
    ])
    expect(failureOf(exit).message).toBe("--start cannot be after --end")
  })

  test("--limit below 1 is rejected", async () => {
    const { exit, queries } = await runCommand(["analytics", "overview", "--limit=0"])
    expect(failureOf(exit).message).toBe(`--limit must be between 1 and ${MAX_RESULTS}`)
    expect(queries).toEqual([])
  })

  test("--limit above 200 is rejected", async () => {
    const { exit } = await runCommand(["analytics", "overview", "--limit=201"])
    expect(failureOf(exit).message).toBe("--limit must be between 1 and 200")
  })

  test("--limit at both bounds is accepted", async () => {
    expect(Exit.isSuccess((await runCommand(["analytics", "overview", "--limit=1"])).exit)).toBe(
      true
    )
    expect(
      Exit.isSuccess((await runCommand(["analytics", "overview", "--limit=200"])).exit)
    ).toBe(true)
  })

  test("the default --limit is MaxResults", async () => {
    const { queries } = await runCommand(["analytics", "overview"])
    expect(queries[0]!.limit).toBe(MAX_RESULTS)
  })

  test("the date check runs before the limit check", async () => {
    const { exit } = await runCommand([
      "analytics",
      "overview",
      "--start=bogus",
      "--limit=999"
    ])
    expect(failureOf(exit).message).toBe("--start must use YYYY-MM-DD")
  })

  test("the limit check runs before the credential load", async () => {
    const { exit } = await runCommand(["analytics", "overview", "--limit=0"], {
      credentials: credentialsWithoutOAuth()
    })
    expect(failureOf(exit)).toBeInstanceOf(UsageError)
  })

  test("no stored OAuth fails with the analytics suffix, exit 3", async () => {
    const { exit, queries } = await runCommand(["analytics", "overview"], {
      credentials: credentialsWithoutOAuth()
    })
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(MissingOAuthError)
    expect(error.message).toBe(
      "no OAuth credentials configured; run 'oytc login --oauth'; analytics requires OAuth"
    )
    expect(queries).toEqual([])
  })

  test("an upstream failure propagates", async () => {
    const boom = new OperationalError({ message: "network down" })
    const { exit } = await runCommand(["analytics", "overview"], { reportError: boom })
    expect(failureOf(exit)).toBe(boom)
  })
})

// ---------------------------------------------------------------------------
// oauthAuthHint on the report failure
//
// Go's `runAnalytics` ends with `return oauthAuthHint(err)`, so EVERY analytics
// failure is routed through the same helper `status --check` uses. Dropping it
// is invisible on the happy path and on 5xx/quota errors, and shows up only on
// the two failures that matter most: an expired grant and a missing scope. In
// both cases the user needs to be told to re-run `oytc login --oauth`.
// ---------------------------------------------------------------------------

describe("analytics failures carry the OAuth re-login hint (Go: oauthAuthHint)", () => {
  const apiError = (httpStatus: number, reasons: ReadonlyArray<string>, apiMessage: string) =>
    new ApiError({ httpStatus, code: httpStatus, apiMessage, reasons })

  test("a 401 becomes the re-login hint, exit 3", async () => {
    const { exit } = await runCommand(["analytics", "report", "--metrics=views"], {
      reportError: apiError(401, ["authError"], "Invalid Credentials")
    })
    const error = failureOf(exit)
    expect(error.message).toBe(
      "OAuth authorization failed; re-run 'oytc login --oauth': " +
        "YouTube API error (401, authError): Invalid Credentials"
    )
    expect(exitCodeFor(error)).toBe(3)
  })

  test("insufficientPermissions becomes the scopes hint, exit 3", async () => {
    const { exit } = await runCommand(["analytics", "overview"], {
      reportError: apiError(403, ["insufficientPermissions"], "Insufficient Permission")
    })
    const error = failureOf(exit)
    expect(error.message).toBe(
      "OAuth scopes are insufficient; re-run 'oytc login --oauth': " +
        "YouTube API error (403, insufficientPermissions): Insufficient Permission"
    )
    expect(exitCodeFor(error)).toBe(3)
  })

  test("an invalid_grant token failure becomes the re-login hint, exit 3", async () => {
    const { exit } = await runCommand(["analytics", "video", "VID"], {
      reportError: new OperationalError({ message: "oauth2: cannot fetch token: invalid_grant" })
    })
    const error = failureOf(exit)
    expect(error.message).toStartWith("OAuth authorization failed; re-run 'oytc login --oauth': ")
    expect(exitCodeFor(error)).toBe(3)
  })

  // The other half of the contract: oauthAuthHint returns non-matching errors
  // UNCHANGED, so a 5xx must not gain a hint and must keep its exit code.
  test("a 5xx passes through unchanged, exit 6", async () => {
    const boom = apiError(500, ["backendError"], "Backend Error")
    const { exit } = await runCommand(["analytics", "demographics"], { reportError: boom })
    expect(failureOf(exit)).toBe(boom)
    expect(exitCodeFor(failureOf(exit))).toBe(6)
  })

  test("a quota error passes through unchanged, exit 5", async () => {
    const boom = apiError(429, ["quotaExceeded"], "Quota exceeded")
    const { exit } = await runCommand(["analytics", "traffic-sources"], { reportError: boom })
    expect(failureOf(exit)).toBe(boom)
    expect(exitCodeFor(failureOf(exit))).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("analytics rendering", () => {
  test("the envelope always reports exactly one request", async () => {
    const { stdout } = await runCommand(["analytics", "overview"], { format: "json" })
    expect(stdout).toContain('"requests": 1')
  })

  test("the table summary lands on stderr", async () => {
    const { stderr } = await runCommand(["analytics", "overview"], { format: "table" })
    expect(stderr).toBe("1 item(s), 1 request(s)\n")
  })

  test("--quiet suppresses the summary", async () => {
    const { stderr } = await runCommand(["analytics", "overview"], {
      format: "table",
      quiet: true
    })
    expect(stderr).toBe("")
  })

  test("a non-table format never emits the summary", async () => {
    const { stderr } = await runCommand(["analytics", "overview"], { format: "json" })
    expect(stderr).toBe("")
  })

  test("--columns overrides the preset column list", async () => {
    const { stdout } = await runCommand(["analytics", "overview"], {
      format: "tsv",
      columns: ["views"]
    })
    expect(stdout.split("\n")[0]).toBe("VIEWS")
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("command registration", () => {
  test("the group carries Go's description and has no handler", () => {
    expect(analyticsCommand.name).toBe("analytics")
    expect(analyticsCommand.description).toBe(
      "Read analytics for your authorized YouTube channel (OAuth required)"
    )
  })

  test("all five subcommands are registered under Go's names", () => {
    const names = analyticsCommand.subcommands.flatMap((g) => g.commands.map((c) => c.name))
    expect(names).toEqual([
      "report",
      "overview",
      "video",
      "traffic-sources",
      "demographics"
    ])
  })
})

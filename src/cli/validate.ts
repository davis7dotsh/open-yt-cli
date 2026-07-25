/**
 * Command scaffolding: every validation check, plus the flag groups and request
 * helpers that every leaf command shares.
 *
 * Ports the `validate*` / `*Args` / `addListFlags` / `addAPIFlags` / `setValues`
 * / `batch` helpers from `internal/cli/app.go`. Each validation returns
 * `Option<UsageError>` — `Option.none()` for "passed" — so a handler can
 * evaluate checks in Go's exact order with a single `firstFailure([...])`.
 *
 * ORDER OF EVALUATION (measured against `/tmp/oytc-ref`, not just read off the
 * spec):
 *
 *   1. flag parsing                    (the CLI framework)
 *   2. positional-argument count       `expected N argument(s), received M`
 *   3. global `--format` / `--timeout` (root.ts's `Command.provide`)
 *   4. pagination                      `--page-size` then `--limit`  (Go: PreRunE)
 *   5. per-command semantic checks     (Go: RunE, in source order)
 *
 * Steps 2, 4 and 5 all live in the handler here, in that order. Step 3 is
 * root.ts's business; see the note on `exactArgs` for the one corner where that
 * reorders relative to Go.
 *
 * SHARED HELPER — P8b and P8c import from here read-only. Do not edit outside
 * P8a.
 */

import { Effect, Option } from "effect"
import { Flag } from "../effect.ts"
import { NotFoundError, UsageError } from "../domain/errors.ts"
import type { PageOptions } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import { goQuote } from "../impl/resolveChannel.ts"
import type { Params } from "../services/index.ts"

/** Sugar: a failed check. */
const fail = (message: string): Option.Option<UsageError> =>
  Option.some(new UsageError({ message }))

const pass: Option.Option<UsageError> = Option.none()

/**
 * Evaluate checks in order and return the first failure.
 *
 * Every argument is an already-evaluated `Option`, so all the checks run; they
 * are pure string comparisons with no side effects, exactly like Go's, and the
 * REPORTED failure is still the first one. Use `firstFailureLazy` when a later
 * check would be expensive or would misbehave on input an earlier check
 * rejects.
 */
export const firstFailure = (
  checks: ReadonlyArray<Option.Option<UsageError>>
): Option.Option<UsageError> => {
  for (const check of checks) {
    if (Option.isSome(check)) return check
  }
  return pass
}

/** `firstFailure` over thunks, for checks that must not be evaluated early. */
export const firstFailureLazy = (
  checks: ReadonlyArray<() => Option.Option<UsageError>>
): Option.Option<UsageError> => {
  for (const check of checks) {
    const result = check()
    if (Option.isSome(result)) return result
  }
  return pass
}

// ---------------------------------------------------------------------------
// Positional argument counts
// ---------------------------------------------------------------------------

/**
 * cobra's `PositionalArgs` validators, all three of them.
 *
 * DEVIATION, corner case only: Go runs these before `PersistentPreRunE`, so
 * `oytc --format bogus search a b` reports the ARG error. Here the global
 * format/timeout check lives in root.ts's `Command.provide`, which the
 * framework evaluates before any handler body, so that one invocation reports
 * the FORMAT error instead. Each check alone is verbatim and exits 2; only
 * their relative precedence when BOTH fail differs, and only against the two
 * global flags. root.ts is not ours to change — reported to the orchestrator.
 */
export const exactArgs = (count: number, received: number): Option.Option<UsageError> =>
  received === count ? pass : fail(`expected ${count} argument(s), received ${received}`)

export const minimumArgs = (count: number, received: number): Option.Option<UsageError> =>
  received >= count ? pass : fail(`expected at least ${count} argument(s), received ${received}`)

export const maximumArgs = (count: number, received: number): Option.Option<UsageError> =>
  received <= count ? pass : fail(`expected at most ${count} argument(s), received ${received}`)

// ---------------------------------------------------------------------------
// Pagination (Go: the PreRunE installed by addListFlags)
// ---------------------------------------------------------------------------

export interface ListFlagValues {
  readonly pageSize: number
  readonly pageToken: string
  readonly all: boolean
  readonly limit: number
}

/**
 * `--page-size` bounds then `--limit >= 0`, in that order.
 *
 * The bounds are per-command and are NOT all 1..50 (SPEC_API §3.2): `comment
 * replies`/`threads` are 1..100 and `live-chat` is 200..2000. Go's shared
 * `addListFlags` always formats "between 1 and <max>"; `live-chat` does not use
 * it and hard-codes "between 200 and 2000". So `minSize` defaults to 1 and a
 * caller with a different minimum passes both `minSize` and the exact
 * `message` it wants.
 */
export const validatePagination = (
  flags: ListFlagValues,
  maxSize: number,
  options: { readonly minSize?: number; readonly message?: string } = {}
): Option.Option<UsageError> => {
  const minSize = options.minSize ?? 1
  if (flags.pageSize < minSize || flags.pageSize > maxSize) {
    return fail(options.message ?? `--page-size must be between ${minSize} and ${maxSize}`)
  }
  if (flags.limit < 0) return fail("--limit cannot be negative")
  return pass
}

// ---------------------------------------------------------------------------
// strings.TrimSpace
// ---------------------------------------------------------------------------

/**
 * `unicode.IsSpace` as code points.
 *
 * NOT the same set as JS `String.prototype.trim()`: JS also trims U+FEFF
 * (ZERO WIDTH NO-BREAK SPACE), which Go does not consider space, so `trim()`
 * alone would accept a value Go rejects. Listed numerically rather than as
 * literal characters so the set is reviewable and cannot be corrupted by an
 * editor normalizing invisible code points.
 */
const GO_SPACE = new Set<number>([
  0x09, // \t
  0x0a, // \n
  0x0b, // \v
  0x0c, // \f
  0x0d, // \r
  0x20, // space
  0x85, // NEL
  0xa0, // NBSP
  0x1680, // OGHAM SPACE MARK
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x2028, // LINE SEPARATOR
  0x2029, // PARAGRAPH SEPARATOR
  0x202f, // NARROW NO-BREAK SPACE
  0x205f, // MEDIUM MATHEMATICAL SPACE
  0x3000 // IDEOGRAPHIC SPACE
])

const isGoSpace = (rune: string): boolean => GO_SPACE.has(rune.codePointAt(0) ?? -1)

export const goTrimSpace = (value: string): string => {
  const runes = Array.from(value)
  let start = 0
  let end = runes.length
  while (start < end && isGoSpace(runes[start]!)) start++
  while (end > start && isGoSpace(runes[end - 1]!)) end--
  return runes.slice(start, end).join("")
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * `validateEnum` — an EMPTY value always passes (it means "flag not set"), and
 * the comparison is exact: no trimming, no case folding.
 */
export const validateEnum = (
  flag: string,
  value: string,
  allowed: ReadonlyArray<string>
): Option.Option<UsageError> => {
  if (value === "") return pass
  if (allowed.includes(value)) return pass
  return fail(`${flag} must be one of: ${allowed.join(", ")}`)
}

/**
 * `validateCSVEnum` — split on `,`, TRIM each entry, then run `validateEnum`.
 *
 * The trim means `--type "video, channel"` passes, and the empty-value pass in
 * `validateEnum` means a trailing comma (`"video,"`) passes too. Both are Go's
 * behaviour, not accidents of this port.
 */
export const validateCsvEnum = (
  flag: string,
  value: string,
  allowed: ReadonlyArray<string>
): Option.Option<UsageError> => {
  for (const entry of value.split(",")) {
    const check = validateEnum(flag, goTrimSpace(entry), allowed)
    if (Option.isSome(check)) return check
  }
  return pass
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * `partsOr` — the fallback is used when the value is empty OR entirely
 * whitespace, but the value is otherwise passed through UNTRIMMED.
 */
export const partsOr = (value: string, fallback: string): string =>
  goTrimSpace(value) === "" ? fallback : value

/**
 * `validateParts` — reject owner-only parts.
 *
 * Each comma-separated entry is trimmed before comparison, so
 * `--parts " fileDetails "` is rejected (verified against the binary), and the
 * message quotes the FORBIDDEN part — not the user's spelling — through `%q`
 * / `strconv.Quote`.
 */
export const validateParts = (
  parts: string,
  forbidden: ReadonlyArray<string>
): Option.Option<UsageError> => {
  for (const value of parts.split(",")) {
    for (const blocked of forbidden) {
      if (goTrimSpace(value) === blocked) {
        return fail(`part ${goQuote(blocked)} requires owner/OAuth access and is not supported`)
      }
    }
  }
  return pass
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const isDigits = (value: string): boolean => /^[0-9]+$/.test(value)

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const isLeap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const daysIn = (year: number, month: number): number =>
  month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1]!

/**
 * `time.Parse(time.RFC3339, value)` — strict, and NOT what `new Date(...)`
 * accepts. Every rule below was confirmed against `/tmp/oytc-ref`:
 *
 *   accepted: `2024-01-01T00:00:00Z`, `…+05:00`, `…-00:00`, fractional seconds
 *             of ANY length (`,` works as the separator too), `1:00:00` (the
 *             HOUR may be one digit), `…+24:00` and `…+05:60` (see the zone
 *             note), `0000-01-01T00:00:00Z`
 *   rejected: a lowercase `t` or `z`, a missing zone, `+0500` (no colon), a
 *             one-digit month/day/minute/second, a 5-digit year, a leading or
 *             trailing space, a bare `.` with no fractional digits, month 0/13,
 *             day 0/32, `2023-02-29`, `2024-04-31`, hour 24, minute 60,
 *             second 60 (Go rejects leap seconds here), `+25:00`, `+00:61`,
 *             any trailing text
 *
 * Two surprises, both differentially confirmed against the binary:
 *
 * 1. The one-digit HOUR. Go's `Parse(RFC3339, …)` first tries the fast path
 *    `parseRFC3339`, which is strictly fixed-width, and on failure falls back
 *    to the general layout parser — where the reference hour `15` is read by
 *    `getnum(…, false)` as "one OR two digits", while `01`/`02`/`04`/`05` stay
 *    fixed-width. So `2024-01-01T1:00:00Z` really does parse.
 *
 * 2. The ZONE is range-checked, but with `>` and not `>=`. Go's comment says
 *    it outright: "The range test use > rather than >=, as some people do write
 *    offsets of 24 hours or 60 minutes or 60 seconds." Hence `+24:00` and
 *    `+00:60` pass while `+25:00` and `+00:61` fail. An earlier reading of this
 *    port had the zone unchecked; the `+99:99` case caught it.
 */
export const parsesAsRfc3339 = (value: string): boolean => {
  let rest = value

  const fixed = (width: number): number | undefined => {
    const head = rest.slice(0, width)
    if (head.length !== width || !isDigits(head)) return undefined
    rest = rest.slice(width)
    return Number(head)
  }

  const literal = (char: string): boolean => {
    if (!rest.startsWith(char)) return false
    rest = rest.slice(char.length)
    return true
  }

  const year = fixed(4)
  if (year === undefined || !literal("-")) return false
  const month = fixed(2)
  if (month === undefined || month < 1 || month > 12 || !literal("-")) return false
  const day = fixed(2)
  if (day === undefined || day < 1 || !literal("T")) return false
  if (day > daysIn(year, month)) return false

  // The hour is `15` in Go's layout: one or two digits, unlike every other
  // numeric field here.
  const hourText = rest.length >= 2 && isDigits(rest.slice(0, 2)) ? rest.slice(0, 2) : rest.slice(0, 1)
  if (hourText === "" || !isDigits(hourText)) return false
  rest = rest.slice(hourText.length)
  if (Number(hourText) > 23) return false

  if (!literal(":")) return false
  const minute = fixed(2)
  if (minute === undefined || minute > 59 || !literal(":")) return false
  const second = fixed(2)
  if (second === undefined || second > 59) return false

  // Optional fractional seconds: the separator MUST be followed by a digit.
  if (rest.startsWith(".") || rest.startsWith(",")) {
    rest = rest.slice(1)
    let digits = 0
    while (digits < rest.length && isDigits(rest[digits]!)) digits++
    if (digits === 0) return false
    rest = rest.slice(digits)
  }

  // Zone: `Z` (uppercase only) or ±HH:MM, with Go's deliberately loose
  // `hh > 24 || mm > 60` bound rather than the tight one.
  if (rest === "Z") return true
  if (rest.length !== 6) return false
  const sign = rest[0]
  if (sign !== "+" && sign !== "-") return false
  const zoneHour = rest.slice(1, 3)
  const zoneMinute = rest.slice(4, 6)
  if (!isDigits(zoneHour) || rest[3] !== ":" || !isDigits(zoneMinute)) return false
  return Number(zoneHour) <= 24 && Number(zoneMinute) <= 60
}

/** `validateTimestamp` — empty passes; anything else must parse as RFC 3339. */
export const validateTimestamp = (flag: string, value: string): Option.Option<UsageError> => {
  if (value === "") return pass
  return parsesAsRfc3339(value) ? pass : fail(`${flag} must be an RFC 3339 timestamp`)
}

// ---------------------------------------------------------------------------
// Cross-flag checks
// ---------------------------------------------------------------------------

/** `(a == "") != (b == "")` — both set or neither. */
export const requireTogether = (
  a: string,
  b: string,
  message: string
): Option.Option<UsageError> => ((a === "") !== (b === "") ? fail(message) : pass)

/** `(flagEmpty) == (positionalAbsent)` — exactly one of the two. */
export const requireExactlyOne = (
  first: boolean,
  second: boolean,
  message: string
): Option.Option<UsageError> => (first === second ? fail(message) : pass)

/** A plain predicate check, for the one-off cross-flag rules. */
export const requireThat = (ok: boolean, message: string): Option.Option<UsageError> =>
  ok ? pass : fail(message)

/** Raise an already-built check failure from inside a handler. */
export const raise = (error: UsageError): Effect.Effect<never, UsageError> => Effect.fail(error)

// ---------------------------------------------------------------------------
// Shared flag groups (Go: addListFlags / addAPIFlags)
// ---------------------------------------------------------------------------

/**
 * `addListFlags`, minus the PreRunE — the bounds check is
 * `validatePagination`, called from the handler so it fires in Go's order
 * relative to the arg-count check.
 *
 * `--page-size` is declared as an integer with the command's own default; the
 * VALID RANGE is deliberately not expressed as a `Flag.filter`, because that
 * would produce the framework's "Invalid value" text instead of Go's
 * `--page-size must be between 1 and 50`.
 */
export const listFlags = (options: { readonly pageSize: number; readonly maxSize?: number }) => ({
  pageSize: Flag.integer("page-size").pipe(
    Flag.withDefault(options.pageSize),
    Flag.withDescription(`results per request (1-${options.maxSize ?? 50})`)
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
})

/**
 * `addAPIFlags(cmd, &api, withHL = false)`.
 *
 * Two separate groups rather than one parameterised builder: `--hl` exists only
 * on the commands Go passes `withHL = true`, and declaring it unconditionally
 * would make `oytc search --hl en` succeed where Go reports
 * `unknown flag: --hl`. A conditional spread hides `hl` from the inferred type
 * as well as the parser, which is worse than two named constants.
 */
export const apiFlags = {
  parts: Flag.string("parts").pipe(
    Flag.withDefault(""),
    Flag.withDescription("comma-separated API resource parts")
  ),
  fields: Flag.string("fields").pipe(
    Flag.withDefault(""),
    Flag.withDescription("Google partial-response fields selector")
  )
}

/** `addAPIFlags(cmd, &api, withHL = true)`. */
export const apiFlagsWithHl = {
  ...apiFlags,
  hl: Flag.string("hl").pipe(
    Flag.withDefault(""),
    Flag.withDescription("localization language code")
  )
}

/** `--published-after` / `--published-before`, shared by search and activities. */
export const publishedFlags = {
  publishedAfter: Flag.string("published-after").pipe(
    Flag.withDefault(""),
    Flag.withDescription("RFC 3339 lower publication bound")
  ),
  publishedBefore: Flag.string("published-before").pipe(
    Flag.withDefault(""),
    Flag.withDescription("RFC 3339 upper publication bound")
  )
}

/** `youtube.PageOptions{…}` from the parsed list flags. */
export const pageOptionsOf = (
  flags: ListFlagValues,
  filter?: ((item: JsonObject) => boolean) | undefined
): PageOptions => ({
  all: flags.all,
  limit: flags.limit,
  pageSize: flags.pageSize,
  pageToken: flags.pageToken,
  filter
})

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

/**
 * `setValues(params, map)` — set each key whose value is NON-EMPTY.
 *
 * Go iterates a `map[string]string`, whose order is randomized; the params are
 * sorted at encode time, so order here is unobservable. A defined iteration
 * order is used anyway so tests can assert on the param list directly.
 */
export const setValues = (
  base: Params,
  entries: Readonly<Record<string, string | undefined>>
): Params => {
  const out: Array<readonly [string, string]> = [...base]
  for (const key of Object.keys(entries)) {
    const value = entries[key]
    if (value !== undefined && value !== "") out.push([key, value])
  }
  return out
}

/** IDs per batch-get request: 50 for channels/videos/playlists, 100 for comments. */
export const BATCH_SIZE = 50

/** `batch(values, size)` — contiguous chunks; an empty input yields no chunks. */
export const batch = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

/**
 * `validateRequestedItems` — every requested ID must have come back.
 *
 * Step 3 is the subtle one: when NO ids were recoverable from the response (a
 * `--fields` selector stripped them) equal cardinality is accepted, because it
 * is the strongest check available without overriding the user's selector.
 *
 * The failure is a `NotFoundError` (exit 4), not a `UsageError`: Go returns a
 * bare `fmt.Errorf` here, and its message-substring classifier routes anything
 * containing "not found" to exit 4.
 */
export const validateRequestedItems = (
  resource: string,
  requested: ReadonlyArray<string>,
  items: ReadonlyArray<JsonObject>
): Effect.Effect<void, NotFoundError> => {
  const uniqueRequested: Array<string> = []
  const seen = new Set<string>()
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

  // Step 3: the equal-cardinality escape hatch.
  if (returned.size === 0 && items.length === uniqueRequested.length) return Effect.void

  let missing: ReadonlyArray<string> = []
  if (returned.size > 0) {
    missing = uniqueRequested.filter((id) => !returned.has(id))
  } else if (items.length < uniqueRequested.length) {
    missing = uniqueRequested
  }

  if (missing.length === 0) return Effect.void
  return Effect.fail(
    new NotFoundError({ message: `${resource} not found: ${missing.join(", ")}` })
  )
}

/**
 * The error ADT. Each variant carries its own process exit code via
 * `Runtime.errorExitCode`, which `BunRuntime.runMain` reads off the squashed
 * error — verified end-to-end, including through a compiled binary.
 *
 * Exit code meanings (from docs/commands.md):
 *   0   success
 *   2   usage / validation error
 *   3   missing or invalid API key / OAuth authorization
 *   4   resource unavailable, not found, or forbidden
 *   5   quota or rate limit
 *   6   network, temporary upstream, config, or other operational failure
 *   130 interrupted
 */

import { Data, Runtime } from "effect"

/** HTTP status -> canonical reason phrase, matching Go's http.StatusText. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
}

/** Go's http.StatusText returns "" for unrecognised codes; do not invent one. */
export const statusText = (status: number): string => STATUS_TEXT[status] ?? ""

export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string
}> {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false
}

export class MissingKeyError extends Data.TaggedError("MissingKeyError")<{}> {
  readonly [Runtime.errorExitCode] = 3
  readonly [Runtime.errorReported] = false
  get message(): string {
    return "no API key configured; run 'oytc login' or set OYTC_API_KEY"
  }
}

export class MissingOAuthError extends Data.TaggedError("MissingOAuthError")<{
  /** analytics appends "; analytics requires OAuth" */
  readonly suffix?: string | undefined
}> {
  readonly [Runtime.errorExitCode] = 3
  readonly [Runtime.errorReported] = false
  get message(): string {
    return `no OAuth credentials configured; run 'oytc login --oauth'${this.suffix ?? ""}`
  }
}

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly httpStatus: number
  /** envelope error.code, falling back to httpStatus when absent/zero */
  readonly code: number
  /** envelope error.message, falling back to the canonical status text */
  readonly apiMessage: string
  /** errors[].reason then details[].reason; empties skipped, duplicates kept */
  readonly reasons: ReadonlyArray<string>
}> {
  readonly [Runtime.errorReported] = false
  get message(): string {
    return this.reasons.length > 0
      ? `YouTube API error (${this.code}, ${this.reasons.join(", ")}): ${this.apiMessage}`
      : `YouTube API error (${this.code}): ${this.apiMessage}`
  }
  get [Runtime.errorExitCode](): number {
    return apiExitCode(this)
  }
}

export class OAuthError extends Data.TaggedError("OAuthError")<{
  readonly httpStatus: number
  readonly code: string
  readonly description: string
}> {
  readonly [Runtime.errorReported] = false
  get message(): string {
    const code = this.code === "" ? "unknown" : this.code
    return this.description === ""
      ? `OAuth error (${code})`
      : `OAuth error (${code}): ${this.description}`
  }
  get [Runtime.errorExitCode](): number {
    if (this.code === "server_error" || this.code === "temporarily_unavailable") return 6
    if (this.httpStatus === 429) return 5
    if (this.httpStatus >= 500) return 6
    return 3
  }
}

export type AuthHintPrefix =
  | "OAuth authorization failed; re-run 'oytc login --oauth'"
  | "OAuth scopes are insufficient; re-run 'oytc login --oauth'"

/** Wrapper produced by oauthAuthHint(); preserves the cause for classification. */
export class AuthHintError extends Data.TaggedError("AuthHintError")<{
  readonly prefix: AuthHintPrefix
  readonly cause: OytcError
}> {
  readonly [Runtime.errorExitCode] = 3
  readonly [Runtime.errorReported] = false
  get message(): string {
    return `${this.prefix}: ${flattenMessage(this.cause)}`
  }
}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string
}> {
  readonly [Runtime.errorExitCode] = 4
  readonly [Runtime.errorReported] = false
}

export class OperationalError extends Data.TaggedError("OperationalError")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly [Runtime.errorExitCode] = 6
  readonly [Runtime.errorReported] = false
}

export class CancelledError extends Data.TaggedError("CancelledError")<{}> {
  readonly [Runtime.errorExitCode] = 130
  readonly [Runtime.errorReported] = false
  get message(): string {
    return "context canceled"
  }
}

export type OytcError =
  | UsageError
  | MissingKeyError
  | MissingOAuthError
  | ApiError
  | OAuthError
  | AuthHintError
  | NotFoundError
  | OperationalError
  | CancelledError

/**
 * Exit code for an ApiError.
 *
 * DEVIATIONS.md D1b: Go applied two different normalizations to the same
 * reasons string in one decision table — the auth test stripped `_`/`-` while
 * the quota test did not, so `RATE_LIMIT_EXCEEDED` fell through to 6 while
 * `userRateLimitExceeded` correctly hit 5. Google returns SCREAMING_SNAKE
 * reasons in newer API surfaces, so that miss was real.
 *
 * Here one normalization is applied to EVERY reason test. Consequences:
 *   RATE_LIMIT_EXCEEDED  -> 5 (was 6)
 *   rate-limit-exceeded  -> 5 (was 6)
 *   QUOTA_EXCEEDED       -> 5 (was 6)
 *   userRateLimitExceeded, quotaExceeded -> 5 (unchanged)
 *   dailyLimitExceeded   -> unmatched (unchanged; contains neither substring)
 *
 * Ordering is preserved: quota is tested before the bare-403 rule, so a 403
 * carrying a quota reason still exits 5 while a bare 403 exits 4. That
 * specific-before-general precedence is correct and deliberate.
 */
export const apiExitCode = (e: {
  readonly httpStatus: number
  readonly reasons: ReadonlyArray<string>
}): number => {
  const normalized = e.reasons.join(",").toLowerCase().replaceAll("_", "").replaceAll("-", "")

  if (
    normalized.includes("keyinvalid") ||
    normalized.includes("apikeyinvalid") ||
    normalized.includes("accessnotconfigured") ||
    normalized.includes("insufficientpermissions") ||
    e.httpStatus === 401
  ) {
    return 3
  }
  if (e.httpStatus === 404) return 4
  if (e.httpStatus === 429 || normalized.includes("quota") || normalized.includes("ratelimit")) {
    return 5
  }
  if (e.httpStatus === 403) return 4
  if (e.httpStatus >= 500) return 6
  return 6
}

/** Go's %w chain flattened to a single line, as the stderr printer emits it. */
export const flattenMessage = (e: OytcError): string => e.message

/**
 * The full first-match-wins classifier, mirroring Go's exitCode(err).
 * Individual error classes carry their own code; this exists for the tests
 * and for classifying errors that reach main.ts without a code attached.
 */
export const exitCodeFor = (e: OytcError): number => {
  switch (e._tag) {
    case "UsageError":
      return 2
    case "MissingKeyError":
    case "MissingOAuthError":
    case "AuthHintError":
      return 3
    case "OAuthError":
      return e[Runtime.errorExitCode]
    case "ApiError":
      return apiExitCode(e)
    case "NotFoundError":
      return 4
    case "CancelledError":
      return 130
    case "OperationalError":
      return 6
  }
}

/**
 * Substring heuristics Go applies to errors that are not one of the structured
 * types. Kept separate so the structured path stays exact.
 */
export const exitCodeForMessage = (message: string): number => {
  const lower = message.toLowerCase()
  if (lower.includes("invalid_grant") || lower.includes("re-run 'oytc login --oauth'")) return 3
  if (lower.includes("unknown command") || lower.includes("unknown flag")) return 2
  if (
    lower.includes("not found") ||
    lower.includes("no active public live chat") ||
    lower.includes("no public uploads")
  ) {
    return 4
  }
  return 6
}

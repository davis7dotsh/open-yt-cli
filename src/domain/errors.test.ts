import { describe, expect, test } from "bun:test"
import {
  ApiError,
  apiExitCode,
  CancelledError,
  exitCodeFor,
  exitCodeForMessage,
  MissingKeyError,
  MissingOAuthError,
  NotFoundError,
  OAuthError,
  OperationalError,
  statusText,
  UsageError
} from "./errors.ts"

const api = (httpStatus: number, reasons: ReadonlyArray<string> = []) =>
  new ApiError({ httpStatus, code: httpStatus, apiMessage: "msg", reasons })

describe("ApiError exit codes", () => {
  test.each([
    [401, [], 3, "401 is auth regardless of reasons"],
    [400, ["keyInvalid"], 3, "keyInvalid"],
    [400, ["key_invalid"], 3, "underscore stripped"],
    [400, ["key-invalid"], 3, "dash stripped"],
    [400, ["API_KEY_INVALID"], 3, "screaming snake"],
    [403, ["accessNotConfigured"], 3, "accessNotConfigured"],
    [403, ["insufficientPermissions"], 3, "insufficientPermissions"],
    [404, [], 4, "not found"],
    [404, ["quotaExceeded"], 4, "404 wins over quota (ordering)"],
    [429, [], 5, "429 is rate limit"],
    [403, ["quotaExceeded"], 5, "quota 403 beats bare 403"],
    [403, [], 4, "bare 403 is forbidden"],
    [500, [], 6, "upstream"],
    [503, [], 6, "upstream"],
    [400, [], 6, "unclassified"]
  ])("status %d reasons %o -> %d (%s)", (status, reasons, expected) => {
    expect(apiExitCode({ httpStatus: status, reasons })).toBe(expected)
  })

  // DEVIATIONS.md D1b — one normalization applied to every reason test.
  // Go used the un-normalized string for the quota check, so these three
  // fell through to 6.
  describe("D1b: consistent reason normalization", () => {
    test.each([
      ["RATE_LIMIT_EXCEEDED", 5],
      ["rate-limit-exceeded", 5],
      ["QUOTA_EXCEEDED", 5],
      ["quota_exceeded", 5]
    ])("%s -> %d (was 6 in Go)", (reason, expected) => {
      expect(apiExitCode({ httpStatus: 400, reasons: [reason] })).toBe(expected)
    })

    test.each([
      ["userRateLimitExceeded", 5],
      ["quotaExceeded", 5]
    ])("%s -> %d (unchanged from Go)", (reason, expected) => {
      expect(apiExitCode({ httpStatus: 400, reasons: [reason] })).toBe(expected)
    })

    test("dailyLimitExceeded still does not match (unchanged, out of scope)", () => {
      expect(apiExitCode({ httpStatus: 400, reasons: ["dailyLimitExceeded"] })).toBe(6)
    })
  })
})

describe("error messages", () => {
  test("ApiError with reasons", () => {
    expect(
      new ApiError({
        httpStatus: 403,
        code: 403,
        apiMessage: "Quota exceeded.",
        reasons: ["quotaExceeded", "dailyLimitExceeded"]
      }).message
    ).toBe("YouTube API error (403, quotaExceeded, dailyLimitExceeded): Quota exceeded.")
  })

  test("ApiError without reasons", () => {
    expect(
      new ApiError({ httpStatus: 500, code: 500, apiMessage: "Boom", reasons: [] }).message
    ).toBe("YouTube API error (500): Boom")
  })

  test("ApiError prints envelope code, not http status", () => {
    expect(
      new ApiError({ httpStatus: 400, code: 403, apiMessage: "x", reasons: [] }).message
    ).toBe("YouTube API error (403): x")
  })

  test("MissingKeyError", () => {
    expect(new MissingKeyError().message).toBe(
      "no API key configured; run 'oytc login' or set OYTC_API_KEY"
    )
  })

  test("MissingOAuthError plain and with analytics suffix", () => {
    expect(new MissingOAuthError({}).message).toBe(
      "no OAuth credentials configured; run 'oytc login --oauth'"
    )
    expect(
      new MissingOAuthError({ suffix: "; analytics requires OAuth" }).message
    ).toBe("no OAuth credentials configured; run 'oytc login --oauth'; analytics requires OAuth")
  })

  test("OAuthError with and without description", () => {
    expect(
      new OAuthError({ httpStatus: 400, code: "invalid_grant", description: "expired" }).message
    ).toBe("OAuth error (invalid_grant): expired")
    expect(new OAuthError({ httpStatus: 400, code: "", description: "" }).message).toBe(
      "OAuth error (unknown)"
    )
  })
})

describe("OAuthError exit codes", () => {
  test.each([
    ["server_error", 500, 6],
    ["temporarily_unavailable", 503, 6],
    ["invalid_grant", 429, 5],
    ["invalid_grant", 500, 6],
    ["invalid_grant", 400, 3],
    ["", 400, 3]
  ])("code=%s status=%d -> %d", (code, httpStatus, expected) => {
    expect(exitCodeFor(new OAuthError({ httpStatus, code, description: "" }))).toBe(expected)
  })
})

describe("exitCodeFor across the ADT", () => {
  test.each([
    [new UsageError({ message: "bad" }), 2],
    [new MissingKeyError(), 3],
    [new MissingOAuthError({}), 3],
    [new NotFoundError({ message: "video not found" }), 4],
    [new OperationalError({ message: "network down" }), 6],
    [new CancelledError(), 130],
    [api(429), 5]
  ])("%o -> %d", (err, expected) => {
    expect(exitCodeFor(err)).toBe(expected)
  })
})

describe("message-substring fallbacks", () => {
  test.each([
    ["oauth invalid_grant here", 3],
    ["please re-run 'oytc login --oauth'", 3],
    ["unknown command \"foo\"", 2],
    ["unknown flag: --bar", 2],
    ["channel not found", 4],
    ["no active public live chat", 4],
    ["channel has no public uploads playlist", 4],
    ["something else entirely", 6]
  ])("%s -> %d", (message, expected) => {
    expect(exitCodeForMessage(message)).toBe(expected)
  })
})

describe("statusText", () => {
  test.each([
    [403, "Forbidden"],
    [429, "Too Many Requests"],
    [503, "Service Unavailable"],
    [500, "Internal Server Error"],
    [404, "Not Found"],
    [401, "Unauthorized"]
  ])("%d -> %s", (status, expected) => {
    expect(statusText(status)).toBe(expected)
  })

  test("unrecognised status yields empty string, not an invented phrase", () => {
    expect(statusText(599)).toBe("")
  })
})

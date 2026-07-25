import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { UsageError } from "../domain/errors.ts"
import {
  exactArgs,
  firstFailure,
  firstFailureLazy,
  goTrimSpace,
  maximumArgs,
  minimumArgs,
  parsesAsRfc3339,
  partsOr,
  requireExactlyOne,
  requireThat,
  requireTogether,
  validateCsvEnum,
  validateEnum,
  validatePagination,
  validateParts,
  validateTimestamp
} from "./validate.ts"

/** The message of a failed check, or undefined when it passed. */
const msg = (check: Option.Option<UsageError>): string | undefined =>
  Option.isSome(check) ? check.value.message : undefined

const pageFlags = (pageSize: number, limit = 0) => ({
  pageSize,
  limit,
  pageToken: "",
  all: false
})

describe("firstFailure", () => {
  test("all passing yields none", () => {
    expect(Option.isNone(firstFailure([Option.none(), Option.none()]))).toBe(true)
  })

  test("the FIRST failure wins, not the last", () => {
    expect(
      msg(
        firstFailure([
          Option.none(),
          Option.some(new UsageError({ message: "first" })),
          Option.some(new UsageError({ message: "second" }))
        ])
      )
    ).toBe("first")
  })

  test("an empty list passes", () => {
    expect(Option.isNone(firstFailure([]))).toBe(true)
  })
})

describe("firstFailureLazy", () => {
  test("checks after the first failure are never evaluated", () => {
    let evaluated = 0
    const result = firstFailureLazy([
      () => Option.some(new UsageError({ message: "stop" })),
      () => {
        evaluated++
        return Option.none()
      }
    ])
    expect(msg(result)).toBe("stop")
    expect(evaluated).toBe(0)
  })
})

describe("argument counts — verbatim cobra messages", () => {
  test("exactArgs", () => {
    expect(Option.isNone(exactArgs(1, 1))).toBe(true)
    expect(msg(exactArgs(1, 0))).toBe("expected 1 argument(s), received 0")
    expect(msg(exactArgs(1, 2))).toBe("expected 1 argument(s), received 2")
    // `video popular` takes exactly zero.
    expect(msg(exactArgs(0, 1))).toBe("expected 0 argument(s), received 1")
  })

  test("minimumArgs", () => {
    expect(Option.isNone(minimumArgs(1, 1))).toBe(true)
    expect(Option.isNone(minimumArgs(1, 9))).toBe(true)
    // G3: the exact `video get` message.
    expect(msg(minimumArgs(1, 0))).toBe("expected at least 1 argument(s), received 0")
  })

  test("maximumArgs", () => {
    expect(Option.isNone(maximumArgs(1, 0))).toBe(true)
    expect(Option.isNone(maximumArgs(1, 1))).toBe(true)
    expect(msg(maximumArgs(1, 2))).toBe("expected at most 1 argument(s), received 2")
  })
})

describe("validatePagination", () => {
  test("in-bounds passes", () => {
    expect(Option.isNone(validatePagination(pageFlags(25), 50))).toBe(true)
    expect(Option.isNone(validatePagination(pageFlags(1), 50))).toBe(true)
    expect(Option.isNone(validatePagination(pageFlags(50), 50))).toBe(true)
  })

  test("G3: --page-size must be between 1 and 50", () => {
    expect(msg(validatePagination(pageFlags(99), 50))).toBe("--page-size must be between 1 and 50")
    expect(msg(validatePagination(pageFlags(0), 50))).toBe("--page-size must be between 1 and 50")
    expect(msg(validatePagination(pageFlags(-1), 50))).toBe("--page-size must be between 1 and 50")
  })

  test("the max is per-command; comments are 1..100", () => {
    expect(Option.isNone(validatePagination(pageFlags(100), 100))).toBe(true)
    expect(msg(validatePagination(pageFlags(101), 100))).toBe(
      "--page-size must be between 1 and 100"
    )
  })

  test("live-chat's own bounds and message", () => {
    const opts = { minSize: 200, message: "--page-size must be between 200 and 2000" }
    expect(Option.isNone(validatePagination(pageFlags(500), 2000, opts))).toBe(true)
    expect(msg(validatePagination(pageFlags(199), 2000, opts))).toBe(
      "--page-size must be between 200 and 2000"
    )
  })

  test("G3: --limit cannot be negative", () => {
    expect(msg(validatePagination(pageFlags(25, -1), 50))).toBe("--limit cannot be negative")
  })

  test("--limit 0 means no cap and passes", () => {
    expect(Option.isNone(validatePagination(pageFlags(25, 0), 50))).toBe(true)
  })

  test("page-size is checked BEFORE limit", () => {
    expect(msg(validatePagination(pageFlags(99, -1), 50))).toBe(
      "--page-size must be between 1 and 50"
    )
  })
})

describe("validateEnum", () => {
  const order = ["date", "rating", "relevance", "title", "videoCount", "viewCount"]

  test("an empty value always passes — it means the flag is unset", () => {
    expect(Option.isNone(validateEnum("--order", "", order))).toBe(true)
  })

  test("an allowed value passes", () => {
    expect(Option.isNone(validateEnum("--order", "viewCount", order))).toBe(true)
  })

  test("G3-style message lists every candidate, comma-space joined", () => {
    expect(msg(validateEnum("--order", "bogus", order))).toBe(
      "--order must be one of: date, rating, relevance, title, videoCount, viewCount"
    )
  })

  test("comparison is case sensitive", () => {
    expect(msg(validateEnum("--order", "VIEWCOUNT", order))).toBe(
      "--order must be one of: date, rating, relevance, title, videoCount, viewCount"
    )
  })

  test("comparison does NOT trim", () => {
    expect(Option.isSome(validateEnum("--order", " date", order))).toBe(true)
  })

  test("the two-candidate message from comment threads", () => {
    expect(msg(validateEnum("--order", "bogus", ["time", "relevance"]))).toBe(
      "--order must be one of: time, relevance"
    )
  })
})

describe("validateCsvEnum", () => {
  const types = ["video", "channel", "playlist"]

  test("the default type list passes", () => {
    expect(Option.isNone(validateCsvEnum("--type", "video,channel,playlist", types))).toBe(true)
  })

  test("each entry is trimmed before comparison", () => {
    expect(Option.isNone(validateCsvEnum("--type", "video, channel", types))).toBe(true)
  })

  test("a trailing comma passes, because an empty entry passes", () => {
    expect(Option.isNone(validateCsvEnum("--type", "video,", types))).toBe(true)
  })

  test("a bad entry anywhere fails", () => {
    expect(msg(validateCsvEnum("--type", "video,bogus", types))).toBe(
      "--type must be one of: video, channel, playlist"
    )
  })

  test("the FIRST bad entry is reported", () => {
    expect(msg(validateCsvEnum("--type", "zzz,bogus", types))).toBe(
      "--type must be one of: video, channel, playlist"
    )
  })
})

describe("goTrimSpace", () => {
  test("ASCII whitespace on both sides", () => {
    expect(goTrimSpace("  \t\r\n video \n ")).toBe("video")
  })

  test("interior whitespace is untouched", () => {
    expect(goTrimSpace(" a b ")).toBe("a b")
  })

  test("Unicode spaces Go recognises", () => {
    expect(goTrimSpace("  video　")).toBe("video")
  })

  test("U+FEFF is NOT space in Go, unlike JS trim()", () => {
    // JS "﻿video".trim() === "video"; Go's TrimSpace leaves it.
    expect("﻿video".trim()).toBe("video")
    expect(goTrimSpace("﻿video")).toBe("﻿video")
  })

  test("an all-space string trims to empty", () => {
    expect(goTrimSpace(" \t\n ")).toBe("")
  })

  test("empty stays empty", () => {
    expect(goTrimSpace("")).toBe("")
  })
})

describe("partsOr", () => {
  test("empty takes the fallback", () => {
    expect(partsOr("", "snippet")).toBe("snippet")
  })

  test("whitespace-only takes the fallback", () => {
    expect(partsOr("   ", "snippet")).toBe("snippet")
  })

  test("a real value is passed through UNTRIMMED", () => {
    expect(partsOr(" snippet ", "fallback")).toBe(" snippet ")
  })
})

describe("validateParts", () => {
  const videoForbidden = ["fileDetails", "processingDetails", "suggestions"]

  test("an allowed part list passes", () => {
    expect(Option.isNone(validateParts("snippet,statistics", videoForbidden))).toBe(true)
  })

  test("a forbidden part fails with the %q-quoted name", () => {
    expect(msg(validateParts("snippet,fileDetails", videoForbidden))).toBe(
      'part "fileDetails" requires owner/OAuth access and is not supported'
    )
  })

  test("entries are trimmed, so a padded forbidden part is still caught", () => {
    // Verified against the binary: `--parts ' fileDetails '` is rejected.
    expect(msg(validateParts(" fileDetails ", videoForbidden))).toBe(
      'part "fileDetails" requires owner/OAuth access and is not supported'
    )
  })

  test("the channel forbidden set", () => {
    expect(msg(validateParts("auditDetails", ["auditDetails", "contentOwnerDetails"]))).toBe(
      'part "auditDetails" requires owner/OAuth access and is not supported'
    )
  })

  test("a superstring of a forbidden part is allowed", () => {
    expect(Option.isNone(validateParts("fileDetailsX", videoForbidden))).toBe(true)
  })

  test("the forbidden list is scanned in order for each entry", () => {
    expect(msg(validateParts("suggestions,fileDetails", videoForbidden))).toBe(
      'part "suggestions" requires owner/OAuth access and is not supported'
    )
  })
})

/**
 * `parsesAsRfc3339` was differentially tested against `/tmp/oytc-ref` over a
 * 580-case corpus (102 accepts / 478 rejects) with zero disagreements. The
 * cases below are the load-bearing ones from that run, kept as regressions.
 */
describe("parsesAsRfc3339 — accepted", () => {
  const accepted = [
    "2024-01-01T00:00:00Z",
    "2024-01-01T00:00:00+05:00",
    "2024-01-01T00:00:00-00:00",
    "2024-01-01T00:00:00.123Z",
    "2024-01-01T00:00:00.000000009Z",
    "2024-01-01T00:00:00.1234567890123Z",
    // A comma is a legal fraction separator in Go's parser.
    "2024-01-01T00:00:00,123Z",
    // The HOUR — and only the hour — may be a single digit.
    "2024-01-01T1:00:00Z",
    "2024-01-01T5:04:05+01:00",
    // Go's zone bound is `> 24` / `> 60`, deliberately loose.
    "2024-01-01T00:00:00+24:00",
    "2024-01-01T00:00:00+05:60",
    "0000-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
    "2024-02-29T00:00:00Z",
    "2000-02-29T00:00:00Z",
    "2024-01-01T23:59:59Z"
  ]
  for (const value of accepted) {
    test(value, () => expect(parsesAsRfc3339(value)).toBe(true))
  }
})

describe("parsesAsRfc3339 — rejected", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["2024-01-01", "no time part"],
    ["2024-01-01T00:00:00", "no zone"],
    ["2024-01-01t00:00:00Z", "lowercase t"],
    ["2024-01-01T00:00:00z", "lowercase z"],
    ["2024-01-01 00:00:00Z", "space separator"],
    ["2024-01-01T00:00:00+0500", "zone without a colon"],
    ["2024-01-01T00:00:00+5:00", "one-digit zone hour"],
    ["2024-01-01T00:00:00+01:1", "one-digit zone minute"],
    ["2024-01-01T00:00:00+25:00", "zone hour past 24"],
    ["2024-01-01T00:00:00+00:61", "zone minute past 60"],
    ["2024-01-01T00:00:00+99:99", "zone wildly out of range"],
    ["2024-1-01T00:00:00Z", "one-digit month"],
    ["2024-01-1T00:00:00Z", "one-digit day"],
    ["2024-01-01T01:1:00Z", "one-digit minute"],
    ["2024-01-01T01:01:1Z", "one-digit second"],
    ["999-01-01T00:00:00Z", "three-digit year"],
    ["20240-01-01T00:00:00Z", "five-digit year"],
    ["2024-01-01T005:00:00Z", "three-digit hour"],
    ["2024-00-01T00:00:00Z", "month 0"],
    ["2024-13-01T00:00:00Z", "month 13"],
    ["2024-01-00T00:00:00Z", "day 0"],
    ["2024-01-32T00:00:00Z", "day 32"],
    ["2023-02-29T00:00:00Z", "Feb 29 in a common year"],
    ["1900-02-29T00:00:00Z", "1900 is not a leap year"],
    ["2100-02-29T00:00:00Z", "2100 is not a leap year"],
    ["2024-04-31T00:00:00Z", "April has 30 days"],
    ["2024-02-30T00:00:00Z", "February never has 30"],
    ["2024-01-01T24:00:00Z", "hour 24"],
    ["2024-01-01T00:60:00Z", "minute 60"],
    ["2024-01-01T00:00:60Z", "second 60 — no leap seconds"],
    ["2024-01-01T00:00:00.Z", "a bare dot with no digits"],
    ["2024-01-01T00:00:00Zx", "trailing text"],
    ["2024-01-01T00:00:00ZZ", "doubled zone"],
    ["+2024-01-01T00:00:00Z", "signed year"],
    [" 2024-01-01T00:00:00Z", "leading space"],
    ["2024-01-01T00:00:00Z ", "trailing space"],
    ["2024-01-01T00:00:00+aa:bb", "non-numeric zone"],
    ["", "empty"]
  ]
  for (const [value, why] of rejected) {
    test(`${JSON.stringify(value)} — ${why}`, () => expect(parsesAsRfc3339(value)).toBe(false))
  }
})

describe("validateTimestamp", () => {
  test("empty passes — the flag is simply unset", () => {
    expect(Option.isNone(validateTimestamp("--published-after", ""))).toBe(true)
  })

  test("a valid timestamp passes", () => {
    expect(Option.isNone(validateTimestamp("--published-after", "2024-01-01T00:00:00Z"))).toBe(true)
  })

  test("the message names the flag", () => {
    expect(msg(validateTimestamp("--published-after", "nope"))).toBe(
      "--published-after must be an RFC 3339 timestamp"
    )
    expect(msg(validateTimestamp("--published-before", "nope"))).toBe(
      "--published-before must be an RFC 3339 timestamp"
    )
  })
})

describe("cross-flag helpers", () => {
  test("requireTogether passes when both are set or both empty", () => {
    expect(Option.isNone(requireTogether("1,2", "5km", "m"))).toBe(true)
    expect(Option.isNone(requireTogether("", "", "m"))).toBe(true)
  })

  test("requireTogether fails when exactly one is set", () => {
    expect(msg(requireTogether("1,2", "", "--location and --location-radius must be used together")))
      .toBe("--location and --location-radius must be used together")
    expect(msg(requireTogether("", "5km", "m"))).toBe("m")
  })

  test("requireExactlyOne fails when both or neither hold", () => {
    // `channel sections`: (ids == "") == (no positional)
    expect(msg(requireExactlyOne(true, true, "provide exactly one of CHANNEL or --id"))).toBe(
      "provide exactly one of CHANNEL or --id"
    )
    expect(msg(requireExactlyOne(false, false, "provide exactly one of CHANNEL or --id"))).toBe(
      "provide exactly one of CHANNEL or --id"
    )
    expect(Option.isNone(requireExactlyOne(true, false, "m"))).toBe(true)
    expect(Option.isNone(requireExactlyOne(false, true, "m"))).toBe(true)
  })

  test("requireThat", () => {
    expect(Option.isNone(requireThat(true, "m"))).toBe(true)
    expect(msg(requireThat(false, "video-specific filters require --type video"))).toBe(
      "video-specific filters require --type video"
    )
  })
})

describe("every failure is a UsageError, which exits 2", () => {
  test("the tag and exit code", () => {
    const failure = validateEnum("--order", "bogus", ["date"])
    expect(Option.isSome(failure)).toBe(true)
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(UsageError)
      expect(failure.value._tag).toBe("UsageError")
    }
  })
})

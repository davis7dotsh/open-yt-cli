import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { parseJson } from "../json/parse.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { rawNumber } from "../json/value.ts"
import {
  analyticsDemographicsColumns,
  analyticsOverviewColumns,
  analyticsOverviewMetrics,
  analyticsReportColumns,
  analyticsTrafficSourcesColumns,
  analyticsVideoColumns,
  categoryListColumns,
  cell,
  channelActivitiesColumns,
  channelGetColumns,
  channelSectionsColumns,
  channelUploadsColumns,
  clean,
  commentColumns,
  commentThreadsColumns,
  fallbackColumns,
  generateRows,
  goUpper,
  headerCell,
  headerRow,
  languageListColumns,
  liveChatColumns,
  pathValue,
  playlistGetColumns,
  playlistItemsColumns,
  playlistListColumns,
  regionListColumns,
  resolveColumns,
  rowCells,
  searchColumns,
  statusCheckColumns,
  statusColumns,
  subscriptionListColumns,
  updateColumns,
  versionColumns,
  videoGetColumns,
  videoPopularColumns,
  videoStatsColumns,
  videoTrainabilityColumns
} from "./columns.ts"

const obj = (text: string): JsonObject => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as JsonObject
}

describe("goUpper — Go strings.ToUpper, never length-changing", () => {
  // Every expectation here was produced by the Go implementation via
  // `--columns <path>` header rendering, not by JS toUpperCase().
  test.each([
    ["snippet.title", "SNIPPET.TITLE"],
    ["contentDetails.videoId", "CONTENTDETAILS.VIDEOID"],
    ["api_key.configured", "API_KEY.CONFIGURED"],
    ["snippet.topLevelComment.snippet.authorDisplayName", "SNIPPET.TOPLEVELCOMMENT.SNIPPET.AUTHORDISPLAYNAME"],
    ["", ""],
    ["ALREADY.UPPER", "ALREADY.UPPER"],
    ["123-x_y", "123-X_Y"]
  ])("%s -> %s", (input, want) => {
    expect(goUpper(input)).toBe(want)
  })

  test("ß stays ß (JS would produce SS)", () => {
    expect(goUpper("straße")).toBe("STRAßE")
    expect("straße".toUpperCase()).toBe("STRASSE")
  })

  test("ﬁ ligature stays (JS would produce FI)", () => {
    expect(goUpper("ﬁle")).toBe("ﬁLE")
  })

  test("dotless i uppercases to I", () => {
    expect(goUpper("ıd")).toBe("ID")
  })

  test("ǳ maps to the upper form Ǳ, not the title form ǲ", () => {
    expect(goUpper("ǳx")).toBe("ǱX")
  })

  // The "leave any length-changing rune alone" rule has 27 counter-examples:
  // the Greek iota-subscript letters, where Go DOES have a 1-rune simple
  // mapping (to the prosgegrammeni capital) but JS decomposes to capital +
  // U+0399. Every expectation below came from Go 1.26.5 `strings.ToUpper`.
  // Escapes, not literals: NFC normalization would not disturb these, but an
  // editor that "fixes" Greek text might.
  test.each([
    ["ᾀ", "ᾈ"], // ᾀ -> ᾈ   (JS full: "ἈΙ")
    ["ᾇ", "ᾏ"],
    ["ᾐ", "ᾘ"],
    ["ᾗ", "ᾟ"],
    ["ᾠ", "ᾨ"],
    ["ᾧ", "ᾯ"],
    ["ᾳ", "ᾼ"], // ᾳ -> ᾼ   delta is +9 here, not +8
    ["ῃ", "ῌ"],
    ["ῳ", "ῼ"]
  ])("iota subscript %s uppercases to one rune %s", (input, want) => {
    expect(goUpper(input)).toBe(want)
    expect(input.toUpperCase()).not.toBe(want) // JS alone gets this wrong
  })

  test("an iota-subscript rune inside a real column path", () => {
    expect(goUpper("ᾀid")).toBe("ᾈID")
  })

  test("the exception table never lengthens a string", () => {
    for (const cp of [0x1f80, 0x1f87, 0x1f90, 0x1fa7, 0x1fb3, 0x1fc3, 0x1ff3]) {
      const ch = String.fromCodePoint(cp)
      expect(Array.from(goUpper(ch)).length).toBe(1)
    }
  })

  test("ligatures and ß still stay put (they have no 1-rune mapping)", () => {
    // Guards against the exception table being widened into "uppercase everything".
    expect(goUpper("ßﬁﬃ")).toBe("ßﬁﬃ")
  })

  test("headerCell is goUpper of the whole dotted path", () => {
    expect(headerCell("snippet.title")).toBe("SNIPPET.TITLE")
  })
})

describe("pathValue", () => {
  test("walks a dotted path", () => {
    expect(pathValue(obj('{"a":{"b":{"c":"deep"}}}'), "a.b.c")).toBe("deep")
  })

  test("single segment", () => {
    expect(pathValue(obj('{"id":"x"}'), "id")).toBe("x")
  })

  test("missing key is null", () => {
    expect(pathValue(obj('{"id":"x"}'), "nope")).toBeNull()
  })

  test("explicit null is null", () => {
    expect(pathValue(obj('{"a":null}'), "a")).toBeNull()
  })

  test("intermediate is a string -> null", () => {
    expect(pathValue(obj('{"a":"notobject"}'), "a.b.c")).toBeNull()
  })

  test("intermediate is a bool -> null", () => {
    expect(pathValue(obj('{"a":true}'), "a.b")).toBeNull()
  })

  test("intermediate is null -> null", () => {
    expect(pathValue(obj('{"a":null}'), "a.b")).toBeNull()
  })

  test("intermediate is an array -> null (arrays are not objects)", () => {
    expect(pathValue(obj('{"a":[1,2]}'), "a.0")).toBeNull()
  })

  test("intermediate is a number -> null", () => {
    expect(pathValue(obj('{"a":5}'), "a.b")).toBeNull()
  })

  test("a key containing a literal dot is unreachable", () => {
    expect(pathValue(obj('{"a.b":"direct"}'), "a.b")).toBeNull()
  })

  test("leading dot means an empty first segment", () => {
    expect(pathValue(obj('{"":{"id":"x"}}'), ".id")).toBe("x")
  })

  test("trailing dot means an empty last segment", () => {
    expect(pathValue(obj('{"id":{"":"y"}}'), "id.")).toBe("y")
  })

  test("empty column path reads the empty-string key", () => {
    expect(pathValue(obj('{"":"weird"}'), "")).toBe("weird")
  })

  test("returns whole subtrees, not just leaves", () => {
    expect(pathValue(obj('{"a":{"b":1}}'), "a")).toEqual({ b: rawNumber("1") })
  })
})

describe("cell", () => {
  test("null is the empty string", () => {
    expect(cell(null)).toBe("")
  })

  test("string passes through clean()", () => {
    expect(cell("plain")).toBe("plain")
  })

  test("booleans", () => {
    expect(cell(true)).toBe("true")
    expect(cell(false)).toBe("false")
  })

  test.each([
    ["1.50", "1.50"],
    ["1e3", "1e3"],
    ["1E+10", "1E+10"],
    ["-0.0", "-0.0"],
    ["900719925474099312345", "900719925474099312345"]
  ])("number literal %s is emitted verbatim", (literal, want) => {
    expect(cell(rawNumber(literal))).toBe(want)
  })

  test("array joins with a bare comma", () => {
    expect(cell(["a", "b", "c"])).toBe("a,b,c")
  })

  test("empty array is the empty string", () => {
    expect(cell([])).toBe("")
  })

  test("array elements render recursively; null becomes an empty slot", () => {
    // Go golden for --columns arr over [1,"a",null,{"z":1,"a":2}]
    const value = (parseJson('[1,"a",null,{"z":1,"a":2}]') as Result.Result<JsonValue, never>)
    expect(Result.isSuccess(value)).toBe(true)
    expect(cell(Result.getOrThrow(value))).toBe("1,a,,a=2,z=1")
  })

  test("object renders sorted k=v pairs", () => {
    expect(cell({ z: "1", a: "2" })).toBe("a=2,z=1")
  })

  test("empty object is the empty string", () => {
    expect(cell({})).toBe("")
  })

  test("nested objects flatten ambiguously", () => {
    // Go golden: {"b":{"c":"1","a":"2"},"a":"x"} -> "a=x,b=a=2,c=1"
    expect(cell(obj('{"b":{"c":"1","a":"2"},"a":"x"}'))).toBe("a=x,b=a=2,c=1")
  })

  test("object keys sort by UTF-8 bytes, not UTF-16 units", () => {
    // U+FFFF (0xEF 0xBF 0xBF) sorts BEFORE U+10000 (0xF0 0x90 0x80 0x80) in
    // UTF-8, but AFTER it under a naive UTF-16 comparison.
    expect(cell({ "\u{10000}": "astral", "￿": "bmp" })).toBe("￿=bmp,\u{10000}=astral")
  })

  test("a RawNumber is not mistaken for an object", () => {
    expect(cell({ n: rawNumber("42") })).toBe("n=42")
  })
})

describe("clean — only tab, CR, LF become spaces", () => {
  test("the Go output_test.go case", () => {
    expect(clean("line one\nline two")).toBe("line one line two")
  })

  test("each of tab/CR/LF maps to exactly one space", () => {
    expect(clean("a\tb\rc\nd")).toBe("a b c d")
  })

  test("CRLF becomes TWO spaces, not one", () => {
    expect(clean("a\r\nb")).toBe("a  b")
  })

  test("vertical tab and form feed SURVIVE (they are not in the replacer)", () => {
    expect(clean("a\vb\fc")).toBe("a\vb\fc")
  })

  test("backspace, NUL and other controls survive", () => {
    expect(clean("a\bb c")).toBe("a\bb c")
  })

  test("clean is applied by cell()", () => {
    expect(cell("x\ty")).toBe("x y")
  })
})

describe("resolveColumns", () => {
  test("requested wins", () => {
    expect(resolveColumns(["a"], ["b"])).toEqual(["a"])
  })

  test("defaults when nothing requested", () => {
    expect(resolveColumns([], ["b"])).toEqual(["b"])
  })

  test("global fallback when both are empty", () => {
    expect(resolveColumns([], [])).toEqual(["id", "snippet.title"])
    expect(fallbackColumns).toEqual(["id", "snippet.title"])
  })
})

describe("row generation", () => {
  test("rowCells maps each column through pathValue+cell", () => {
    expect(rowCells(obj('{"id":"v","snippet":{"title":"T"}}'), ["id", "snippet.title", "nope"])).toEqual([
      "v",
      "T",
      ""
    ])
  })

  test("headerRow uppercases every column", () => {
    expect(headerRow(["id", "snippet.title"])).toEqual(["ID", "SNIPPET.TITLE"])
  })

  test("generateRows includes the header by default", () => {
    expect(generateRows([obj('{"id":"a"}')], ["id"], false)).toEqual([["ID"], ["a"]])
  })

  test("generateRows omits the header when suppressed", () => {
    expect(generateRows([obj('{"id":"a"}')], ["id"], true)).toEqual([["a"]])
  })

  test("no items still emits the header row", () => {
    expect(generateRows([], ["id", "x"], false)).toEqual([["ID", "X"]])
  })

  test("no items and no header emits nothing", () => {
    expect(generateRows([], ["id", "x"], true)).toEqual([])
  })
})

describe("default column sets (27 of them)", () => {
  // Every list below was read out of the Go call site named in the comment on
  // the corresponding export in columns.ts.
  test("search", () => {
    expect(searchColumns).toEqual(["id.kind", "id.videoId", "id.channelId", "id.playlistId", "snippet.title"])
  })

  test("channel get", () => {
    expect(channelGetColumns).toEqual([
      "id",
      "snippet.title",
      "statistics.subscriberCount",
      "statistics.videoCount",
      "statistics.viewCount"
    ])
  })

  test("channel activities", () => {
    expect(channelActivitiesColumns).toEqual(["id", "snippet.publishedAt", "snippet.type", "snippet.title"])
  })

  test("channel sections", () => {
    expect(channelSectionsColumns).toEqual(["id", "snippet.type", "snippet.position", "snippet.title"])
  })

  test("channel uploads", () => {
    expect(channelUploadsColumns).toEqual([
      "snippet.position",
      "contentDetails.videoId",
      "snippet.title",
      "snippet.publishedAt"
    ])
  })

  test("video get", () => {
    expect(videoGetColumns).toEqual([
      "id",
      "snippet.title",
      "snippet.channelTitle",
      "contentDetails.duration",
      "statistics.viewCount"
    ])
  })

  test("video stats", () => {
    expect(videoStatsColumns).toEqual([
      "id",
      "statistics.viewCount",
      "statistics.likeCount",
      "statistics.commentCount"
    ])
  })

  test("video popular", () => {
    expect(videoPopularColumns).toEqual(["id", "snippet.title", "snippet.channelTitle", "statistics.viewCount"])
  })

  test("video trainability", () => {
    expect(videoTrainabilityColumns).toEqual(["videoId", "permitted"])
  })

  test("playlist get", () => {
    expect(playlistGetColumns).toEqual([
      "id",
      "snippet.title",
      "snippet.channelTitle",
      "contentDetails.itemCount",
      "status.privacyStatus"
    ])
  })

  test("playlist list", () => {
    expect(playlistListColumns).toEqual([
      "id",
      "snippet.title",
      "contentDetails.itemCount",
      "status.privacyStatus"
    ])
  })

  test("playlist items", () => {
    expect(playlistItemsColumns).toEqual([
      "snippet.position",
      "contentDetails.videoId",
      "snippet.title",
      "snippet.videoOwnerChannelTitle"
    ])
  })

  test("comment get and comment replies share one list", () => {
    expect(commentColumns).toEqual([
      "id",
      "snippet.authorDisplayName",
      "snippet.textDisplay",
      "snippet.likeCount",
      "snippet.publishedAt"
    ])
  })

  test("comment threads", () => {
    expect(commentThreadsColumns).toEqual([
      "id",
      "snippet.topLevelComment.snippet.authorDisplayName",
      "snippet.topLevelComment.snippet.textDisplay",
      "snippet.totalReplyCount"
    ])
  })

  test("subscription list", () => {
    expect(subscriptionListColumns).toEqual([
      "id",
      "snippet.resourceId.channelId",
      "snippet.title",
      "contentDetails.totalItemCount"
    ])
  })

  test("category list", () => {
    expect(categoryListColumns).toEqual(["id", "snippet.title", "snippet.assignable"])
  })

  test("language list", () => {
    expect(languageListColumns).toEqual(["id", "snippet.name"])
  })

  test("region list", () => {
    expect(regionListColumns).toEqual(["id", "snippet.name", "snippet.glName"])
  })

  test("live-chat list and stream", () => {
    expect(liveChatColumns).toEqual([
      "snippet.publishedAt",
      "authorDetails.displayName",
      "snippet.displayMessage",
      "snippet.type",
      "id"
    ])
  })

  test("analytics report is dimensions then metrics", () => {
    expect(analyticsReportColumns(["day"], ["views", "likes"])).toEqual(["day", "views", "likes"])
    expect(analyticsReportColumns([], ["views"])).toEqual(["views"])
  })

  test("analytics overview without --by", () => {
    expect(analyticsOverviewColumns("")).toEqual([
      "views",
      "estimatedMinutesWatched",
      "averageViewDuration",
      "averageViewPercentage",
      "subscribersGained"
    ])
  })

  test("analytics overview with --by prepends the dimension", () => {
    expect(analyticsOverviewColumns("day")).toEqual(["day", ...analyticsOverviewMetrics])
  })

  test("analytics overview treats a whitespace --by as unset (csvValues trims)", () => {
    expect(analyticsOverviewColumns("  ")).toEqual([...analyticsOverviewMetrics])
  })

  test("analytics video", () => {
    expect(analyticsVideoColumns).toEqual([
      "views",
      "estimatedMinutesWatched",
      "averageViewDuration",
      "likes",
      "comments",
      "subscribersGained"
    ])
  })

  test("analytics traffic-sources", () => {
    expect(analyticsTrafficSourcesColumns).toEqual([
      "insightTrafficSourceType",
      "views",
      "estimatedMinutesWatched"
    ])
  })

  test("analytics demographics", () => {
    expect(analyticsDemographicsColumns).toEqual(["ageGroup", "gender", "viewerPercentage"])
  })

  test("status without --check", () => {
    expect(statusColumns).toEqual([
      "path",
      "api_key.configured",
      "api_key.source",
      "api_key.fingerprint",
      "oauth.configured",
      "oauth.client_id",
      "oauth.scopes",
      "oauth.expiry"
    ])
  })

  test("status --check adds api_key.valid and oauth.valid in place", () => {
    expect(statusCheckColumns).toEqual([
      "path",
      "api_key.configured",
      "api_key.source",
      "api_key.fingerprint",
      "api_key.valid",
      "oauth.configured",
      "oauth.client_id",
      "oauth.scopes",
      "oauth.expiry",
      "oauth.valid"
    ])
  })

  test("version", () => {
    expect(versionColumns).toEqual(["version", "commit", "date", "goVersion", "os", "arch"])
  })

  test("update uses the renamed asset/executable keys", () => {
    expect(updateColumns).toEqual([
      "currentVersion",
      "targetVersion",
      "updated",
      "upToDate",
      "asset",
      "executable"
    ])
  })
})

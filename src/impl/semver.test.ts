import { describe, expect, test } from "bun:test"
import { compareVersions, goTrimSpace, parseVersion } from "./semver.ts"

/** Port of Go's `TestCompareVersions` — the same nine rows, same order. */
describe("TestCompareVersions", () => {
  const cases: ReadonlyArray<{
    readonly a: string
    readonly b: string
    readonly want: number
    readonly comparable: boolean
  }> = [
    { a: "v1.2.3", b: "v1.2.3", want: 0, comparable: true },
    { a: "v1.2.3", b: "1.2.3", want: 0, comparable: true },
    { a: "v0.2.0", b: "v0.10.0", want: -1, comparable: true },
    { a: "v2.0.0", b: "v1.9.9", want: 1, comparable: true },
    { a: "v1.0.0-rc.1", b: "v1.0.0", want: -1, comparable: true },
    { a: "v1.0.0", b: "v1.0.0-rc.1", want: 1, comparable: true },
    { a: "v1.0.0-rc.1", b: "v1.0.0-rc.2", want: -1, comparable: true },
    { a: "dev", b: "v1.0.0", want: 0, comparable: false },
    { a: "v1.0.0", b: "unknown", want: 0, comparable: false }
  ]

  for (const { a, b, want, comparable } of cases) {
    test(`compareVersions(${a}, ${b}) = ${want}, ${comparable}`, () => {
      expect(compareVersions(a, b)).toEqual({ order: want as -1 | 0 | 1, comparable })
    })
  }
})

describe("byte-wise prerelease comparison", () => {
  /**
   * The behaviour the port MUST preserve: this is a plain string compare, not
   * SemVer's dot-separated identifier compare. Under SemVer rc.10 > rc.2;
   * here it is smaller, exactly as Go's `av.pre < bv.pre` decides.
   */
  test("rc.10 sorts BEFORE rc.2 (not SemVer ordering)", () => {
    expect(compareVersions("v1.0.0-rc.10", "v1.0.0-rc.2")).toEqual({
      order: -1,
      comparable: true
    })
    expect(compareVersions("v1.0.0-rc.2", "v1.0.0-rc.10")).toEqual({
      order: 1,
      comparable: true
    })
  })

  test("alpha < beta", () => {
    expect(compareVersions("v1.0.0-alpha", "v1.0.0-beta").order).toBe(-1)
  })

  test("uppercase sorts before lowercase, as ASCII bytes do", () => {
    expect(compareVersions("v1.0.0-RC.1", "v1.0.0-rc.1").order).toBe(-1)
  })

  test("identical prereleases are equal", () => {
    expect(compareVersions("v1.0.0-rc.1", "1.0.0-rc.1")).toEqual({ order: 0, comparable: true })
  })

  test("a shorter prefix sorts first", () => {
    expect(compareVersions("v1.0.0-rc", "v1.0.0-rc.1").order).toBe(-1)
  })
})

describe("numeric ordering", () => {
  test("compares major, then minor, then patch", () => {
    expect(compareVersions("v1.0.0", "v0.99.99").order).toBe(1)
    expect(compareVersions("v1.0.0", "v1.1.0").order).toBe(-1)
    expect(compareVersions("v1.1.1", "v1.1.0").order).toBe(1)
  })

  test("numeric, not lexical: 10 > 9", () => {
    expect(compareVersions("v0.10.0", "v0.9.0").order).toBe(1)
  })

  test("leading zeros are numeric values, as strconv.Atoi reads them", () => {
    expect(compareVersions("v01.02.03", "v1.2.3")).toEqual({ order: 0, comparable: true })
  })

  test("counters beyond 2^32 still compare", () => {
    expect(compareVersions("v4294967296.0.0", "v4294967295.0.0").order).toBe(1)
  })
})

describe("parseVersion", () => {
  test("accepts a bare or v-prefixed core", () => {
    expect(parseVersion("1.2.3")).toEqual({ numbers: [1, 2, 3], prerelease: "" })
    expect(parseVersion("v1.2.3")).toEqual({ numbers: [1, 2, 3], prerelease: "" })
  })

  test("strips surrounding whitespace", () => {
    expect(parseVersion("  v1.2.3\t")).toEqual({ numbers: [1, 2, 3], prerelease: "" })
  })

  test("splits the prerelease at the FIRST dash only", () => {
    expect(parseVersion("1.2.3-a-b")).toEqual({ numbers: [1, 2, 3], prerelease: "a-b" })
  })

  /**
   * Verified against Go: `strings.Cut(core, "+")` runs on the CORE only, after
   * the prerelease has already been split off, so build metadata attached to a
   * prerelease stays part of the prerelease string.
   */
  test("build metadata is stripped from the core only", () => {
    expect(parseVersion("1.2.3+build")).toEqual({ numbers: [1, 2, 3], prerelease: "" })
    expect(parseVersion("1.2.3-rc.1+b")).toEqual({ numbers: [1, 2, 3], prerelease: "rc.1+b" })
  })

  test("a trailing dash yields an empty (release) prerelease", () => {
    expect(parseVersion("1.2.3-")).toEqual({ numbers: [1, 2, 3], prerelease: "" })
  })

  test("rejects anything that is not exactly three dot-separated parts", () => {
    for (const tag of ["1.2", "1.2.3.4", "1", "..", "1..3"]) {
      expect(parseVersion(tag)).toBeUndefined()
    }
  })

  test("rejects non-integer components, matching strconv.Atoi", () => {
    for (const tag of ["1.2.x", "1.2.3e0", "1.2. 3", "1.2.0x3", "1.2.1_0", "1.2.٣"]) {
      expect(parseVersion(tag)).toBeUndefined()
    }
  })

  test("rejects negative components", () => {
    expect(parseVersion("1.-2.3")).toBeUndefined()
  })

  /**
   * Verified against Go: the build-metadata cut runs at the FIRST `+`, so a
   * leading `+` empties the core and the tag is rejected before `strconv.Atoi`
   * (which would otherwise have accepted `+1`) is ever reached.
   */
  test("a leading plus empties the core and is rejected", () => {
    expect(parseVersion("+1.2.3")).toBeUndefined()
    expect(parseVersion("1.+2.3")).toBeUndefined()
    expect(parseVersion("1.2.+3")).toBeUndefined()
  })

  test("rejects values past int64, where Atoi reports out of range", () => {
    expect(parseVersion("99999999999999999999.0.0")).toBeUndefined()
  })

  test("rejects the empty tag and a bare v", () => {
    expect(parseVersion("")).toBeUndefined()
    expect(parseVersion("v")).toBeUndefined()
    expect(parseVersion("   ")).toBeUndefined()
  })

  test("a leading dash makes the core empty and unparseable", () => {
    expect(parseVersion("-1.2.3")).toBeUndefined()
  })

  test("dev and unknown never parse, which is what keeps them incomparable", () => {
    expect(parseVersion("dev")).toBeUndefined()
    expect(parseVersion("unknown")).toBeUndefined()
  })
})

describe("goTrimSpace", () => {
  test("strips the Go whitespace set", () => {
    expect(goTrimSpace("\t\n\v\f\r x \r\n")).toBe("x")
    expect(goTrimSpace(" x ")).toBe("x")
    expect(goTrimSpace(" x ")).toBe("x")
  })

  test("strips U+0085 (NEL), which JS trim() leaves in place", () => {
    expect(goTrimSpace("x")).toBe("x")
  })

  test("does NOT strip U+FEFF, which JS trim() removes", () => {
    expect(goTrimSpace("﻿x")).toBe("﻿x")
  })
})

describe("incomparability is not equality", () => {
  test("an unparseable current version reports comparable=false, not order=0", () => {
    const result = compareVersions("v0.2.0", "dev")
    expect(result.comparable).toBe(false)
    // The updater keys off `comparable` before it looks at `order`, which is
    // what makes a dev build always proceed to install rather than report
    // itself up to date.
    expect(result.order).toBe(0)
  })

  test("both sides unparseable", () => {
    expect(compareVersions("dev", "dev")).toEqual({ order: 0, comparable: false })
  })
})

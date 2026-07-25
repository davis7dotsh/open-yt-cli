/**
 * Ports `internal/version/version_test.go` (2 cases).
 *
 * `TestGetDefaults` asserted `info.GoVersion === runtime.Version()` and
 * `OS/Arch === runtime.GOOS/GOARCH`. The TS analogue asserts the Bun version
 * under the retained `goVersion` key, and the Go-spelled os/arch.
 *
 * `TestGetUsesInjectedValues` mutated the package variables. Bun's `--define`
 * is not mutable at runtime, so `resolveVersionDetails(overrides)` is the
 * equivalent seam.
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  goarch,
  goos,
  makeVersionInfo,
  resolveVersionDetails,
  runtimeVersion
} from "./versionInfo.ts"

const noEnv = () => undefined

describe("resolveVersionDetails", () => {
  // internal/version/version_test.go: TestGetDefaults
  test("defaults are dev/unknown/unknown with a populated runtime and platform", () => {
    const info = resolveVersionDetails({ env: noEnv })
    expect(info.version).toBe("dev")
    expect(info.commit).toBe("unknown")
    expect(info.date).toBe("unknown")
    expect(info.goVersion).toBe(runtimeVersion())
    expect(info.goVersion).toBe(`bun${Bun.version}`)
    expect(info.os).toBe(goos(process.platform))
    expect(info.arch).toBe(goarch(process.arch))
    expect(info.version).not.toBe("")
  })

  // internal/version/version_test.go: TestGetUsesInjectedValues
  test("injected values win over the defaults", () => {
    const info = resolveVersionDetails({
      version: "v9.9.9",
      commit: "abcdef1",
      date: "2026-01-02T03:04:05Z",
      env: noEnv
    })
    expect(info.version).toBe("v9.9.9")
    expect(info.commit).toBe("abcdef1")
    expect(info.date).toBe("2026-01-02T03:04:05Z")
  })

  test("the six documented JSON keys are all present, goVersion included", () => {
    const info = resolveVersionDetails({ env: noEnv })
    expect(Object.keys(info).sort()).toEqual([
      "arch",
      "commit",
      "date",
      "goVersion",
      "os",
      "version"
    ])
  })

  test("an empty override is ignored rather than blanking the field", () => {
    const info = resolveVersionDetails({ version: "", commit: "", date: "", env: noEnv })
    expect(info.version).toBe("dev")
    expect(info.commit).toBe("unknown")
    expect(info.date).toBe("unknown")
  })

  test("OYTC_* env vars fill in for an unstamped build", () => {
    const env = (name: string) =>
      ({ OYTC_VERSION: "v0.4.2", OYTC_COMMIT: "cafe123", OYTC_DATE: "2026-07-24T00:00:00Z" })[
        name
      ]
    const info = resolveVersionDetails({ env })
    expect(info.version).toBe("v0.4.2")
    expect(info.commit).toBe("cafe123")
    expect(info.date).toBe("2026-07-24T00:00:00Z")
  })

  test("an empty env var does not shadow the default", () => {
    const info = resolveVersionDetails({ env: () => "" })
    expect(info.version).toBe("dev")
    expect(info.commit).toBe("unknown")
  })

  test("platform and arch overrides are normalized to Go spellings", () => {
    const info = resolveVersionDetails({ platform: "win32", arch: "x64", env: noEnv })
    expect(info.os).toBe("windows")
    expect(info.arch).toBe("amd64")
  })
})

describe("goos / goarch", () => {
  test.each([
    ["darwin", "darwin"],
    ["linux", "linux"],
    ["win32", "windows"],
    ["freebsd", "freebsd"]
  ])("goos(%s) -> %s", (input, expected) => {
    expect(goos(input)).toBe(expected)
  })

  test.each([
    ["x64", "amd64"],
    ["arm64", "arm64"],
    ["ia32", "386"]
  ])("goarch(%s) -> %s", (input, expected) => {
    expect(goarch(input)).toBe(expected)
  })
})

describe("VersionInfo service", () => {
  test("get resolves the same details", async () => {
    const info = await Effect.runPromise(makeVersionInfo.get)
    expect(info.goVersion).toBe(runtimeVersion())
    expect(info.os).toBe(goos(process.platform))
  })
})

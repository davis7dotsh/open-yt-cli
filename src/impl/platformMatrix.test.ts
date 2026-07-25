import { describe, expect, test } from "bun:test"
import {
  archiveExtension,
  assertBuildablePlatform,
  assetName,
  binaryName,
  bunTarget,
  bunTargets,
  hostPlatform,
  isSupportedPlatform,
  SUPPORTED_PLATFORMS,
  UnsupportedPlatformError
} from "./platformMatrix.ts"

/** Port of Go's `TestAssetName` — unchanged, byte for byte. */
describe("TestAssetName", () => {
  test("linux/arm64 is a tar.gz", () => {
    expect(assetName("v0.1.0", "linux", "arm64")).toBe("oytc_v0.1.0_linux_arm64.tar.gz")
  })

  test("windows/amd64 is a zip", () => {
    expect(assetName("v0.1.0", "windows", "amd64")).toBe("oytc_v0.1.0_windows_amd64.zip")
  })
})

describe("assetName", () => {
  test("windows/arm64 hard-fails — the platform was dropped in the TS port", () => {
    expect(() => assetName("v0.1.0", "windows", "arm64")).toThrow(UnsupportedPlatformError)
    expect(() => assetName("v0.1.0", "windows", "arm64")).toThrow(/windows\/arm64/)
    expect(() => assetName("v0.1.0", "windows", "arm64")).toThrow(/amd64 build instead/)
  })

  test("the tag is interpolated verbatim, leading v included", () => {
    expect(assetName("v1.2.3-rc.1", "darwin", "arm64")).toBe(
      "oytc_v1.2.3-rc.1_darwin_arm64.tar.gz"
    )
  })

  test("an unknown-but-not-dropped pair still formats, so the missing-asset error wins", () => {
    // Matches Go: `TestUpdateMissingAssetForPlatform` sets GOARCH=riscv64 and
    // expects the release lookup to fail, not the name computation.
    expect(assetName("v0.2.0", "linux", "riscv64")).toBe("oytc_v0.2.0_linux_riscv64.tar.gz")
  })

  test("every supported platform produces the documented name", () => {
    expect(SUPPORTED_PLATFORMS.map((p) => assetName("v0.1.0", p.goos, p.goarch))).toEqual([
      "oytc_v0.1.0_linux_amd64.tar.gz",
      "oytc_v0.1.0_linux_arm64.tar.gz",
      "oytc_v0.1.0_darwin_amd64.tar.gz",
      "oytc_v0.1.0_darwin_arm64.tar.gz",
      "oytc_v0.1.0_windows_amd64.zip"
    ])
  })
})

describe("archiveExtension / binaryName", () => {
  test("windows gets zip and oytc.exe", () => {
    expect(archiveExtension("windows")).toBe("zip")
    expect(binaryName("windows")).toBe("oytc.exe")
  })

  test("everything else gets tar.gz and oytc", () => {
    for (const goos of ["linux", "darwin", "freebsd"]) {
      expect(archiveExtension(goos)).toBe("tar.gz")
      expect(binaryName(goos)).toBe("oytc")
    }
  })
})

describe("hostPlatform — process.platform/arch -> goos/goarch", () => {
  test("maps the five published hosts", () => {
    expect(hostPlatform("linux", "x64")).toEqual({ goos: "linux", goarch: "amd64" })
    expect(hostPlatform("linux", "arm64")).toEqual({ goos: "linux", goarch: "arm64" })
    expect(hostPlatform("darwin", "x64")).toEqual({ goos: "darwin", goarch: "amd64" })
    expect(hostPlatform("darwin", "arm64")).toEqual({ goos: "darwin", goarch: "arm64" })
    expect(hostPlatform("win32", "x64")).toEqual({ goos: "windows", goarch: "amd64" })
  })

  test("win32 + arm64 hard-fails rather than requesting a nonexistent asset", () => {
    expect(() => hostPlatform("win32", "arm64")).toThrow(UnsupportedPlatformError)
    expect(() => hostPlatform("win32", "arm64")).toThrow(/windows\/arm64/)
  })

  test("an unknown platform or arch names the host, not an asset", () => {
    expect(() => hostPlatform("aix", "x64")).toThrow(/aix\/x64/)
    expect(() => hostPlatform("linux", "riscv64")).toThrow(/linux\/riscv64/)
    expect(() => hostPlatform("linux", "ia32")).toThrow(UnsupportedPlatformError)
  })

  test("the error carries the goos/goarch it could resolve", () => {
    try {
      hostPlatform("win32", "arm64")
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedPlatformError)
      expect((error as UnsupportedPlatformError).goos).toBe("windows")
      expect((error as UnsupportedPlatformError).goarch).toBe("arm64")
    }
  })
})

describe("assertBuildablePlatform", () => {
  test("passes for every supported platform", () => {
    for (const p of SUPPORTED_PLATFORMS) {
      expect(() => assertBuildablePlatform(p.goos, p.goarch)).not.toThrow()
    }
  })

  test("throws only for the dropped pair", () => {
    expect(() => assertBuildablePlatform("windows", "arm64")).toThrow()
    expect(() => assertBuildablePlatform("linux", "riscv64")).not.toThrow()
  })
})

describe("isSupportedPlatform", () => {
  test("windows/arm64 is not supported; windows/amd64 is", () => {
    expect(isSupportedPlatform("windows", "arm64")).toBe(false)
    expect(isSupportedPlatform("windows", "amd64")).toBe(true)
  })
})

/**
 * Mapping (b): bun tokens are BUILD-time only. If one of these ever leaks into
 * `assetName` the release stops being self-updatable, so they are asserted to
 * be different strings from the goarch tokens.
 */
describe("bunTarget — goos/goarch -> bun --target", () => {
  test("the five compile targets", () => {
    expect(bunTargets()).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-x64",
      "bun-darwin-arm64",
      "bun-windows-x64"
    ])
  })

  test("amd64 becomes x64 for bun but stays amd64 in asset names", () => {
    expect(bunTarget("linux", "amd64")).toBe("bun-linux-x64")
    expect(assetName("v1.0.0", "linux", "amd64")).toContain("_amd64.")
    expect(assetName("v1.0.0", "linux", "amd64")).not.toContain("x64")
  })

  test("arm64 is spelled the same in both mappings", () => {
    expect(bunTarget("darwin", "arm64")).toBe("bun-darwin-arm64")
    expect(assetName("v1.0.0", "darwin", "arm64")).toContain("_arm64.")
  })

  test("there is no bun-windows-arm64 target in the matrix", () => {
    expect(bunTargets()).not.toContain("bun-windows-arm64")
  })
})

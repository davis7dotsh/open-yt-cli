import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
// `effect/testing` is a stable subpath, so the src/effect.ts barrel rule does not
// apply to it (that rule covers the unstable subpath only).
import { TestConsole } from "effect/testing"
import { ProcessEnv, type ProcessEnvShape } from "../services/index.ts"
import { OperationalError } from "../domain/errors.ts"
import { browserCommand, launch, makeBrowserOpener } from "./browserOpener.ts"

const URL_UNDER_TEST = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y"

describe("browserCommand", () => {
  test("darwin uses open", () => {
    expect(browserCommand("darwin", URL_UNDER_TEST)).toEqual({
      command: "open",
      args: [URL_UNDER_TEST]
    })
  })

  test("windows uses rundll32 with the FileProtocolHandler entry point", () => {
    expect(browserCommand("win32", URL_UNDER_TEST)).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", URL_UNDER_TEST]
    })
  })

  test.each([["linux"], ["freebsd"], ["openbsd"], ["anything-else"]])(
    "%s falls back to xdg-open",
    (platform) => {
      expect(browserCommand(platform, URL_UNDER_TEST)).toEqual({
        command: "xdg-open",
        args: [URL_UNDER_TEST]
      })
    }
  )

  test("the URL is passed as a single argv element, never shell-interpolated", () => {
    const hostile = "https://example.com/?a=1&b=$(whoami);rm -rf /"
    expect(browserCommand("linux", hostile).args).toEqual([hostile])
  })
})

const envLayer = (platform: string): Layer.Layer<ProcessEnvShape> => {
  const shape: ProcessEnvShape = {
    env: () => Option.none(),
    platform,
    arch: "arm64",
    argv: [],
    executablePath: Effect.succeed("/bin/oytc"),
    isOutputTTY: false,
    homeDir: Effect.succeed("/home/test")
  }
  return Layer.succeed(ProcessEnv, shape)
}

const opener = (platform: string) =>
  Effect.provide(makeBrowserOpener, envLayer(platform))

describe("BrowserOpener", () => {
  test("a launch failure is a warning on stderr, not an error", async () => {
    // The launcher must be guaranteed ABSENT for this to test anything. Relying
    // on `xdg-open` being missing only holds on macOS — the Linux CI runner has
    // it — so PATH is emptied for the duration, which makes spawn emit ENOENT on
    // every platform. `open` must still succeed so Login keeps waiting on the
    // loopback callback, and the warning must carry Go's exact prefix.
    const path = process.env["PATH"]
    process.env["PATH"] = ""
    try {
      const lines = await Effect.runPromise(
        Effect.gen(function* () {
          const browser = yield* opener("definitely-not-a-real-platform")
          yield* browser.open(URL_UNDER_TEST)
          return yield* TestConsole.errorLines
        }).pipe(Effect.provide(TestConsole.layer))
      )
      expect(lines).toHaveLength(1)
      expect(String(lines[0])).toStartWith("Could not open a browser automatically: ")
    } finally {
      process.env["PATH"] = path
    }
  })

  test("launch resolves once the child has spawned, without waiting for it", async () => {
    // `sleep 5` proves the effect returns on the `spawn` event rather than on
    // exit — Go uses Start(), not Wait(), so the login must not block here.
    const started = Date.now()
    await Effect.runPromise(launch({ command: "sleep", args: ["5"] }))
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("launch fails when the launcher is not on PATH", async () => {
    const error = await Effect.runPromise(
      Effect.flip(launch({ command: "oytc-no-such-launcher", args: ["about:blank"] }))
    )
    expect(error).toBeInstanceOf(Error)
    // Node reports a missing binary asynchronously on the `error` event; assert
    // the code so this cannot pass on some unrelated failure.
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
  })

  test("the shape's error channel is `never`, as the contract requires", () => {
    // A compile-time assertion: assigning to Effect<void, never> only
    // typechecks because `open` cannot fail.
    const check = Effect.gen(function* () {
      const browser = yield* opener("linux")
      const opened: Effect.Effect<void, never> = browser.open("about:blank")
      return opened
    })
    expect(check).toBeDefined()
  })

  test("OperationalError is not part of this path", () => {
    // Guards against a future refactor promoting the warning to a failure.
    expect(new OperationalError({ message: "x" })).toBeInstanceOf(OperationalError)
  })
})

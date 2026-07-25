/**
 * Detached browser launch for the OAuth consent screen.
 *
 * Go's `oauth.OpenBrowser` calls `exec.Command(...).Start()` — it never waits
 * for the browser to exit, and a failure to launch is non-fatal: `Login` prints
 * `Could not open a browser automatically: <err>` and keeps waiting on the
 * loopback callback, because the URL has already been printed for the user to
 * paste. `BrowserOpenerShape.open` therefore cannot fail; the warning is emitted
 * here, on stderr, where Go emits it.
 *
 * `node:child_process` rather than `Bun.spawn`: the sanctioned Bun-specific
 * import outside `main.ts` is the loopback server only, and `spawn` is
 * identical across both runtimes.
 *
 * Go's `Start()` reports a launch failure synchronously; Node's `spawn` reports
 * it asynchronously on the `error` event, so the effect waits for whichever of
 * `spawn`/`error` fires first before returning.
 */

import { spawn } from "node:child_process"
import { Console, Effect, Layer } from "effect"
import { BrowserOpener, type BrowserOpenerShape, ProcessEnv } from "../services/index.ts"

export interface BrowserCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/** darwin `open`; windows `rundll32 url.dll,FileProtocolHandler`; otherwise `xdg-open`. */
export const browserCommand = (platform: string, url: string): BrowserCommand => {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] }
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
    default:
      return { command: "xdg-open", args: [url] }
  }
}

/** Exported so tests can drive it with a harmless binary instead of a browser. */
export const launch = ({ command, args }: BrowserCommand): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], {
          detached: true,
          stdio: "ignore"
        })
        child.once("error", reject)
        child.once("spawn", () => {
          child.unref()
          resolve()
        })
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
  })

export const makeBrowserOpener = Effect.gen(function* () {
  const env = yield* ProcessEnv
  const shape: BrowserOpenerShape = {
    open: (url) =>
      launch(browserCommand(env.platform, url)).pipe(
        Effect.catch((cause) =>
          Console.error(`Could not open a browser automatically: ${cause.message}`)
        )
      )
  }
  return shape
})

export const BrowserOpenerLive = Layer.effect(BrowserOpener, makeBrowserOpener)

/**
 * The two output paths every command ends in.
 *
 * Ports `(*App).renderResult` from `internal/cli/app.go` and the `RenderObject`
 * call in `internal/cli/channel_video.go`. Both resolve columns the same way —
 * `--columns` if given, else the command's defaults — and hand off to the
 * `Renderer` service; `renderResult` additionally emits the human summary line
 * on stderr.
 *
 * The summary line is emitted ONLY when the format is `table` and `--quiet` is
 * unset. That is Go's rule verbatim: piping to `jq` gets clean JSON with no
 * commentary, and `--quiet` silences it on a terminal too.
 *
 * SHARED HELPER — P8b and P8c import from here read-only. Do not edit outside
 * P8a.
 */

import { Effect, Stdio, Stream } from "effect"
import { OperationalError } from "../domain/errors.ts"
import type { OytcError } from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import { resolveColumns } from "../output/columns.ts"
import { AppOptions, Renderer } from "../services/index.ts"
import type {
  AppOptionsShape,
  RendererShape,
  RenderOptions
} from "../services/index.ts"

/**
 * The `fmt.Fprintf(a.Err, …)` summary.
 *
 * Go writes it as two or three `Fprintf` calls plus an `Fprintln`; the bytes
 * are what matters, so it is assembled once here. Note there is no space before
 * the `;` and the token is NOT quoted.
 */
export const summaryText = (result: ListResult): string =>
  `${result.items.length} item(s), ${result.requests} request(s)${
    result.nextPageToken === ""
      ? ""
      : `; more available (next token: ${result.nextPageToken})`
  }\n`

/** Write one string to stderr through the Stdio service. */
const writeStderr = (text: string): Effect.Effect<void, OperationalError, Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stderr()).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write output", cause }))
      )
    )
  })

/** `AppOptions` + the command's default columns -> the Renderer's options. */
export const renderOptionsFor = (
  options: AppOptionsShape,
  defaultColumns: ReadonlyArray<string>
): RenderOptions => ({
  format: options.format,
  columns: resolveColumns(options.columns, defaultColumns),
  noHeader: options.noHeader
})

/**
 * `renderResult` — render the list envelope, then the stderr summary.
 *
 * The summary is written AFTER stdout, which matters when both are the same
 * terminal: the count appears below the table, as it does in Go.
 */
export const renderResult = (
  result: ListResult,
  defaultColumns: ReadonlyArray<string>
): Effect.Effect<void, OytcError, RendererShape | AppOptionsShape | Stdio.Stdio> =>
  Effect.gen(function* () {
    const options = yield* AppOptions
    const renderer = yield* Renderer
    yield* renderer.render(result, renderOptionsFor(options, defaultColumns))
    if (!options.quiet && options.format === "table") {
      yield* writeStderr(summaryText(result))
    }
  })

/**
 * `RenderObject` — a bare object with no list envelope, and NO summary line.
 *
 * `video trainability` is the only P8a caller; `status`, `version` and `update`
 * (P8c) use the same path. Go passes `a.columns` straight through here rather
 * than going via `renderResult`, so the command's defaults are applied by the
 * caller — `resolveColumns` reproduces that with the same precedence.
 */
export const renderObject = (
  object: JsonObject,
  defaultColumns: ReadonlyArray<string>
): Effect.Effect<void, OytcError, RendererShape | AppOptionsShape> =>
  Effect.gen(function* () {
    const options = yield* AppOptions
    const renderer = yield* Renderer
    yield* renderer.renderObject(object, renderOptionsFor(options, defaultColumns))
  })

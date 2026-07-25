/**
 * Renderer — the `internal/output/output.go` dispatch, writing to stdout.
 *
 * `Render` and `RenderObject` in Go both take an `io.Writer`; here the seam is
 * the Effect `Stdio` service, so tests can capture output with
 * `Stdio.layerTest` and production gets `BunServices.layer`.
 *
 * The whole render is built as one string and written once. That is not just
 * convenient — Go's tabwriter buffers every row and emits nothing until
 * `Flush()`, so a single terminal write is the faithful behavior.
 *
 * NOTE on the format check: Go's `Render` rejects an unknown format with
 * `unsupported format %q (use table, json, jsonl, or tsv)`, which `renderResult`
 * wraps into a UsageError (exit 2). Here `OutputFormat` is a four-member union,
 * so that branch is unreachable by construction and the exhaustive switch has no
 * default arm.
 */

import { Effect, Layer, Stdio, Stream } from "effect"
import { OperationalError } from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"
import { Renderer, type RendererShape, type RenderOptions } from "../services/index.ts"
import { fallbackColumns, generateRows } from "../output/columns.ts"
import { renderJson, renderJsonl, renderObjectJson, renderObjectJsonl } from "../output/jsonOut.ts"
import { renderTable } from "../output/table.ts"
import { renderTsv } from "../output/tsv.ts"

/** `renderRows`: the shared table/tsv path, columns fallback included. */
const rowText = (
  items: ReadonlyArray<JsonObject>,
  options: RenderOptions,
  format: "table" | "tsv"
): string => {
  const columns = options.columns.length > 0 ? options.columns : fallbackColumns
  const rows = generateRows(items, columns, options.noHeader)
  return format === "table" ? renderTable(rows) : renderTsv(rows)
}

/** The exact bytes `Render` writes for a list result. */
export const renderText = (result: ListResult, options: RenderOptions): string => {
  switch (options.format) {
    case "json":
      return renderJson(result)
    case "jsonl":
      return renderJsonl(result)
    case "table":
    case "tsv":
      return rowText(result.items, options, options.format)
  }
}

/** The exact bytes `RenderObject` writes for a single object. */
export const renderObjectText = (object: JsonObject, options: RenderOptions): string => {
  switch (options.format) {
    case "json":
      return renderObjectJson(object)
    case "jsonl":
      return renderObjectJsonl(object)
    case "table":
    case "tsv":
      return rowText([object], options, options.format)
  }
}

/**
 * Build a Renderer over an arbitrary sink. Exported so tests (and any future
 * non-stdout consumer) can drive the same dispatch without a platform layer.
 */
export const makeRendererWith = (
  write: (text: string) => Effect.Effect<void, OperationalError>
): RendererShape => ({
  render: (result, options) => {
    const text = renderText(result, options)
    return text === "" ? Effect.void : write(text)
  },
  renderObject: (object, options) => {
    const text = renderObjectText(object, options)
    return text === "" ? Effect.void : write(text)
  }
})

/**
 * Renderer over the process's stdout.
 *
 * A write failure (a closed pipe, most plausibly) surfaces as an
 * OperationalError / exit 6. Go would have wrapped it into a UsageError and
 * exited 2, which is an artifact of `renderResult` funnelling every `Render`
 * error — including I/O ones — through the "unsupported format" path. Exit 6 is
 * the documented bucket for I/O failure and is the intentional reading here.
 */
export const makeRenderer: Effect.Effect<RendererShape, never, Stdio.Stdio> = Effect.gen(
  function* () {
    const stdio = yield* Stdio.Stdio
    return makeRendererWith((text) =>
      Stream.run(Stream.make(text), stdio.stdout()).pipe(
        Effect.catch((cause) =>
          Effect.fail(new OperationalError({ message: "could not write output", cause }))
        )
      )
    )
  }
)

export const RendererLive: Layer.Layer<RendererShape, never, Stdio.Stdio> = Layer.effect(
  Renderer,
  makeRenderer
)

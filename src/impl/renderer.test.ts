import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Sink, Stdio } from "effect"
import type { ListResult } from "../domain/listResult.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonObject } from "../json/value.ts"
import { Renderer, type RenderOptions } from "../services/index.ts"
import { statusColumns, versionColumns } from "../output/columns.ts"
import { makeRendererWith, RendererLive, renderObjectText, renderText } from "./renderer.ts"

const obj = (text: string): JsonObject => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as JsonObject
}

const items = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

const listOf = (text: string, nextPageToken = "", requests = 0): ListResult => ({
  items: items(text),
  nextPageToken,
  requests
})

const opts = (
  format: RenderOptions["format"],
  columns: ReadonlyArray<string> = [],
  noHeader = false
): RenderOptions => ({ format, columns, noHeader })

/**
 * Drive the real `RendererLive` through a `Stdio` layer that captures writes,
 * so the service wiring — not just the pure text builders — is under test.
 */
const capture = (
  use: (renderer: {
    readonly render: (r: ListResult, o: RenderOptions) => Effect.Effect<void, unknown>
    readonly renderObject: (o: JsonObject, opt: RenderOptions) => Effect.Effect<void, unknown>
  }) => Effect.Effect<void, unknown>
): Promise<string> => {
  const chunks: Array<string> = []
  const stdio = Stdio.layerTest({
    stdout: () =>
      Sink.forEach((input: string | Uint8Array) =>
        Effect.sync(() => {
          chunks.push(typeof input === "string" ? input : new TextDecoder().decode(input))
        })
      )
  })
  return Effect.gen(function* () {
    const renderer = yield* Renderer
    yield* use(renderer)
    return chunks.join("")
  }).pipe(
    Effect.provide(RendererLive.pipe(Layer.provide(stdio))),
    Effect.runPromise
  )
}

describe("Renderer service over Stdio", () => {
  test("render writes the table to stdout", async () => {
    const out = await capture((r) =>
      r.render(listOf('[{"id":"v","snippet":{"title":"T"}}]'), opts("table", ["id", "snippet.title"]))
    )
    expect(out).toBe("ID  SNIPPET.TITLE\nv   T\n")
  })

  test("render writes the json envelope to stdout", async () => {
    const out = await capture((r) => r.render(listOf('[{"id":"a"}]', "", 2), opts("json")))
    expect(out).toBe('{\n  "items": [\n    {\n      "id": "a"\n    }\n  ],\n  "requests": 2\n}\n')
  })

  test("an empty jsonl result writes NOTHING at all", async () => {
    const out = await capture((r) => r.render(listOf("[]"), opts("jsonl")))
    expect(out).toBe("")
  })

  test("an empty table with --no-header writes nothing", async () => {
    const out = await capture((r) => r.render(listOf("[]"), opts("table", ["id"], true)))
    expect(out).toBe("")
  })

  test("renderObject writes a bare object with no envelope", async () => {
    const out = await capture((r) =>
      r.renderObject(obj('{"videoId":"abc","permitted":true}'), opts("json"))
    )
    expect(out).toBe('{\n  "permitted": true,\n  "videoId": "abc"\n}\n')
  })

  test("renderObject in table format is a single data row", async () => {
    const out = await capture((r) =>
      r.renderObject(obj('{"videoId":"abc","permitted":true}'), opts("table", ["videoId", "permitted"]))
    )
    expect(out).toBe("VIDEOID  PERMITTED\nabc      true\n")
  })

  test("everything is emitted in ONE write (tabwriter flushes once)", async () => {
    const chunks: Array<string> = []
    const stdio = Stdio.layerTest({
      stdout: () =>
        Sink.forEach((input: string | Uint8Array) =>
          Effect.sync(() => {
            chunks.push(typeof input === "string" ? input : new TextDecoder().decode(input))
          })
        )
    })
    await Effect.gen(function* () {
      const renderer = yield* Renderer
      yield* renderer.render(
        listOf('[{"id":"a"},{"id":"b"},{"id":"c"}]'),
        opts("table", ["id", "snippet.title"])
      )
    }).pipe(Effect.provide(RendererLive.pipe(Layer.provide(stdio))), Effect.runPromise)
    expect(chunks.length).toBe(1)
  })
})

describe("makeRendererWith — write failures propagate", () => {
  test("a failing sink surfaces the error rather than being swallowed", async () => {
    const boom = new Error("closed pipe")
    const renderer = makeRendererWith(() => Effect.fail(boom as never))
    const exit = await Effect.runPromiseExit(
      renderer.render(listOf('[{"id":"a"}]'), opts("json"))
    )
    expect(exit._tag).toBe("Failure")
  })

  test("no write is attempted when there is nothing to emit", async () => {
    let calls = 0
    const renderer = makeRendererWith(() => {
      calls++
      return Effect.void
    })
    await Effect.runPromise(renderer.render(listOf("[]"), opts("jsonl")))
    expect(calls).toBe(0)
  })

  test("exactly one write for a non-empty render", async () => {
    let calls = 0
    const renderer = makeRendererWith(() => {
      calls++
      return Effect.void
    })
    await Effect.runPromise(renderer.render(listOf('[{"id":"a"}]'), opts("jsonl")))
    expect(calls).toBe(1)
  })
})

describe("renderText dispatch", () => {
  test.each([
    ["json", '{\n  "items": [\n    {\n      "id": "a"\n    }\n  ],\n  "requests": 0\n}\n'],
    ["jsonl", '{"id":"a"}\n'],
    ["table", "ID\na\n"],
    ["tsv", "ID\na\n"]
  ] as const)("%s", (format, want) => {
    expect(renderText(listOf('[{"id":"a"}]'), opts(format, ["id"]))).toBe(want)
  })

  test("table and tsv fall back to id,snippet.title when no columns are given", () => {
    expect(renderText(listOf('[{"id":"v","snippet":{"title":"T"}}]'), opts("table"))).toBe(
      "ID  SNIPPET.TITLE\nv   T\n"
    )
    expect(renderText(listOf('[{"id":"v","snippet":{"title":"T"}}]'), opts("tsv"))).toBe(
      "ID\tSNIPPET.TITLE\nv\tT\n"
    )
  })

  test("json and jsonl ignore --columns entirely", () => {
    const withCols = renderText(listOf('[{"id":"a","x":"b"}]'), opts("json", ["id"]))
    const without = renderText(listOf('[{"id":"a","x":"b"}]'), opts("json"))
    expect(withCols).toBe(without)
    expect(withCols).toContain('"x": "b"')
  })

  test("json and jsonl ignore --no-header entirely", () => {
    expect(renderText(listOf('[{"id":"a"}]'), opts("jsonl", [], true))).toBe(
      renderText(listOf('[{"id":"a"}]'), opts("jsonl", [], false))
    )
  })
})

describe("renderObjectText dispatch", () => {
  test("the version payload matches the Go binary", () => {
    const state = obj(
      '{"version":"v0.3.3","commit":"699879f7","date":"2026-07-25T05:47:34Z","goVersion":"go1.26.5","os":"darwin","arch":"arm64"}'
    )
    expect(renderObjectText(state, opts("json", versionColumns))).toBe(
      '{\n  "arch": "arm64",\n  "commit": "699879f7",\n  "date": "2026-07-25T05:47:34Z",\n  "goVersion": "go1.26.5",\n  "os": "darwin",\n  "version": "v0.3.3"\n}\n'
    )
    expect(renderObjectText(state, opts("tsv", versionColumns))).toBe(
      "VERSION\tCOMMIT\tDATE\tGOVERSION\tOS\tARCH\n" +
        "v0.3.3\t699879f7\t2026-07-25T05:47:34Z\tgo1.26.5\tdarwin\tarm64\n"
    )
  })

  test("the status payload matches the Go binary", () => {
    // Captured from `OYTC_CONFIG_DIR=/tmp/p3-cfg oytc status --format tsv` with
    // no credentials present: absent keys render as empty cells.
    const state = obj(
      '{"api_key":{"configured":false,"source":"none"},"oauth":{"configured":false},"path":"/tmp/p3-cfg/auth.json"}'
    )
    expect(renderObjectText(state, opts("tsv", statusColumns))).toBe(
      "PATH\tAPI_KEY.CONFIGURED\tAPI_KEY.SOURCE\tAPI_KEY.FINGERPRINT\tOAUTH.CONFIGURED\tOAUTH.CLIENT_ID\tOAUTH.SCOPES\tOAUTH.EXPIRY\n" +
        "/tmp/p3-cfg/auth.json\tfalse\tnone\t\tfalse\t\t\t\n"
    )
  })

  test("renderObject in table/tsv falls back to id,snippet.title without columns", () => {
    expect(renderObjectText(obj('{"version":"1.2.3","id":"x"}'), opts("tsv"))).toBe(
      "ID\tSNIPPET.TITLE\nx\t\n"
    )
  })
})

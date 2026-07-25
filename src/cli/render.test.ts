import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Sink, Stdio } from "effect"
import type { ListResult } from "../domain/listResult.ts"
import { parseJson } from "../json/parse.ts"
import type { JsonObject } from "../json/value.ts"
import { RendererLive } from "../impl/renderer.ts"
import { AppOptions } from "../services/index.ts"
import type { AppOptionsShape, OutputFormat } from "../services/index.ts"
import { searchColumns, videoTrainabilityColumns } from "../output/columns.ts"
import { renderObject, renderOptionsFor, renderResult, summaryText } from "./render.ts"

const items = (text: string): ReadonlyArray<JsonObject> => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as ReadonlyArray<JsonObject>
}

const obj = (text: string): JsonObject => {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
  return parsed.success as JsonObject
}

const listOf = (text: string, requests = 1, nextPageToken = ""): ListResult => ({
  items: items(text),
  nextPageToken,
  requests
})

const options = (over: Partial<AppOptionsShape> = {}): AppOptionsShape => ({
  format: "table" as OutputFormat,
  columns: [],
  noHeader: false,
  quiet: false,
  timeoutMillis: 20_000,
  isOutputTTY: true,
  ...over
})

interface Captured {
  readonly stdout: string
  readonly stderr: string
}

/** Drive a render effect through the real Renderer over a capturing Stdio. */
const capture = (
  effect: Effect.Effect<void, unknown, never>,
  appOptions: AppOptionsShape
): Promise<Captured> => {
  const out: Array<string> = []
  const err: Array<string> = []
  const decode = (input: string | Uint8Array): string =>
    typeof input === "string" ? input : new TextDecoder().decode(input)

  const stdio = Stdio.layerTest({
    stdout: () => Sink.forEach((input: string | Uint8Array) => Effect.sync(() => out.push(decode(input)))),
    stderr: () => Sink.forEach((input: string | Uint8Array) => Effect.sync(() => err.push(decode(input))))
  })

  const layer = Layer.mergeAll(
    stdio,
    Layer.succeed(AppOptions, appOptions),
    RendererLive.pipe(Layer.provide(stdio))
  )

  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>
  ).then(() => ({ stdout: out.join(""), stderr: err.join("") }))
}

const renderList = (
  result: ListResult,
  defaults: ReadonlyArray<string>,
  appOptions: AppOptionsShape
): Promise<Captured> =>
  capture(renderResult(result, defaults) as Effect.Effect<void, unknown, never>, appOptions)

describe("summaryText", () => {
  test("the base form", () => {
    expect(summaryText(listOf('[{"id":"a"},{"id":"b"}]', 3))).toBe("2 item(s), 3 request(s)\n")
  })

  test("zero items and zero requests still render", () => {
    expect(summaryText({ items: [], nextPageToken: "", requests: 0 })).toBe(
      "0 item(s), 0 request(s)\n"
    )
  })

  test("a next page token appends the resume hint, unquoted", () => {
    expect(summaryText(listOf('[{"id":"a"}]', 1, "CAUQAA"))).toBe(
      "1 item(s), 1 request(s); more available (next token: CAUQAA)\n"
    )
  })

  test("singular counts are NOT pluralised away — Go always says item(s)", () => {
    expect(summaryText(listOf('[{"id":"a"}]', 1))).toBe("1 item(s), 1 request(s)\n")
  })
})

describe("renderOptionsFor — column resolution", () => {
  test("--columns wins over the command defaults", () => {
    expect(renderOptionsFor(options({ columns: ["id", "x.y"] }), searchColumns).columns).toEqual([
      "id",
      "x.y"
    ])
  })

  test("the command defaults are used when --columns is absent", () => {
    expect(renderOptionsFor(options(), searchColumns).columns).toEqual(searchColumns)
  })

  test("with neither, the global fallback applies", () => {
    expect(renderOptionsFor(options(), []).columns).toEqual(["id", "snippet.title"])
  })

  test("format and noHeader pass straight through", () => {
    const resolved = renderOptionsFor(options({ format: "tsv", noHeader: true }), searchColumns)
    expect(resolved.format).toBe("tsv")
    expect(resolved.noHeader).toBe(true)
  })

  test("column ORDER is preserved, never sorted (G4)", () => {
    expect(renderOptionsFor(options({ columns: ["z", "a", "m"] }), []).columns).toEqual([
      "z",
      "a",
      "m"
    ])
  })
})

describe("renderResult — the stderr summary line", () => {
  const result = listOf('[{"id":"a","snippet":{"title":"T"}}]', 2)
  const columns = ["id", "snippet.title"]

  test("table format emits the summary", async () => {
    const captured = await renderList(result, columns, options())
    expect(captured.stderr).toBe("1 item(s), 2 request(s)\n")
    expect(captured.stdout).toContain("ID")
  })

  test("--quiet suppresses it, leaving stdout untouched", async () => {
    const captured = await renderList(result, columns, options({ quiet: true }))
    expect(captured.stderr).toBe("")
    expect(captured.stdout).toContain("ID")
  })

  test("json format never emits it, even without --quiet", async () => {
    const captured = await renderList(result, columns, options({ format: "json" }))
    expect(captured.stderr).toBe("")
  })

  test("jsonl format never emits it", async () => {
    const captured = await renderList(result, columns, options({ format: "jsonl" }))
    expect(captured.stderr).toBe("")
  })

  test("tsv format never emits it — table only", async () => {
    const captured = await renderList(result, columns, options({ format: "tsv" }))
    expect(captured.stderr).toBe("")
  })

  test("the resume hint reaches stderr", async () => {
    const captured = await renderList(
      listOf('[{"id":"a"}]', 1, "TOKEN"),
      columns,
      options()
    )
    expect(captured.stderr).toBe("1 item(s), 1 request(s); more available (next token: TOKEN)\n")
  })

  test("an empty result still renders the header and the summary", async () => {
    const captured = await renderList(
      { items: [], nextPageToken: "", requests: 1 },
      columns,
      options()
    )
    expect(captured.stderr).toBe("0 item(s), 1 request(s)\n")
    expect(captured.stdout).toContain("ID")
  })
})

describe("renderResult — stdout content per format", () => {
  const result = listOf('[{"id":"a","snippet":{"title":"T"}}]', 1)

  test("json emits the full envelope with requests", async () => {
    const captured = await renderList(result, ["id"], options({ format: "json" }))
    expect(captured.stdout).toBe(
      ['{', '  "items": [', '    {', '      "id": "a",', '      "snippet": {', '        "title": "T"', '      }', '    }', '  ],', '  "requests": 1', '}', ''].join("\n")
    )
  })

  test("jsonl emits one compact line per item and no envelope", async () => {
    const captured = await renderList(result, ["id"], options({ format: "jsonl" }))
    expect(captured.stdout).toBe('{"id":"a","snippet":{"title":"T"}}\n')
  })

  test("jsonl of an empty result emits ZERO bytes, not a blank line", async () => {
    const captured = await renderList(
      { items: [], nextPageToken: "", requests: 1 },
      ["id"],
      options({ format: "jsonl" })
    )
    expect(captured.stdout).toBe("")
  })

  test("tsv uses declaration order for headers (G4)", async () => {
    const captured = await renderList(
      result,
      ["snippet.title", "id"],
      options({ format: "tsv" })
    )
    expect(captured.stdout).toBe("SNIPPET.TITLE\tID\nT\ta\n")
  })

  test("--no-header drops the header row", async () => {
    const captured = await renderList(
      result,
      ["id"],
      options({ format: "tsv", noHeader: true })
    )
    expect(captured.stdout).toBe("a\n")
  })

  test("G1: a list-result array cell is comma-joined, no brackets or quotes", async () => {
    const captured = await renderList(
      listOf('[{"tags":["a","b"]}]'),
      ["tags"],
      options({ format: "tsv" })
    )
    expect(captured.stdout).toBe("TAGS\na,b\n")
  })
})

describe("renderObject", () => {
  const trainability = obj('{"videoId":"abc","permitted":false}')

  test("no summary line is emitted, even on table format", async () => {
    const captured = await capture(
      renderObject(trainability, videoTrainabilityColumns) as Effect.Effect<void, unknown, never>,
      options()
    )
    expect(captured.stderr).toBe("")
    expect(captured.stdout).toContain("VIDEOID")
    expect(captured.stdout).toContain("PERMITTED")
  })

  test("json emits a bare object with SORTED keys (G4)", async () => {
    const captured = await capture(
      renderObject(trainability, videoTrainabilityColumns) as Effect.Effect<void, unknown, never>,
      options({ format: "json" })
    )
    expect(captured.stdout).toBe('{\n  "permitted": false,\n  "videoId": "abc"\n}\n')
  })

  test("tsv keeps the caller's column order (G4)", async () => {
    const captured = await capture(
      renderObject(trainability, videoTrainabilityColumns) as Effect.Effect<void, unknown, never>,
      options({ format: "tsv" })
    )
    expect(captured.stdout).toBe("VIDEOID\tPERMITTED\nabc\tfalse\n")
  })

  test("--columns overrides the command defaults", async () => {
    const captured = await capture(
      renderObject(trainability, videoTrainabilityColumns) as Effect.Effect<void, unknown, never>,
      options({ format: "tsv", columns: ["permitted"] })
    )
    expect(captured.stdout).toBe("PERMITTED\nfalse\n")
  })

  test("a missing column renders as an empty cell", async () => {
    const captured = await capture(
      renderObject(trainability, []) as Effect.Effect<void, unknown, never>,
      options({ format: "tsv", columns: ["nope"] })
    )
    expect(captured.stdout).toBe("NOPE\n\n")
  })
})

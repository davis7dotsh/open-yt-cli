/**
 * `oytc category list`, `oytc language list`, `oytc region list`.
 *
 * The defining property of these three: they take the metadata flags
 * (`--parts`, `--fields`, `--hl`) but **no pagination flags at all**, and they
 * send no `maxResults`. `/tmp/oytc-ref language list --page-size 5` answers
 * `unknown flag: --page-size`, exit 2.
 */

import { describe, expect, test } from "bun:test"
import { categoryCommand, catalogCommands, languageCommand, regionCommand } from "./catalog.ts"
import { expectUsage, listOf, runCli } from "./harness.testutil.ts"

const runCategory = (argv: ReadonlyArray<string>, options?: Parameters<typeof runCli>[2]) =>
  runCli(categoryCommand, argv, options)
const runLanguage = (argv: ReadonlyArray<string>, options?: Parameters<typeof runCli>[2]) =>
  runCli(languageCommand, argv, options)
const runRegion = (argv: ReadonlyArray<string>, options?: Parameters<typeof runCli>[2]) =>
  runCli(regionCommand, argv, options)

/** Go's zero-valued `listFlags{}`: no maxResults, no pageToken, one request. */
const ZERO_PAGE = { all: false, limit: 0, pageSize: 0, pageToken: "" }

// ---------------------------------------------------------------------------
// category list
// ---------------------------------------------------------------------------

describe("category list", () => {
  test("takes no positional arguments", async () => {
    expectUsage(await runCategory(["category", "list", "extra"]), "expected 0 argument(s), received 1")
  })

  test("requires exactly one of --region or --id", async () => {
    expectUsage(await runCategory(["category", "list"]), "provide exactly one of --region or --id")
    expectUsage(
      await runCategory(["category", "list", "--region", "US", "--id", "1"]),
      "provide exactly one of --region or --id"
    )
  })

  test("no request is made when validation fails", async () => {
    const result = await runCategory(["category", "list"])
    expect(result.calls).toEqual([])
    expect(result.exitCode).toBe(2)
  })

  test("--region maps to regionCode", async () => {
    const result = await runCategory(["category", "list", "--region", "US"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.resource).toBe("videoCategories")
    expect(result.calls[0]!.params).toEqual({ part: "snippet", regionCode: "US" })
  })

  test("--id maps to id", async () => {
    const result = await runCategory(["category", "list", "--id", "1,2"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params).toEqual({ part: "snippet", id: "1,2" })
  })

  test("--hl, --parts and --fields are forwarded", async () => {
    const result = await runCategory(
      ["category", "list", "--region", "US", "--hl", "es", "--parts", "id", "--fields", "items"],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.params).toEqual({
      part: "id",
      regionCode: "US",
      hl: "es",
      fields: "items"
    })
  })

  test("SENDS NO maxResults and never follows pages", async () => {
    const result = await runCategory(["category", "list", "--region", "US"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.page).toEqual(ZERO_PAGE)
  })

  test("has no pagination flags", async () => {
    for (const flag of [
      ["--page-size", "5"],
      ["--page-token", "T"],
      ["--all"],
      ["--limit", "5"]
    ]) {
      const result = await runCategory(["category", "list", "--region", "US", ...flag])
      expect(result.exitCode).toBe(2)
      expect(result.calls).toEqual([])
    }
  })

  test("renders the category default columns", async () => {
    const result = await runCategory(["category", "list", "--region", "US"], {
      script: { list: [listOf(`[{"id":"1","snippet":{"title":"Film","assignable":true}}]`)] }
    })
    // Byte-for-byte against `output.Render(..., Format: "table")` in Go.
    expect(result.stdout).toBe("ID  SNIPPET.TITLE  SNIPPET.ASSIGNABLE\n1   Film           true\n")
  })

  test("the stderr summary reflects the single request", async () => {
    const result = await runCategory(["category", "list", "--region", "US"], {
      script: { list: [listOf(`[{"id":"1"},{"id":"2"}]`, 1)] }
    })
    expect(result.stderr).toBe("2 item(s), 1 request(s)\n")
  })
})

describe("the category group", () => {
  test("bare `oytc category` prints help and exits 0", async () => {
    const result = await runCategory(["category"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// language list
// ---------------------------------------------------------------------------

describe("language list", () => {
  test("takes no positional arguments", async () => {
    expectUsage(await runLanguage(["language", "list", "extra"]), "expected 0 argument(s), received 1")
  })

  test("needs no filter flags at all", async () => {
    const result = await runLanguage(["language", "list"], { script: { list: [listOf("[]")] } })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.resource).toBe("i18nLanguages")
    expect(result.calls[0]!.params).toEqual({ part: "snippet" })
    expect(result.calls[0]!.page).toEqual(ZERO_PAGE)
  })

  test("--hl, --parts and --fields are forwarded", async () => {
    const result = await runLanguage(
      ["language", "list", "--hl", "ja", "--parts", "id", "--fields", "items/id"],
      { script: { list: [listOf("[]")] } }
    )
    expect(result.calls[0]!.params).toEqual({ part: "id", hl: "ja", fields: "items/id" })
  })

  test("has no --region flag", async () => {
    const result = await runLanguage(["language", "list", "--region", "US"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("has no pagination flags", async () => {
    const result = await runLanguage(["language", "list", "--page-size", "5"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("renders the language default columns", async () => {
    const result = await runLanguage(["language", "list"], {
      script: { list: [listOf(`[{"id":"en","snippet":{"name":"English"}}]`)] }
    })
    expect(result.stdout).toBe("ID  SNIPPET.NAME\nen  English\n")
  })
})

describe("the language group", () => {
  test("bare `oytc language` prints help and exits 0", async () => {
    const result = await runLanguage(["language"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// region list
// ---------------------------------------------------------------------------

describe("region list", () => {
  test("takes no positional arguments", async () => {
    expectUsage(await runRegion(["region", "list", "extra"]), "expected 0 argument(s), received 1")
  })

  test("hits i18nRegions with the default part and no pagination", async () => {
    const result = await runRegion(["region", "list"], { script: { list: [listOf("[]")] } })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.resource).toBe("i18nRegions")
    expect(result.calls[0]!.params).toEqual({ part: "snippet" })
    expect(result.calls[0]!.page).toEqual(ZERO_PAGE)
  })

  test("--hl is forwarded", async () => {
    const result = await runRegion(["region", "list", "--hl", "pt"], {
      script: { list: [listOf("[]")] }
    })
    expect(result.calls[0]!.params).toEqual({ part: "snippet", hl: "pt" })
  })

  test("has no pagination flags", async () => {
    const result = await runRegion(["region", "list", "--all"])
    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
  })

  test("renders the region default columns, including snippet.glName", async () => {
    const result = await runRegion(["region", "list"], {
      script: { list: [listOf(`[{"id":"US","snippet":{"name":"United States","glName":"US"}}]`)] }
    })
    // Byte-for-byte against `output.Render(..., Format: "table")` in Go.
    expect(result.stdout).toBe("ID  SNIPPET.NAME   SNIPPET.GLNAME\nUS  United States  US\n")
  })

  test("--format json emits the list envelope", async () => {
    const result = await runRegion(["region", "list", "--format", "json"], {
      script: { list: [listOf(`[{"id":"US"}]`, 1)] }
    })
    expect(result.stdout).toContain('"items"')
    expect(result.stdout).toContain('"requests": 1')
    expect(result.stderr).toBe("")
  })
})

describe("the region group", () => {
  test("bare `oytc region` prints help and exits 0", async () => {
    const result = await runRegion(["region"])
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// registration surface
// ---------------------------------------------------------------------------

describe("catalogCommands", () => {
  test("exports the three groups in Go's registration order", () => {
    expect(catalogCommands).toHaveLength(3)
    expect(catalogCommands[0]).toBe(categoryCommand)
    expect(catalogCommands[1]).toBe(languageCommand)
    expect(catalogCommands[2]).toBe(regionCommand)
  })
})

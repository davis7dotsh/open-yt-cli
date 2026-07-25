/**
 * `login` / `status` / `logout` tests.
 *
 * The centrepiece is the redaction contract (DEVIATIONS.md G2). Those tests
 * are written as ABSENCE assertions over distinctive fixture values rather
 * than presence assertions over the allowed fields: a future refactor that
 * accidentally spreads the whole credential record into the state object would
 * still satisfy "path and fingerprint are present", but it would fail here.
 *
 * `status` is additionally compared against `/tmp/goldens/status.txt`, captured
 * from the real Go binary, when that file is available.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Redacted, Result, Sink, Stdio } from "effect"
import { Command } from "../effect.ts"
import {
  ApiError,
  MissingKeyError,
  OperationalError,
  UsageError,
  type OytcError
} from "../domain/errors.ts"
import type { AnalyticsResponse } from "../schema/analytics.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import { makeRendererWith } from "../impl/renderer.ts"
import { statusCheckColumns, statusColumns } from "../output/columns.ts"
import {
  AnalyticsApi,
  AppOptions,
  CredentialStore,
  OAuthService,
  Prompts,
  Renderer,
  YouTubeApi,
  type AppOptionsShape,
  type Credentials,
  type CredentialSource,
  type OutputFormat,
  type Params,
  type StoredOAuth
} from "../services/index.ts"
import {
  authCommands,
  checkVerdict,
  encodeScopes,
  loginCommand,
  logoutCommand,
  oauthAuthHint,
  statusCommand,
  statusState,
  statusTableText,
  valueOr
} from "./auth.ts"

// ---------------------------------------------------------------------------
// Fixtures — every secret carries a distinctive, greppable value
// ---------------------------------------------------------------------------

const SECRET_CLIENT_SECRET = "GOCSPX-supersecret-do-not-print"
const SECRET_ACCESS_TOKEN = "ya29.SECRET-ACCESS-TOKEN"
const SECRET_REFRESH_TOKEN = "1//SECRET-REFRESH-TOKEN"
const SECRET_API_KEY = "AIzaSyTESTKEY1234567890abcdefghijklmnop"

/** Every value that must NEVER appear in `status` output, in any format. */
const FORBIDDEN = [
  SECRET_CLIENT_SECRET,
  SECRET_ACCESS_TOKEN,
  SECRET_REFRESH_TOKEN,
  SECRET_API_KEY
] as const

const storedOAuth: StoredOAuth = {
  clientId: "1234-test.apps.googleusercontent.com",
  clientSecret: SECRET_CLIENT_SECRET,
  accessToken: SECRET_ACCESS_TOKEN,
  refreshToken: SECRET_REFRESH_TOKEN,
  expiry: "2027-01-01T00:00:00Z",
  scopes: ["https://www.googleapis.com/auth/youtube.readonly"]
}

const GOLDEN_PATH = "/tmp/goldens/fakeconf/auth.json"
/** The fingerprint the Go binary printed for the golden fixture's key. */
const GOLDEN_FINGERPRINT = "sha256:50793a5e591b"

const credentials = (overrides?: Partial<Credentials>): Credentials => ({
  key: SECRET_API_KEY,
  source: "auth.json" as CredentialSource,
  oauth: storedOAuth,
  path: GOLDEN_PATH,
  ...overrides
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Captured {
  readonly stdout: string
  readonly stderr: string
  readonly exit: Exit.Exit<void, OytcError>
}

interface HarnessOptions {
  readonly credentials?: Credentials | undefined
  readonly loadError?: OperationalError | undefined
  readonly format?: OutputFormat | undefined
  readonly columns?: ReadonlyArray<string> | undefined
  readonly noHeader?: boolean | undefined
  readonly quiet?: boolean | undefined
  /** `undefined` = the API-key probe succeeds. */
  readonly keyProbeError?: OytcError | undefined
  readonly oauthProbeError?: OytcError | undefined
  readonly promptLines?: ReadonlyArray<string> | undefined
  readonly envKeySet?: boolean | undefined
  readonly bootstrap?: readonly [string, string] | undefined
  readonly removed?: boolean | undefined
  readonly loginResult?: StoredOAuth | undefined
  readonly loginError?: OytcError | undefined
}

interface Recorder {
  readonly saved: Array<string>
  readonly savedOAuth: Array<StoredOAuth>
  readonly revoked: Array<StoredOAuth>
  readonly getCalls: Array<readonly [string, Params]>
  readonly reportCalls: Array<unknown>
  readonly prompts: Array<string>
  removedCalled: boolean
}

const emptyResponse: DataApiResponse = { items: [] }
const emptyReport: AnalyticsResponse = { columnHeaders: [], rows: [] }

const appOptions = (options: HarnessOptions): AppOptionsShape => ({
  format: options.format ?? "table",
  columns: options.columns ?? [],
  noHeader: options.noHeader ?? false,
  quiet: options.quiet ?? false,
  timeoutMillis: 20_000,
  isOutputTTY: false
})

const run = async (
  argv: ReadonlyArray<string>,
  options: HarnessOptions = {}
): Promise<Captured & { readonly recorder: Recorder }> => {
  const out: Array<string> = []
  const err: Array<string> = []
  const recorder: Recorder = {
    saved: [],
    savedOAuth: [],
    revoked: [],
    getCalls: [],
    reportCalls: [],
    prompts: [],
    removedCalled: false
  }
  const creds = options.credentials ?? credentials()
  let promptIndex = 0
  const nextLine = (): string => options.promptLines?.[promptIndex++] ?? ""

  const decode = (input: string | Uint8Array): string =>
    typeof input === "string" ? input : new TextDecoder().decode(input)

  const stdio = Stdio.layerTest({
    stdout: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => out.push(decode(i)))),
    stderr: () => Sink.forEach((i: string | Uint8Array) => Effect.sync(() => err.push(decode(i))))
  })

  const layers = Layer.mergeAll(
    Layer.succeed(AppOptions, appOptions(options)),
    Layer.succeed(CredentialStore, {
      dir: Effect.succeed("/tmp/goldens/fakeconf"),
      path: Effect.succeed(creds.path),
      load:
        options.loadError === undefined
          ? Effect.succeed(creds)
          : Effect.fail(options.loadError),
      save: (key: string) =>
        Effect.sync(() => {
          recorder.saved.push(key)
          return creds.path
        }),
      saveOAuth: (stored: StoredOAuth) =>
        Effect.sync(() => {
          recorder.savedOAuth.push(stored)
          return creds.path
        }),
      saveRefreshedOAuth: () => Effect.succeed(true),
      clearOAuth: Effect.succeed(creds.path),
      remove: Effect.sync(() => {
        recorder.removedCalled = true
        return { path: creds.path, removed: options.removed ?? true }
      }),
      fingerprint: () => GOLDEN_FINGERPRINT,
      envKeySet: Effect.succeed(options.envKeySet ?? false),
      oauthBootstrap: Effect.succeed(options.bootstrap ?? (["", ""] as const))
    }),
    Layer.succeed(YouTubeApi, {
      get: (resource: string, params: Params) =>
        Effect.suspend(() => {
          recorder.getCalls.push([resource, params])
          return options.keyProbeError === undefined
            ? Effect.succeed(emptyResponse)
            : Effect.fail(options.keyProbeError)
        }),
      list: () => Effect.succeed({ items: [], nextPageToken: "", requests: 0 }),
      resolveChannel: () => Effect.succeed({ id: "", requests: 0 })
    }),
    Layer.succeed(AnalyticsApi, {
      report: (query: unknown) =>
        Effect.suspend(() => {
          recorder.reportCalls.push(query)
          return options.oauthProbeError === undefined
            ? Effect.succeed(emptyReport)
            : Effect.fail(options.oauthProbeError)
        }),
      normalize: () => []
    }),
    Layer.succeed(OAuthService, {
      login: () =>
        options.loginError === undefined
          ? Effect.succeed(options.loginResult ?? storedOAuth)
          : Effect.fail(options.loginError as never),
      refresh: () => Effect.succeed(storedOAuth),
      revoke: (stored: StoredOAuth) =>
        Effect.sync(() => {
          recorder.revoked.push(stored)
        }),
      tokenSource: () => Effect.succeed(Redacted.make("token"))
    }),
    Layer.succeed(Prompts, {
      readLine: (prompt: string) =>
        Effect.sync(() => {
          recorder.prompts.push(prompt)
          err.push(prompt)
          return nextLine()
        }),
      readSecret: (prompt: string) =>
        Effect.sync(() => {
          recorder.prompts.push(prompt)
          err.push(prompt)
          const line = nextLine()
          err.push("\n")
          return Redacted.make(line)
        }),
      confirm: () => Effect.succeed(true)
    }),
    Layer.effect(
      Renderer,
      Effect.gen(function* () {
        const service = yield* Stdio.Stdio
        return makeRendererWith((text) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => out.push(text))
            void service
          })
        )
      })
    ).pipe(Layer.provide(stdio))
  )

  const root = Command.make("oytc").pipe(Command.withSubcommands([...authCommands]))
  const exit = await Effect.runPromiseExit(
    Command.runWith(root, { version: "test" })(argv).pipe(
      Effect.provide(Layer.mergeAll(layers, stdio))
    ) as Effect.Effect<void, OytcError>
  )

  return { stdout: out.join(""), stderr: err.join(""), exit, recorder }
}

const errorOf = (exit: Exit.Exit<void, OytcError>): OytcError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const found = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (found === undefined) throw new Error(`no Fail reason: ${String(exit.cause)}`)
  return (found as { readonly error: OytcError }).error
}

// ---------------------------------------------------------------------------
// The redaction contract — G2
// ---------------------------------------------------------------------------

describe("status never leaks a secret (DEVIATIONS.md G2)", () => {
  const formats: ReadonlyArray<OutputFormat> = ["table", "json", "jsonl", "tsv"]

  for (const format of formats) {
    test(`--format ${format} omits every secret`, async () => {
      const { stdout, exit } = await run(["status", "--format-ignored"].slice(0, 1), { format })
      expect(Exit.isSuccess(exit)).toBe(true)
      for (const secret of FORBIDDEN) expect(stdout).not.toContain(secret)
      // …and the allowed values ARE there, so the test cannot pass vacuously.
      expect(stdout).toContain(GOLDEN_FINGERPRINT)
      expect(stdout).toContain(storedOAuth.clientId)
    })

    test(`--check --format ${format} omits every secret`, async () => {
      const { stdout, exit } = await run(["status", "--check"], { format })
      expect(Exit.isSuccess(exit)).toBe(true)
      for (const secret of FORBIDDEN) expect(stdout).not.toContain(secret)
      expect(stdout).toContain(GOLDEN_FINGERPRINT)
    })
  }

  test("the state object's key set is exactly the allowed one", () => {
    const state = statusState(credentials(), { key: undefined, oauth: undefined }, false)
    expect(Object.keys(state).sort()).toEqual(["api_key", "oauth", "path"])
    expect(Object.keys(state["api_key"] as object).sort()).toEqual([
      "configured",
      "fingerprint",
      "source"
    ])
    expect(Object.keys(state["oauth"] as object).sort()).toEqual([
      "client_id",
      "configured",
      "expiry",
      "scopes"
    ])
  })

  test("--check adds exactly `valid` to each block and nothing else", () => {
    const state = statusState(credentials(), { key: null, oauth: null }, false)
    expect(Object.keys(state["api_key"] as object).sort()).toEqual([
      "configured",
      "fingerprint",
      "source",
      "valid"
    ])
    expect(Object.keys(state["oauth"] as object).sort()).toEqual([
      "client_id",
      "configured",
      "expiry",
      "scopes",
      "valid"
    ])
  })

  test("a serialized state object contains no secret substring", () => {
    const state = statusState(credentials(), { key: null, oauth: null }, true)
    const serialized = [state]
      .flatMap((s) => Object.values(s))
      .flatMap((v) => (typeof v === "object" && v !== null ? Object.values(v) : [v]))
      .map(String)
      .join("|")
    for (const secret of FORBIDDEN) expect(serialized).not.toContain(secret)
  })
})

// ---------------------------------------------------------------------------
// G1 — scopes bracket rendering
// ---------------------------------------------------------------------------

describe("G1: status scopes render with brackets in row formats", () => {
  test("tsv pre-encodes the scopes array as JSON text", () => {
    expect(encodeScopes(["https://a/x"], true)).toBe('["https://a/x"]')
    expect(encodeScopes(["https://a/x", "https://b/y"], true)).toBe(
      '["https://a/x","https://b/y"]'
    )
  })

  test("json keeps a real array", () => {
    expect(encodeScopes(["https://a/x"], false)).toEqual(["https://a/x"])
  })

  test("an empty scope list is the literal null in row formats", () => {
    // Go marshalled a nil []string as `null`; credentialStore normalizes nil
    // to [], so the empty case is the one that must map back to null.
    expect(encodeScopes([], true)).toBe("null")
    expect(encodeScopes([], false)).toBeNull()
  })

  test("the tsv row carries the bracketed form end to end", async () => {
    const { stdout } = await run(["status"], { format: "tsv" })
    expect(stdout).toContain('["https://www.googleapis.com/auth/youtube.readonly"]')
    // NOT the comma-joined form cell() would otherwise produce.
    expect(stdout.split("\n")[1]).not.toMatch(/\thttps:\/\/www\.googleapis[^"]*\t/)
  })

  test("the TABLE rendering joins with ', ' — a different Go code path", () => {
    const text = statusTableText(
      credentials({ oauth: { ...storedOAuth, scopes: ["https://a/x", "https://b/y"] } }),
      { key: undefined, oauth: undefined }
    )
    expect(text).toContain("OAuth scopes: https://a/x, https://b/y")
    expect(text).not.toContain("[")
  })
})

// ---------------------------------------------------------------------------
// Golden comparison
// ---------------------------------------------------------------------------

describe("status matches the Go binary's golden output", () => {
  const golden = (() => {
    try {
      // The goldens are an external artifact; skip cleanly when absent.
      return require("node:fs").readFileSync("/tmp/goldens/status.txt", "utf8") as string
    } catch {
      return undefined
    }
  })()

  const section = (format: string): string | undefined => {
    if (golden === undefined) return undefined
    const marker = `=== status --format ${format}\n`
    const start = golden.indexOf(marker)
    if (start < 0) return undefined
    const from = start + marker.length
    const next = golden.indexOf("=== status --format", from)
    return next < 0 ? golden.slice(from) : golden.slice(from, next)
  }

  for (const format of ["table", "json", "jsonl", "tsv"] as const) {
    test(`--format ${format}`, async () => {
      const expected = section(format)
      if (expected === undefined) return
      const { stdout } = await run(["status"], { format })
      expect(stdout).toBe(expected)
    })
  }
})

// ---------------------------------------------------------------------------
// status behaviour
// ---------------------------------------------------------------------------

describe("status", () => {
  test("without --check it performs no network call at all", async () => {
    const { recorder, exit } = await run(["status"], { format: "json" })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(recorder.getCalls).toEqual([])
    expect(recorder.reportCalls).toEqual([])
  })

  test("--check probes the API key with the quota-1 i18nLanguages call", async () => {
    const { recorder } = await run(["status", "--check"], { format: "json" })
    expect(recorder.getCalls).toEqual([["i18nLanguages", [["part", "snippet"]]]])
  })

  test("--check probes OAuth against Analytics with views/limit 1", async () => {
    const { recorder } = await run(["status", "--check"], { format: "json" })
    expect(recorder.reportCalls).toHaveLength(1)
    const query = recorder.reportCalls[0] as { metrics: string; limit: number }
    expect(query.metrics).toBe("views")
    expect(query.limit).toBe(1)
  })

  test("both credentials are validated even when the key fails first", async () => {
    const { recorder } = await run(["status", "--check"], {
      format: "json",
      keyProbeError: new ApiError({
        httpStatus: 400,
        code: 400,
        apiMessage: "API key not valid",
        reasons: ["badRequest"]
      })
    })
    // The OAuth probe still ran — a stale key must not mask a working grant.
    expect(recorder.reportCalls).toHaveLength(1)
  })

  test("--check writes the full state BEFORE failing", async () => {
    const keyError = new ApiError({
      httpStatus: 400,
      code: 400,
      apiMessage: "API key not valid. Please pass a valid API key.",
      reasons: ["badRequest", "API_KEY_INVALID"]
    })
    const { stdout, exit } = await run(["status", "--check"], {
      format: "json",
      keyProbeError: keyError
    })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(errorOf(exit)).toBe(keyError)
    expect(stdout).toContain('"valid": false')
    expect(stdout).toContain(GOLDEN_FINGERPRINT)
  })

  test("the key error wins over an OAuth error", async () => {
    const keyError = new ApiError({
      httpStatus: 401,
      code: 401,
      apiMessage: "key",
      reasons: []
    })
    const oauthError = new ApiError({
      httpStatus: 403,
      code: 403,
      apiMessage: "oauth",
      reasons: []
    })
    const { exit } = await run(["status", "--check"], {
      format: "json",
      keyProbeError: keyError,
      oauthProbeError: oauthError
    })
    expect(errorOf(exit).message).toContain("key")
  })

  test("the OAuth error surfaces when the key is fine", async () => {
    const oauthError = new ApiError({
      httpStatus: 403,
      code: 403,
      apiMessage: "oauth is bad",
      reasons: []
    })
    const { exit } = await run(["status", "--check"], {
      format: "json",
      oauthProbeError: oauthError
    })
    expect(errorOf(exit).message).toContain("oauth is bad")
  })

  test("--check with neither credential fails with MissingKeyError and no output", async () => {
    const { stdout, exit } = await run(["status", "--check"], {
      format: "json",
      credentials: credentials({ key: "", source: "", oauth: undefined })
    })
    expect(errorOf(exit)).toBeInstanceOf(MissingKeyError)
    expect(stdout).toBe("")
  })

  test("the table rendering matches Go's line-by-line format", async () => {
    const { stdout } = await run(["status"], { format: "table" })
    expect(stdout).toBe(
      `Path: ${GOLDEN_PATH}\n` +
        "API key configured: true\n" +
        "API key source: auth.json\n" +
        `API key fingerprint: ${GOLDEN_FINGERPRINT}\n` +
        "OAuth configured: true\n" +
        `OAuth client ID: ${storedOAuth.clientId}\n` +
        "OAuth scopes: https://www.googleapis.com/auth/youtube.readonly\n" +
        "OAuth token expiry: 2027-01-01T00:00:00Z\n"
    )
  })

  test("an unconfigured key omits the fingerprint line", async () => {
    const { stdout } = await run(["status"], {
      format: "table",
      credentials: credentials({ key: "", source: "" })
    })
    expect(stdout).toContain("API key source: none")
    expect(stdout).not.toContain("fingerprint")
  })

  test("no OAuth means the oauth block is `configured` alone", () => {
    const state = statusState(
      credentials({ oauth: undefined }),
      { key: undefined, oauth: undefined },
      false
    )
    expect(state["oauth"]).toEqual({ configured: false })
  })

  test("an empty expiry renders as `unknown` in the table only", async () => {
    const { stdout } = await run(["status"], {
      format: "table",
      credentials: credentials({ oauth: { ...storedOAuth, expiry: "" } })
    })
    expect(stdout).toContain("OAuth token expiry: unknown")
    const json = await run(["status"], {
      format: "json",
      credentials: credentials({ oauth: { ...storedOAuth, expiry: "" } })
    })
    // The state object keeps the raw empty string; only the table substitutes.
    expect(json.stdout).toContain('"expiry": ""')
  })

  test("the tsv header uses the non-check column set without --check", async () => {
    const { stdout } = await run(["status"], { format: "tsv" })
    const header = stdout.split("\n")[0]!
    expect(header.split("\t")).toEqual(statusColumns.map((c) => c.toUpperCase()))
  })

  test("the tsv header uses the check column set with --check", async () => {
    const { stdout } = await run(["status", "--check"], { format: "tsv" })
    const header = stdout.split("\n")[0]!
    expect(header.split("\t")).toEqual(statusCheckColumns.map((c) => c.toUpperCase()))
  })

  test("--columns overrides the default list for tsv", async () => {
    const { stdout } = await run(["status"], { format: "tsv", columns: ["path"] })
    expect(stdout).toBe(`PATH\n${GOLDEN_PATH}\n`)
  })

  test("--columns is IGNORED for the table rendering (Go bypasses RenderObject)", async () => {
    const { stdout } = await run(["status"], { format: "table", columns: ["path"] })
    expect(stdout).toContain("API key configured: true")
  })

  test("checkVerdict renders both outcomes verbatim", () => {
    expect(checkVerdict(null)).toBe("valid")
    expect(checkVerdict(new UsageError({ message: "nope" }))).toBe("invalid (nope)")
  })

  test("valueOr only substitutes for the empty string", () => {
    expect(valueOr("", "none")).toBe("none")
    expect(valueOr("auth.json", "none")).toBe("auth.json")
    expect(valueOr(" ", "none")).toBe(" ")
  })
})

// ---------------------------------------------------------------------------
// The key-scoped probe
// ---------------------------------------------------------------------------

/**
 * `status --check` and `login` must validate the API KEY, not whatever
 * credential the ambient client happens to prefer.
 *
 * `HttpCore`'s auth switch is first-match-wins with OAuth strictly ahead of the
 * key, so with both credentials stored the ambient `YouTubeApi` would send a
 * bearer token and the "API key check" would actually be a second OAuth check —
 * exactly the masking Go's comment says must not happen. `keyScopedApi` builds
 * a one-off client with `tokenSource: undefined` to avoid that, but only when
 * an `HttpClient` is reachable.
 *
 * NOTE FOR THE ORCHESTRATOR: `AppLayer` does not currently export
 * `HttpClient`, so in production this degrades to the ambient `YouTubeApi` and
 * the probe is less precise than Go's. Verified empirically against the real
 * `AppLayer`. Adding `HttpClientLive` to `AppLayer`'s exported set activates
 * the precise path with no change to this file.
 */
describe("the API-key probe is key-scoped", () => {
  test("it sends the i18nLanguages part=snippet request Go used", async () => {
    const { recorder } = await run(["status", "--check"], { format: "json" })
    expect(recorder.getCalls).toEqual([["i18nLanguages", [["part", "snippet"]]]])
  })

  test("with HttpClient absent it degrades to the ambient client, not to a crash", async () => {
    // The harness provides no HttpClient, mirroring today's AppLayer.
    const { exit } = await run(["status", "--check"], { format: "json" })
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a key probe failure is distinguishable from an OAuth probe failure", async () => {
    const keyOnly = await run(["status", "--check"], {
      format: "json",
      keyProbeError: new ApiError({
        httpStatus: 400,
        code: 400,
        apiMessage: "key bad",
        reasons: []
      })
    })
    expect(keyOnly.stdout).toContain('"valid": false')
    // The OAuth block still reports valid, so the two probes are independent.
    const oauthBlock = keyOnly.stdout.slice(keyOnly.stdout.indexOf('"oauth"'))
    expect(oauthBlock).toContain('"valid": true')
  })
})

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe("login (API key)", () => {
  test("prompts on stderr, validates, then saves", async () => {
    const { stdout, stderr, recorder, exit } = await run(["login"], {
      promptLines: ["  my-key  "]
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stderr).toContain("YouTube Data API key: ")
    expect(recorder.getCalls).toEqual([["i18nLanguages", [["part", "snippet"]]]])
    expect(recorder.saved).toEqual(["my-key"])
    expect(stdout).toContain(`API key validated and saved to ${GOLDEN_PATH}`)
    expect(stdout).toContain(GOLDEN_FINGERPRINT)
  })

  test("an empty key is a UsageError before any network call", async () => {
    const { recorder, exit } = await run(["login"], { promptLines: ["   "] })
    const error = errorOf(exit)
    expect(error).toBeInstanceOf(UsageError)
    expect(error.message).toBe("API key cannot be empty")
    expect(recorder.getCalls).toEqual([])
    expect(recorder.saved).toEqual([])
  })

  test("a failed validation wraps the cause and saves nothing", async () => {
    const { recorder, exit } = await run(["login"], {
      promptLines: ["bad"],
      keyProbeError: new ApiError({
        httpStatus: 400,
        code: 400,
        apiMessage: "API key not valid",
        reasons: ["badRequest"]
      })
    })
    expect(errorOf(exit).message).toStartWith("API key validation failed: ")
    expect(recorder.saved).toEqual([])
  })

  test("OYTC_API_KEY being set adds the precedence note", async () => {
    const { stdout } = await run(["login"], { promptLines: ["k"], envKeySet: true })
    expect(stdout).toContain(
      "Note: OYTC_API_KEY remains the active, higher-precedence credential."
    )
  })
})

describe("login --oauth", () => {
  test("prompts for both values, then saves the grant", async () => {
    const { stdout, recorder, exit } = await run(["login", "--oauth"], {
      promptLines: ["  cid  ", "  csecret  "]
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(recorder.prompts).toEqual(["OAuth client ID: ", "OAuth client secret: "])
    expect(recorder.savedOAuth).toHaveLength(1)
    expect(stdout).toContain(`OAuth authorization saved to ${GOLDEN_PATH}`)
    expect(stdout).toContain(
      "Granted scopes: https://www.googleapis.com/auth/youtube.readonly"
    )
  })

  test("a bootstrapped client ID skips ONLY that prompt", async () => {
    const { recorder } = await run(["login", "--oauth"], {
      bootstrap: ["env-cid", ""],
      promptLines: ["env-secret"]
    })
    expect(recorder.prompts).toEqual(["OAuth client secret: "])
  })

  test("both bootstrapped means no prompt at all", async () => {
    const { recorder, exit } = await run(["login", "--oauth"], {
      bootstrap: ["env-cid", "env-secret"]
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(recorder.prompts).toEqual([])
  })

  test("an empty client ID or secret is a UsageError", async () => {
    const { exit } = await run(["login", "--oauth"], { promptLines: ["", ""] })
    const error = errorOf(exit)
    expect(error).toBeInstanceOf(UsageError)
    expect(error.message).toBe("OAuth client ID and client secret cannot be empty")
  })

  test("a login failure is wrapped and nothing is saved", async () => {
    const { recorder, exit } = await run(["login", "--oauth"], {
      promptLines: ["cid", "secret"],
      loginError: new OperationalError({ message: "browser died" })
    })
    expect(errorOf(exit).message).toBe("OAuth login failed: browser died")
    expect(recorder.savedOAuth).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe("logout", () => {
  test("revokes then removes, reporting the path", async () => {
    const { stdout, recorder, exit } = await run(["logout"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(recorder.revoked).toEqual([storedOAuth])
    expect(recorder.removedCalled).toBe(true)
    expect(stdout).toBe(`Removed stored credentials at ${GOLDEN_PATH}.\n`)
  })

  test("reports when there was nothing to remove", async () => {
    const { stdout } = await run(["logout"], { removed: false })
    expect(stdout).toBe(`No stored credentials at ${GOLDEN_PATH}.\n`)
  })

  test("no stored OAuth means no revocation attempt", async () => {
    const { recorder } = await run(["logout"], {
      credentials: credentials({ oauth: undefined })
    })
    expect(recorder.revoked).toEqual([])
  })

  test("a corrupt auth.json warns on stderr and still removes the file", async () => {
    const { stdout, stderr, recorder, exit } = await run(["logout"], {
      loadError: new OperationalError({ message: "invalid character 'x'" })
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(stderr).toContain(
      "Warning: could not read stored credentials (skipping OAuth revocation): " +
        "invalid character 'x'"
    )
    expect(recorder.revoked).toEqual([])
    expect(recorder.removedCalled).toBe(true)
    expect(stdout).toContain("Removed stored credentials")
  })

  test("OYTC_API_KEY being set adds the still-active note", async () => {
    const { stdout } = await run(["logout"], { envKeySet: true })
    expect(stdout).toContain(
      "OYTC_API_KEY is still set; environment credentials remain active."
    )
  })
})

// ---------------------------------------------------------------------------
// oauthAuthHint
// ---------------------------------------------------------------------------

describe("oauthAuthHint", () => {
  const apiError = (httpStatus: number, reasons: ReadonlyArray<string>): ApiError =>
    new ApiError({ httpStatus, code: httpStatus, apiMessage: "boom", reasons })

  test("invalid_grant anywhere in the message triggers the re-login hint", () => {
    const hinted = oauthAuthHint(new OperationalError({ message: "oauth: INVALID_GRANT here" }))
    expect(hinted.message).toStartWith(
      "OAuth authorization failed; re-run 'oytc login --oauth': "
    )
  })

  test("a 401 ApiError triggers the re-login hint", () => {
    expect(oauthAuthHint(apiError(401, [])).message).toStartWith(
      "OAuth authorization failed; re-run 'oytc login --oauth': "
    )
  })

  test("insufficientPermissions triggers the scopes hint, case-insensitively", () => {
    expect(oauthAuthHint(apiError(403, ["INSUFFICIENTPERMISSIONS"])).message).toStartWith(
      "OAuth scopes are insufficient; re-run 'oytc login --oauth': "
    )
  })

  test("an unrelated error passes through untouched", () => {
    const original = apiError(500, ["backendError"])
    expect(oauthAuthHint(original)).toBe(original)
  })

  test("a non-ApiError without invalid_grant passes through untouched", () => {
    const original = new OperationalError({ message: "network down" })
    expect(oauthAuthHint(original)).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("command registration", () => {
  test("exports the three commands with Go's names", () => {
    expect(authCommands.map((c) => c.name)).toEqual(["login", "status", "logout"])
    expect(loginCommand.name).toBe("login")
    expect(statusCommand.name).toBe("status")
    expect(logoutCommand.name).toBe("logout")
  })

  test("descriptions match the Go Short strings", () => {
    expect(loginCommand.description).toBe(
      "Validate and save an API key or read-only OAuth authorization"
    )
    expect(statusCommand.description).toBe(
      "Show API-key and OAuth status; optionally validate them"
    )
    expect(logoutCommand.description).toBe(
      "Revoke OAuth best-effort and remove stored credentials"
    )
  })
})

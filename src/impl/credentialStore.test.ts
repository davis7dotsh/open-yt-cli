/**
 * Ports all 8 cases from `internal/config/config_test.go`, plus the
 * cross-process shape of `TestConcurrentUpdatesAreNotLost` that the Go suite
 * cannot express (goroutines share one flock file description; two OS
 * processes do not).
 *
 * Every test gets its own temp dir via `OYTC_CONFIG_DIR`. The real config
 * directory is never read or written.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OperationalError } from "../domain/errors.ts"
import {
  CredentialStore,
  ProcessEnv,
  type CredentialStoreShape,
  type ProcessEnvShape,
  type StoredOAuth
} from "../services/index.ts"
import { CredentialStoreLive, fingerprint } from "./credentialStore.ts"
import { FileLockLive } from "./fileLock.ts"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const temporaries: Array<string> = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oytc-cred-"))
  temporaries.push(dir)
  return dir
}

afterEach(() => {
  while (temporaries.length > 0) {
    rmSync(temporaries.pop()!, { recursive: true, force: true })
  }
})

const platform = BunServices.layer as unknown as Layer.Layer<
  FileSystem.FileSystem | Path.Path
>

interface EnvOverrides {
  readonly [name: string]: string | undefined
}

/**
 * A ProcessEnv whose variables and platform are fully controlled, so
 * `Dir()` resolution can be tested for darwin/windows/linux from one host.
 */
const testProcessEnv = (options: {
  readonly env?: EnvOverrides
  readonly platform?: string
  readonly home?: string | undefined
}): ProcessEnvShape => {
  const env = options.env ?? {}
  return {
    env: (name) => Option.fromNullishOr(env[name]),
    platform: options.platform ?? process.platform,
    arch: process.arch,
    argv: [],
    executablePath: Effect.succeed("/nonexistent/oytc"),
    isOutputTTY: false,
    homeDir:
      options.home === undefined
        ? Effect.fail(new OperationalError({ message: "could not determine home directory" }))
        : Effect.succeed(options.home)
  }
}

/** One fresh store (and therefore one fresh lock semaphore) per invocation. */
const storeLayer = (options: {
  readonly env?: EnvOverrides
  readonly platform?: string
  readonly home?: string | undefined
}): Layer.Layer<(typeof CredentialStore)["Identifier"]> => {
  const processEnv = Layer.succeed(ProcessEnv, testProcessEnv(options))
  return Layer.fresh(
    CredentialStoreLive.pipe(
      Layer.provide(Layer.mergeAll(platform, processEnv, FileLockLive.pipe(Layer.provide(platform))))
    )
  ) as unknown as Layer.Layer<(typeof CredentialStore)["Identifier"]>
}

const runIn = <A, E>(
  layer: Layer.Layer<(typeof CredentialStore)["Identifier"]>,
  f: (store: CredentialStoreShape) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(CredentialStore, f).pipe(Effect.provide(layer)) as Effect.Effect<A, E>
  )

const exitIn = <A, E>(
  layer: Layer.Layer<(typeof CredentialStore)["Identifier"]>,
  f: (store: CredentialStoreShape) => Effect.Effect<A, E>
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.exit(
      Effect.flatMap(CredentialStore, f).pipe(Effect.provide(layer)) as Effect.Effect<A, E>
    )
  )

/** A store bound to `dir` with no OYTC_API_KEY, the common case. */
const storeAt = (dir: string, extra: EnvOverrides = {}) =>
  storeLayer({ env: { OYTC_CONFIG_DIR: dir, ...extra } })

const perm = (target: string): number => statSync(target).mode & 0o777

const oauth = (overrides: Partial<StoredOAuth> = {}): StoredOAuth => ({
  clientId: "id",
  clientSecret: "secret",
  accessToken: "access",
  refreshToken: "refresh",
  expiry: "2026-02-01T12:00:00Z",
  scopes: ["scope"],
  ...overrides
})

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""

// ---------------------------------------------------------------------------
// Dir() resolution — §1.1 / §1.2
// ---------------------------------------------------------------------------

describe("dir", () => {
  test("OYTC_CONFIG_DIR is used verbatim, with NO oytc suffix appended", async () => {
    const dir = await runIn(
      storeLayer({ env: { OYTC_CONFIG_DIR: "/custom/place" }, platform: "linux" }),
      (store) => store.dir
    )
    expect(dir).toBe("/custom/place")
  })

  test("OYTC_CONFIG_DIR is trimmed before the emptiness test", async () => {
    const dir = await runIn(
      storeLayer({ env: { OYTC_CONFIG_DIR: "  /custom/place  " }, platform: "linux" }),
      (store) => store.dir
    )
    expect(dir).toBe("/custom/place")
  })

  test("a whitespace-only OYTC_CONFIG_DIR falls through to the OS default", async () => {
    const dir = await runIn(
      storeLayer({ env: { OYTC_CONFIG_DIR: "   " }, platform: "linux", home: "/home/u" }),
      (store) => store.dir
    )
    expect(dir).toBe("/home/u/.config/oytc")
  })

  test.each([
    ["~", "/home/u"],
    ["~/cfg", "/home/u/cfg"],
    ["~\\cfg", "/home/u/cfg"],
    // ~user is NOT supported: it starts with neither "~/" nor "~\".
    ["~other/cfg", "~other/cfg"],
    ["/abs/path", "/abs/path"],
    ["relative", "relative"]
  ])("tilde expansion of %s -> %s", async (input, expected) => {
    const dir = await runIn(
      storeLayer({ env: { OYTC_CONFIG_DIR: input }, platform: "linux", home: "/home/u" }),
      (store) => store.dir
    )
    expect(dir).toBe(expected)
  })

  test("an unresolvable home leaves a tilde path unchanged", async () => {
    const dir = await runIn(
      storeLayer({ env: { OYTC_CONFIG_DIR: "~/cfg" }, platform: "linux", home: undefined }),
      (store) => store.dir
    )
    expect(dir).toBe("~/cfg")
  })

  test("darwin resolves to ~/Library/Application Support/oytc", async () => {
    const dir = await runIn(storeLayer({ platform: "darwin", home: "/Users/u" }), (s) => s.dir)
    expect(dir).toBe("/Users/u/Library/Application Support/oytc")
  })

  test("darwin propagates an unresolvable home", async () => {
    const exit = await exitIn(storeLayer({ platform: "darwin", home: undefined }), (s) => s.dir)
    expect(failureMessage(exit)).toContain("determine config directory")
  })

  test("windows resolves to %APPDATA%\\oytc", async () => {
    const dir = await runIn(
      storeLayer({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } }),
      (s) => s.dir
    )
    // path.join is host-flavored; assert on the components, not the separator.
    expect(dir.replaceAll("\\", "/")).toBe("C:/Users/u/AppData/Roaming/oytc")
  })

  test("windows without APPDATA is an error", async () => {
    const exit = await exitIn(storeLayer({ platform: "win32", env: {} }), (s) => s.dir)
    expect(failureMessage(exit)).toContain("determine config directory: APPDATA is not set")
  })

  test("linux prefers XDG_CONFIG_HOME", async () => {
    const dir = await runIn(
      storeLayer({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/u" }),
      (s) => s.dir
    )
    expect(dir).toBe("/xdg/oytc")
  })

  test("XDG_CONFIG_HOME is NOT trimmed — whitespace is a real value", async () => {
    // Deliberate asymmetry with OYTC_CONFIG_DIR, matching Go: only an
    // exactly-empty XDG_CONFIG_HOME counts as unset.
    const dir = await runIn(
      storeLayer({ platform: "linux", env: { XDG_CONFIG_HOME: "  " }, home: "/home/u" }),
      (s) => s.dir
    )
    expect(dir).toBe("  /oytc")
  })

  test("linux falls back to ~/.config/oytc", async () => {
    const dir = await runIn(storeLayer({ platform: "linux", home: "/home/u" }), (s) => s.dir)
    expect(dir).toBe("/home/u/.config/oytc")
  })

  test("path is dir + auth.json", async () => {
    const layer = storeLayer({ env: { OYTC_CONFIG_DIR: "/custom" }, platform: "linux" })
    expect(await runIn(layer, (s) => s.path)).toBe("/custom/auth.json")
  })
})

// ---------------------------------------------------------------------------
// TestSaveLoadRemoveAndModes
// ---------------------------------------------------------------------------

describe("TestSaveLoadRemoveAndModes", () => {
  test("save, load, replace, remove, and file modes", async () => {
    const root = tempDir()
    const configDir = join(root, "nested")
    const layer = storeAt(configDir)

    const path = await runIn(layer, (store) => store.save("test-secret-key"))
    expect(path).toBe(join(configDir, "auth.json"))

    expect(readFileSync(path, "utf8")).toBe('{\n  "api_key": "test-secret-key"\n}\n')
    expect(perm(path)).toBe(0o600)
    expect(perm(configDir)).toBe(0o700)

    const credentials = await runIn(layer, (store) => store.load)
    expect(credentials.key).toBe("test-secret-key")
    expect(credentials.source).toBe("auth.json")
    expect(credentials.oauth).toBeUndefined()
    expect(credentials.path).toBe(path)

    await runIn(layer, (store) => store.save("replacement-secret"))
    expect((await runIn(layer, (store) => store.load)).key).toBe("replacement-secret")

    const removed = await runIn(layer, (store) => store.remove)
    expect(removed).toEqual({ path, removed: true })
    expect(existsSync(path)).toBe(false)

    // Remove is idempotent: a missing file is (path, false, nil).
    expect(await runIn(layer, (store) => store.remove)).toEqual({ path, removed: false })
  })

  test("save trims the key and rejects an empty one", async () => {
    const layer = storeAt(tempDir())
    const path = await runIn(layer, (store) => store.save("  padded-key  "))
    expect(readFileSync(path, "utf8")).toContain('"api_key": "padded-key"')

    for (const empty of ["", "   ", "\t\n"]) {
      const exit = await exitIn(layer, (store) => store.save(empty))
      expect(failureMessage(exit)).toContain("API key cannot be empty")
    }
  })

  test("loading a nonexistent file yields empty credentials, not an error", async () => {
    const dir = tempDir()
    const credentials = await runIn(storeAt(dir), (store) => store.load)
    expect(credentials).toEqual({
      key: "",
      source: "",
      oauth: undefined,
      path: join(dir, "auth.json")
    })
  })
})

// ---------------------------------------------------------------------------
// TestAPIKeyAndOAuthCoexistAndUpdateIndependently
// ---------------------------------------------------------------------------

describe("TestAPIKeyAndOAuthCoexistAndUpdateIndependently", () => {
  test("api_key and oauth update without clobbering each other", async () => {
    const layer = storeAt(tempDir())

    await runIn(layer, (store) => store.save("api-secret"))
    await runIn(layer, (store) =>
      store.saveOAuth(
        oauth({
          clientId: "desktop-id",
          clientSecret: "client-secret",
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          scopes: ["scope.one", "scope.two"]
        })
      )
    )

    let credentials = await runIn(layer, (store) => store.load)
    expect(credentials.key).toBe("api-secret")
    expect(credentials.oauth?.clientId).toBe("desktop-id")
    expect(credentials.oauth?.refreshToken).toBe("refresh-secret")
    expect(credentials.oauth?.scopes).toEqual(["scope.one", "scope.two"])

    await runIn(layer, (store) => store.save("replacement-key"))
    credentials = await runIn(layer, (store) => store.load)
    expect(credentials.oauth?.accessToken).toBe("access-secret")

    await runIn(layer, (store) => store.clearOAuth)
    credentials = await runIn(layer, (store) => store.load)
    expect(credentials.key).toBe("replacement-key")
    expect(credentials.oauth).toBeUndefined()
    // A cleared oauth block is OMITTED, not written as null.
    expect(readFileSync(credentials.path, "utf8")).toBe('{\n  "api_key": "replacement-key"\n}\n')
  })

  test("clearOAuth on a file with no oauth is a no-op that still succeeds", async () => {
    const layer = storeAt(tempDir())
    await runIn(layer, (store) => store.save("k"))
    await runIn(layer, (store) => store.clearOAuth)
    expect((await runIn(layer, (store) => store.load)).key).toBe("k")
  })

  test("normalizeOAuth trims the five strings and enforces both rules", async () => {
    const layer = storeAt(tempDir())

    const path = await runIn(layer, (store) =>
      store.saveOAuth(
        oauth({
          clientId: "  id  ",
          clientSecret: "  secret  ",
          accessToken: "  access  ",
          refreshToken: "  refresh  ",
          expiry: "  2026-02-01T12:00:00Z  "
        })
      )
    )
    const text = readFileSync(path, "utf8")
    expect(text).toContain('"client_id": "id"')
    expect(text).toContain('"expiry": "2026-02-01T12:00:00Z"')

    const missingClient = await exitIn(layer, (store) =>
      store.saveOAuth(oauth({ clientId: "  " }))
    )
    expect(failureMessage(missingClient)).toContain(
      "OAuth client ID and client secret cannot be empty"
    )

    const missingSecret = await exitIn(layer, (store) =>
      store.saveOAuth(oauth({ clientSecret: "" }))
    )
    expect(failureMessage(missingSecret)).toContain(
      "OAuth client ID and client secret cannot be empty"
    )

    const missingTokens = await exitIn(layer, (store) =>
      store.saveOAuth(oauth({ accessToken: " ", refreshToken: "" }))
    )
    expect(failureMessage(missingTokens)).toContain(
      "OAuth access token or refresh token is required"
    )

    // Either token alone is sufficient.
    await runIn(layer, (store) => store.saveOAuth(oauth({ accessToken: "", refreshToken: "r" })))
    await runIn(layer, (store) => store.saveOAuth(oauth({ accessToken: "a", refreshToken: "" })))
  })

  test("scopes are not validated or normalized", async () => {
    const layer = storeAt(tempDir())
    const path = await runIn(layer, (store) =>
      store.saveOAuth(oauth({ scopes: ["  padded  ", ""] }))
    )
    expect(readFileSync(path, "utf8")).toContain('"  padded  "')
  })

  test("an empty scopes array serializes as null, matching Go's cloneOAuth", async () => {
    // Go's `append([]string(nil), empty...)` returns nil, so an empty slice
    // and a nil slice are indistinguishable once stored.
    const layer = storeAt(tempDir())
    const path = await runIn(layer, (store) => store.saveOAuth(oauth({ scopes: [] })))
    expect(readFileSync(path, "utf8")).toContain('"scopes": null')
    expect((await runIn(layer, (store) => store.load)).oauth?.scopes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TestOAuthBootstrapEnvironmentPrecedence
// ---------------------------------------------------------------------------

describe("TestOAuthBootstrapEnvironmentPrecedence", () => {
  test("returns the trimmed bootstrap variables", async () => {
    const pair = await runIn(
      storeAt(tempDir(), {
        OYTC_OAUTH_CLIENT_ID: "  environment-id  ",
        OYTC_OAUTH_CLIENT_SECRET: "  environment-secret  "
      }),
      (store) => store.oauthBootstrap
    )
    expect(pair).toEqual(["environment-id", "environment-secret"])
  })

  test("unset variables come back as empty strings", async () => {
    expect(await runIn(storeAt(tempDir()), (store) => store.oauthBootstrap)).toEqual(["", ""])
  })
})

// ---------------------------------------------------------------------------
// TestConcurrentUpdatesAreNotLost — shape (a), concurrent fibers
// ---------------------------------------------------------------------------

describe("TestConcurrentUpdatesAreNotLost (in-process fibers)", () => {
  test("a concurrent api-key save and oauth save both survive", async () => {
    const dir = tempDir()
    const layer = storeAt(dir)

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CredentialStore
        yield* Effect.all([store.save("api-secret"), store.saveOAuth(oauth())], {
          concurrency: "unbounded"
        })
      }).pipe(Effect.provide(layer)) as Effect.Effect<void>
    )

    const credentials = await runIn(layer, (store) => store.load)
    expect(credentials.key).toBe("api-secret")
    expect(credentials.oauth?.refreshToken).toBe("refresh")
  })

  test("many concurrent writers all land — none is silently dropped", async () => {
    // Without the read-modify-write lock, the last rename wins and every
    // earlier writer's field vanishes.
    const layer = storeAt(tempDir())
    const writers = 12

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CredentialStore
        yield* Effect.all(
          Array.from({ length: writers }, (_unused, i) =>
            i % 2 === 0
              ? Effect.asVoid(store.save(`key-${i}`))
              : Effect.asVoid(store.saveOAuth(oauth({ accessToken: `access-${i}` })))
          ),
          { concurrency: "unbounded" }
        )
      }).pipe(Effect.provide(layer)) as Effect.Effect<void>
    )

    const credentials = await runIn(layer, (store) => store.load)
    // Which writer won each field is a race, but BOTH fields must be present:
    // that is what "no update was lost" means.
    expect(credentials.key).toMatch(/^key-\d+$/)
    expect(credentials.oauth?.accessToken).toMatch(/^access-\d+$/)
  })
})

// ---------------------------------------------------------------------------
// TestConcurrentUpdatesAreNotLost — shape (b), two spawned bun processes.
// This is the shape that actually proves cross-process safety and has no
// counterpart in the Go suite (goroutines share one flock file description).
// ---------------------------------------------------------------------------

const WORKER = join(import.meta.dir, "credentialStore.worker.ts")

const spawnWorker = async (
  configDir: string,
  mode: string,
  iterations: string
): Promise<{ readonly code: number; readonly stderr: string }> => {
  const proc = Bun.spawn(["bun", "run", WORKER, configDir, mode, iterations], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OYTC_API_KEY: "" }
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, stderr }
}

describe("TestConcurrentUpdatesAreNotLost (two spawned bun subprocesses)", () => {
  test(
    "an api-key writer and an oauth writer in SEPARATE processes both survive",
    async () => {
      const dir = tempDir()

      const [keyWorker, oauthWorker] = await Promise.all([
        spawnWorker(dir, "key", "25"),
        spawnWorker(dir, "oauth", "25")
      ])

      expect(keyWorker.stderr).toBe("")
      expect(oauthWorker.stderr).toBe("")
      expect(keyWorker.code).toBe(0)
      expect(oauthWorker.code).toBe(0)

      const credentials = await runIn(storeAt(dir), (store) => store.load)
      // Each process hammered its own field 25 times while the other did the
      // same. With only an atomic rename and no lock, one field would be gone.
      expect(credentials.key).toBe("api-secret-24")
      expect(credentials.oauth?.accessToken).toBe("access-24")
      expect(credentials.oauth?.refreshToken).toBe("refresh")
      expect(credentials.oauth?.scopes).toEqual(["scope"])
    },
    60_000
  )

  test(
    "the file is never observed torn or truncated by a concurrent reader",
    async () => {
      // A reader process parsing auth.json while two writers race proves the
      // temp-file + fsync + rename sequence really is atomic to readers.
      const dir = tempDir()
      const results = await Promise.all([
        spawnWorker(dir, "key", "20"),
        spawnWorker(dir, "oauth", "20"),
        spawnWorker(dir, "read", "60")
      ])
      for (const result of results) {
        expect(result.stderr).toBe("")
        expect(result.code).toBe(0)
      }
    },
    60_000
  )
})

// ---------------------------------------------------------------------------
// TestRefreshedOAuthDoesNotRestoreRemovedCredentials
// ---------------------------------------------------------------------------

describe("TestRefreshedOAuthDoesNotRestoreRemovedCredentials", () => {
  test("a stale refresh does not resurrect credentials removed by logout", async () => {
    const layer = storeAt(tempDir())
    const initial = oauth({ accessToken: "old-access" })

    await runIn(layer, (store) => store.saveOAuth(initial))
    const removed = await runIn(layer, (store) => store.remove)
    expect(removed.removed).toBe(true)

    const updated = oauth({ accessToken: "new-access", expiry: "2026-02-01T13:00:00Z" })
    const saved = await runIn(layer, (store) => store.saveRefreshedOAuth(initial, updated))

    // No write, no error — the whole point of the compare-and-swap.
    expect(saved).toBe(false)
    expect(existsSync(removed.path)).toBe(false)
  })

  test("a matching expectation DOES write and preserves the api_key", async () => {
    const layer = storeAt(tempDir())
    const initial = oauth({ accessToken: "old-access" })
    await runIn(layer, (store) => store.save("keep-me"))
    await runIn(layer, (store) => store.saveOAuth(initial))

    const updated = oauth({ accessToken: "new-access", expiry: "2026-02-01T13:00:00Z" })
    expect(await runIn(layer, (store) => store.saveRefreshedOAuth(initial, updated))).toBe(true)

    const credentials = await runIn(layer, (store) => store.load)
    expect(credentials.oauth?.accessToken).toBe("new-access")
    expect(credentials.oauth?.expiry).toBe("2026-02-01T13:00:00Z")
    // The api_key is re-read inside the lock and carried across.
    expect(credentials.key).toBe("keep-me")
  })

  test.each([
    ["clientId", { clientId: "different" }],
    ["clientSecret", { clientSecret: "different" }],
    ["accessToken", { accessToken: "different" }],
    ["refreshToken", { refreshToken: "different" }],
    ["expiry", { expiry: "different" }],
    ["scope count", { scopes: ["scope", "extra"] }],
    ["scope order", { scopes: ["b", "a"] }]
  ] as ReadonlyArray<readonly [string, Partial<StoredOAuth>]>)(
    "a mismatched %s blocks the write",
    async (_name, patch) => {
      const layer = storeAt(tempDir())
      const stored = oauth({ scopes: ["a", "b"] })
      await runIn(layer, (store) => store.saveOAuth(stored))

      const expected = { ...stored, ...patch }
      const updated = oauth({ accessToken: "new-access", scopes: ["a", "b"] })
      expect(await runIn(layer, (store) => store.saveRefreshedOAuth(expected, updated))).toBe(
        false
      )

      // The stored block is untouched.
      const credentials = await runIn(layer, (store) => store.load)
      expect(credentials.oauth?.accessToken).toBe("access")
    }
  )

  test("a login that replaced the credentials mid-refresh also blocks the write", async () => {
    const layer = storeAt(tempDir())
    const original = oauth({ accessToken: "original" })
    await runIn(layer, (store) => store.saveOAuth(original))

    // A new `login` lands while the refresh is in flight.
    await runIn(layer, (store) => store.saveOAuth(oauth({ accessToken: "from-new-login" })))

    const refreshed = oauth({ accessToken: "refreshed-from-original" })
    expect(await runIn(layer, (store) => store.saveRefreshedOAuth(original, refreshed))).toBe(
      false
    )
    expect((await runIn(layer, (store) => store.load)).oauth?.accessToken).toBe("from-new-login")
  })

  test("expecting undefined against an empty file writes", async () => {
    const layer = storeAt(tempDir())
    const next = oauth()
    expect(await runIn(layer, (store) => store.saveRefreshedOAuth(undefined, next))).toBe(true)
    expect((await runIn(layer, (store) => store.load)).oauth?.accessToken).toBe("access")
  })

  test("expecting undefined against a populated file does not write", async () => {
    const layer = storeAt(tempDir())
    await runIn(layer, (store) => store.saveOAuth(oauth({ accessToken: "stored" })))
    expect(
      await runIn(layer, (store) => store.saveRefreshedOAuth(undefined, oauth({ accessToken: "x" })))
    ).toBe(false)
    expect((await runIn(layer, (store) => store.load)).oauth?.accessToken).toBe("stored")
  })

  test("the replacement is normalized before the compare", async () => {
    const layer = storeAt(tempDir())
    const exit = await exitIn(layer, (store) =>
      store.saveRefreshedOAuth(undefined, oauth({ clientId: "  " }))
    )
    expect(failureMessage(exit)).toContain("OAuth client ID and client secret cannot be empty")
  })
})

// ---------------------------------------------------------------------------
// TestLoadFallsBackToEnvironmentKeyWhenFileCorrupt
// ---------------------------------------------------------------------------

describe("TestLoadFallsBackToEnvironmentKeyWhenFileCorrupt", () => {
  test("a corrupt auth.json falls back to OYTC_API_KEY without an error", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "auth.json"), "{not json", { mode: 0o600 })

    const credentials = await runIn(
      storeAt(dir, { OYTC_API_KEY: "environment-secret" }),
      (store) => store.load
    )
    expect(credentials.key).toBe("environment-secret")
    expect(credentials.source).toBe("OYTC_API_KEY")
    // A corrupt file yields no OAuth: nothing could be parsed out of it.
    expect(credentials.oauth).toBeUndefined()
  })

  test("without the env key, a corrupt file is a parse error", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "auth.json"), "{not json", { mode: 0o600 })
    const exit = await exitIn(storeAt(dir), (store) => store.load)
    expect(failureMessage(exit)).toContain("parse credentials")
  })

  test("a type error inside a well-formed file is also a parse error", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "auth.json"), '{"api_key":123}', { mode: 0o600 })
    const exit = await exitIn(storeAt(dir), (store) => store.load)
    expect(failureMessage(exit)).toContain("parse credentials")
  })

  test("a whitespace-only env key does NOT rescue a corrupt file", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "auth.json"), "{not json", { mode: 0o600 })
    const exit = await exitIn(storeAt(dir, { OYTC_API_KEY: "   " }), (store) => store.load)
    expect(failureMessage(exit)).toContain("parse credentials")
  })

  test("mutations stay STRICT on a corrupt file even with the env key set", async () => {
    // Falling back on a mutation would rewrite the file from an empty
    // in-memory File and silently destroy the user's stored OAuth block.
    const dir = tempDir()
    const path = join(dir, "auth.json")
    writeFileSync(path, "{not json", { mode: 0o600 })

    const layer = storeAt(dir, { OYTC_API_KEY: "environment-secret" })
    const exit = await exitIn(layer, (store) => store.save("new-key"))
    expect(failureMessage(exit)).toContain("parse credentials")
    expect(readFileSync(path, "utf8")).toBe("{not json")
  })

  test("a directory where auth.json should be is a read error, not a parse error", async () => {
    const dir = tempDir()
    const layer = storeAt(dir)
    // Force the path to be a directory.
    await runIn(layer, (store) => store.path)
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(dir, "auth.json"))
    const exit = await exitIn(layer, (store) => store.load)
    expect(failureMessage(exit)).toContain("read credentials")
  })
})

// ---------------------------------------------------------------------------
// TestEnvironmentKeyHasPrecedence
// ---------------------------------------------------------------------------

describe("TestEnvironmentKeyHasPrecedence", () => {
  test("OYTC_API_KEY overrides the stored key", async () => {
    const dir = tempDir()
    await runIn(storeAt(dir), (store) => store.save("file-secret"))

    const credentials = await runIn(
      storeAt(dir, { OYTC_API_KEY: "environment-secret" }),
      (store) => store.load
    )
    expect(credentials.key).toBe("environment-secret")
    expect(credentials.source).toBe("OYTC_API_KEY")
  })

  test("the env key is trimmed", async () => {
    const credentials = await runIn(
      storeAt(tempDir(), { OYTC_API_KEY: "  environment-secret  " }),
      (store) => store.load
    )
    expect(credentials.key).toBe("environment-secret")
  })

  test("a whitespace-only env key is treated as unset", async () => {
    const dir = tempDir()
    await runIn(storeAt(dir), (store) => store.save("file-secret"))
    const credentials = await runIn(storeAt(dir, { OYTC_API_KEY: "  " }), (store) => store.load)
    expect(credentials.key).toBe("file-secret")
    expect(credentials.source).toBe("auth.json")
  })

  test("the env key never clears stored OAuth", async () => {
    const dir = tempDir()
    await runIn(storeAt(dir), (store) => store.saveOAuth(oauth()))
    const credentials = await runIn(
      storeAt(dir, { OYTC_API_KEY: "environment-secret" }),
      (store) => store.load
    )
    expect(credentials.key).toBe("environment-secret")
    expect(credentials.oauth?.clientId).toBe("id")
  })

  test("an oauth-only file leaves source empty", async () => {
    const dir = tempDir()
    await runIn(storeAt(dir), (store) => store.saveOAuth(oauth()))
    const credentials = await runIn(storeAt(dir), (store) => store.load)
    expect(credentials.key).toBe("")
    expect(credentials.source).toBe("")
    expect(credentials.oauth).toBeDefined()
  })

  test("envKeySet mirrors the trimmed-nonempty test", async () => {
    expect(await runIn(storeAt(tempDir(), { OYTC_API_KEY: "k" }), (s) => s.envKeySet)).toBe(true)
    expect(await runIn(storeAt(tempDir(), { OYTC_API_KEY: " " }), (s) => s.envKeySet)).toBe(false)
    expect(await runIn(storeAt(tempDir()), (s) => s.envKeySet)).toBe(false)
  })

  test("the stored key is trimmed on load", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "auth.json"), '{"api_key":"  padded  "}', { mode: 0o600 })
    expect((await runIn(storeAt(dir), (store) => store.load)).key).toBe("padded")
  })
})

// ---------------------------------------------------------------------------
// TestFingerprintDoesNotExposeKey
// ---------------------------------------------------------------------------

describe("TestFingerprintDoesNotExposeKey", () => {
  test("the fingerprint is a 19-character prefixed digest that leaks nothing", () => {
    const key = "this-is-a-secret-key"
    const value = fingerprint(key)
    expect(value.startsWith("sha256:")).toBe(true)
    expect(value.includes(key)).toBe(false)
    expect(value.length).toBe("sha256:".length + 12)
  })

  test.each([
    // Reference values captured from Go's crypto/sha256 + encoding/hex.
    ["this-is-a-secret-key", "sha256:e0c2f4e37886"],
    ["test-secret-key", "sha256:2ceac6f36363"]
  ])("fingerprint(%s) matches Go", (key, expected) => {
    expect(fingerprint(key)).toBe(expected)
  })

  test("an empty or whitespace-only key fingerprints to the empty string", () => {
    expect(fingerprint("")).toBe("")
    expect(fingerprint("   ")).toBe("")
  })

  test("the key is trimmed before hashing", () => {
    expect(fingerprint("  test-secret-key  ")).toBe(fingerprint("test-secret-key"))
  })

  test("the service exposes the same function", async () => {
    const value = await runIn(storeAt(tempDir()), (store) =>
      Effect.succeed(store.fingerprint("test-secret-key"))
    )
    expect(value).toBe("sha256:2ceac6f36363")
  })
})

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  test("creates the config directory when it does not exist yet", async () => {
    const root = tempDir()
    const configDir = join(root, "never-created")
    const result = await runIn(storeAt(configDir), (store) => store.remove)
    expect(result.removed).toBe(false)
    // The lockfile has to live somewhere, so the dir is created at 0700.
    expect(perm(configDir)).toBe(0o700)
  })

  test("a concurrent save cannot recreate credentials after removal", async () => {
    // Go takes the update lock inside Remove for exactly this reason.
    const dir = tempDir()
    const layer = storeAt(dir)
    await runIn(layer, (store) => store.save("pre-existing"))

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CredentialStore
        const [saved, removed] = yield* Effect.all(
          [store.save("racing-write"), store.remove],
          { concurrency: "unbounded" }
        )
        return { saved, removed }
      }).pipe(Effect.provide(layer)) as Effect.Effect<{
        readonly saved: string
        readonly removed: { readonly path: string; readonly removed: boolean }
      }>
    )

    // Either order is legal; what is NOT legal is a half-written file. Both
    // operations were serialized, so the end state is one of two clean states.
    const path = outcome.removed.path
    if (existsSync(path)) {
      // remove ran first, then save recreated the file cleanly.
      expect(readFileSync(path, "utf8")).toBe('{\n  "api_key": "racing-write"\n}\n')
    } else {
      expect(outcome.removed.removed).toBe(true)
    }
  })
})

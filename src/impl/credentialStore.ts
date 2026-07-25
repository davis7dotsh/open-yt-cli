/**
 * Config directory resolution and credential storage — Go's `internal/config`.
 *
 * Three behaviors carry real weight and are called out where they are
 * implemented:
 *
 *   - `load` treats a CORRUPT auth.json as recoverable when `OYTC_API_KEY` is
 *     set. A broken file must never lock a user out of the higher-precedence
 *     env key. Every *mutating* path keeps the strict behavior: silently
 *     rewriting a file you failed to parse would destroy credentials.
 *   - Every mutation is a lock -> read -> mutate -> atomic-write cycle. The
 *     atomic rename alone is not enough: two concurrent updates would each read
 *     the old file and the later rename would silently drop the earlier one.
 *   - `saveRefreshedOAuth` is a compare-and-swap over all six OAuth fields. A
 *     token refresh that started before a `logout` must not resurrect the
 *     credentials the user just deleted.
 */

import { Effect, FileSystem, Layer, Option, Path, Result } from "effect"
import { createHash } from "node:crypto"
import { OperationalError } from "../domain/errors.ts"
import { parseJson } from "../json/parse.ts"
import {
  cloneOAuth,
  decodeAuthFile,
  emptyAuthFile,
  encodeAuthFile,
  sameOAuth,
  type AuthFile,
  type AuthOAuth
} from "../schema/authfile.ts"
import {
  CredentialStore,
  FileLock,
  ProcessEnv,
  type CredentialStoreShape,
  type Credentials,
  type StoredOAuth
} from "../services/index.ts"
import { atomicWriteSecure, ensureSecureDirectory } from "./atomicWrite.ts"

const ENV_KEY = "OYTC_API_KEY"
const ENV_CONFIG_DIR = "OYTC_CONFIG_DIR"
const ENV_OAUTH_CLIENT_ID = "OYTC_OAUTH_CLIENT_ID"
const ENV_OAUTH_CLIENT_SECRET = "OYTC_OAUTH_CLIENT_SECRET"
const ENV_XDG_CONFIG_HOME = "XDG_CONFIG_HOME"
const ENV_APPDATA = "APPDATA"

const AUTH_FILE = "auth.json"
const LOCK_FILE = ".auth.lock"

/** Go's `strings.TrimSpace`, which trims Unicode whitespace on both ends. */
const trimSpace = (value: string): string => value.trim()

/** `os.Getenv`: an unset variable and an empty one are indistinguishable. */
const getenv = (env: Option.Option<string>): string => Option.getOrElse(env, () => "")

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof (error as { readonly reason: unknown }).reason === "object" &&
  (error as { readonly reason: { readonly _tag?: unknown } }).reason?._tag === "NotFound"

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// ---------------------------------------------------------------------------
// StoredOAuth <-> AuthOAuth
// ---------------------------------------------------------------------------

/**
 * The service contract flattens Go's nil-vs-empty scope slice to a plain array.
 * That loses nothing: Go's `cloneOAuth` runs `append([]string(nil), s...)`,
 * which returns nil for an empty input, so Go can never *write* `[]` either —
 * both directions collapse to `null` on disk.
 */
const toStored = (oauth: AuthOAuth): StoredOAuth => ({
  clientId: oauth.clientId,
  clientSecret: oauth.clientSecret,
  accessToken: oauth.accessToken,
  refreshToken: oauth.refreshToken,
  expiry: oauth.expiry,
  scopes: oauth.scopes === undefined ? [] : [...oauth.scopes]
})

const fromStored = (oauth: StoredOAuth): AuthOAuth => ({
  clientId: oauth.clientId,
  clientSecret: oauth.clientSecret,
  accessToken: oauth.accessToken,
  refreshToken: oauth.refreshToken,
  expiry: oauth.expiry,
  scopes: oauth.scopes.length === 0 ? undefined : [...oauth.scopes]
})

/** Go's `normalizeOAuth`: trim the five strings, then two validity rules. */
const normalizeOAuth = (
  oauth: StoredOAuth
): Effect.Effect<AuthOAuth, OperationalError> => {
  const normalized: AuthOAuth = {
    clientId: trimSpace(oauth.clientId),
    clientSecret: trimSpace(oauth.clientSecret),
    accessToken: trimSpace(oauth.accessToken),
    refreshToken: trimSpace(oauth.refreshToken),
    expiry: trimSpace(oauth.expiry),
    // Scopes are neither validated nor normalized.
    scopes: oauth.scopes.length === 0 ? undefined : [...oauth.scopes]
  }
  if (normalized.clientId === "" || normalized.clientSecret === "") {
    return Effect.fail(
      new OperationalError({ message: "OAuth client ID and client secret cannot be empty" })
    )
  }
  if (normalized.accessToken === "" && normalized.refreshToken === "") {
    return Effect.fail(
      new OperationalError({ message: "OAuth access token or refresh token is required" })
    )
  }
  return Effect.succeed(cloneOAuth(normalized))
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** `"sha256:" + hex(sha256(key)).slice(0, 12)`; `""` for an empty key. */
export const fingerprint = (key: string): string => {
  const trimmed = trimSpace(key)
  if (trimmed === "") return ""
  return `sha256:${createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const makeCredentialStore: Effect.Effect<
  CredentialStoreShape,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | (typeof ProcessEnv)["Identifier"]
  | (typeof FileLock)["Identifier"]
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processEnv = yield* ProcessEnv
  const lock = yield* FileLock

  const env = (name: string): string => getenv(processEnv.env(name))

  const homeDir = processEnv.homeDir.pipe(
    Effect.catch((cause) =>
      Effect.fail(
        new OperationalError({
          message: `determine config directory: ${cause.message}`,
          cause
        })
      )
    )
  )

  /**
   * Go's `expandHome`, applied ONLY to `OYTC_CONFIG_DIR`. Expands exactly `~`,
   * `~/…`, or `~\…` (backslash for Windows). `~user` is NOT supported: it
   * starts with neither prefix, so it is returned untouched. An unresolvable
   * home also returns the path unchanged.
   */
  const expandHome = (value: string): Effect.Effect<string> => {
    if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) {
      return Effect.succeed(value)
    }
    return homeDir.pipe(
      Effect.map((home) => (value.length === 1 ? home : path.join(home, value.slice(2)))),
      Effect.catchCause(() => Effect.succeed(value))
    )
  }

  const dir: Effect.Effect<string, OperationalError> = Effect.gen(function* () {
    // The override IS the directory: no "oytc" component is appended.
    const override = trimSpace(env(ENV_CONFIG_DIR))
    if (override !== "") return yield* expandHome(override)

    if (processEnv.platform === "darwin") {
      const home = yield* homeDir
      return path.join(home, "Library", "Application Support", "oytc")
    }

    if (processEnv.platform === "win32") {
      const appData = env(ENV_APPDATA)
      if (appData === "") {
        return yield* Effect.fail(
          new OperationalError({ message: "determine config directory: APPDATA is not set" })
        )
      }
      return path.join(appData, "oytc")
    }

    // NOT trimmed — only an exactly-empty XDG_CONFIG_HOME counts as unset.
    const xdg = env(ENV_XDG_CONFIG_HOME)
    const base = xdg !== "" ? xdg : path.join(yield* homeDir, ".config")
    return path.join(base, "oytc")
  })

  const filePath: Effect.Effect<string, OperationalError> = Effect.map(dir, (d) =>
    path.join(d, AUTH_FILE)
  )

  const lockPathFor = (authPath: string): string =>
    path.join(path.dirname(authPath), LOCK_FILE)

  /**
   * Read + parse `auth.json`. A missing file is `exists: false` with no error;
   * a read or parse failure is an error carrying Go's message prefix.
   */
  interface LoadedFile {
    readonly file: AuthFile
    readonly exists: boolean
  }

  const loadFile = (authPath: string): Effect.Effect<LoadedFile, OperationalError> =>
    Effect.gen(function* () {
      const text: string | undefined = yield* fs.readFileString(authPath).pipe(
        Effect.catch((cause) =>
          isNotFound(cause)
            ? Effect.succeed(undefined)
            : Effect.fail(
                new OperationalError({ message: `read credentials: ${errorText(cause)}`, cause })
              )
        )
      )
      if (text === undefined) return { file: emptyAuthFile, exists: false }

      const parsed = parseJson(text)
      if (Result.isFailure(parsed)) {
        return yield* Effect.fail(
          new OperationalError({ message: `parse credentials: ${parsed.failure.message}` })
        )
      }
      const decoded = decodeAuthFile(parsed.success)
      if (Result.isFailure(decoded)) {
        return yield* Effect.fail(
          new OperationalError({ message: `parse credentials: ${decoded.failure.message}` })
        )
      }
      return { file: decoded.success, exists: true }
    })

  const saveFile = (
    authPath: string,
    file: AuthFile
  ): Effect.Effect<string, OperationalError> =>
    atomicWriteSecure(fs, path, authPath, encodeAuthFile(file))

  /**
   * lock -> read -> mutate -> atomic write. The lock spans the whole cycle;
   * dropping it between the read and the write is exactly the race that loses
   * a concurrent update.
   */
  const updateFile = (
    mutate: (file: AuthFile) => AuthFile
  ): Effect.Effect<string, OperationalError> =>
    Effect.gen(function* () {
      const authPath = yield* filePath
      return yield* lock.withLock(
        lockPathFor(authPath),
        Effect.gen(function* () {
          // Deliberately strict: a parse failure aborts rather than falling
          // back, so a mutation never silently discards an unreadable file.
          const { file } = yield* loadFile(authPath)
          return yield* saveFile(authPath, mutate(file))
        })
      )
    })

  const load: Effect.Effect<Credentials, OperationalError> = Effect.gen(function* () {
    const authPath = yield* filePath
    const envKey = trimSpace(env(ENV_KEY))

    const loaded = yield* Effect.result(loadFile(authPath))
    if (Result.isFailure(loaded)) {
      // A corrupt auth.json must not block the higher-precedence env key.
      if (envKey !== "") {
        const fallback: Credentials = {
          key: envKey,
          source: "OYTC_API_KEY",
          oauth: undefined,
          path: authPath
        }
        return fallback
      }
      return yield* Effect.fail(loaded.failure)
    }

    const { file, exists } = loaded.success
    let key = ""
    let source: Credentials["source"] = ""
    let oauth: StoredOAuth | undefined

    if (exists) {
      key = trimSpace(file.apiKey)
      oauth = file.oauth === undefined ? undefined : toStored(cloneOAuth(file.oauth))
      if (key !== "") source = "auth.json"
    }
    if (envKey !== "") {
      key = envKey
      source = "OYTC_API_KEY"
    }
    // Note the env key never clears stored OAuth: both are returned together.
    const credentials: Credentials = { key, source, oauth, path: authPath }
    return credentials
  })

  const save = (key: string): Effect.Effect<string, OperationalError> => {
    const trimmed = trimSpace(key)
    if (trimmed === "") {
      return Effect.fail(new OperationalError({ message: "API key cannot be empty" }))
    }
    return updateFile((file) => ({ ...file, apiKey: trimmed }))
  }

  const saveOAuth = (credentials: StoredOAuth): Effect.Effect<string, OperationalError> =>
    Effect.flatMap(normalizeOAuth(credentials), (normalized) =>
      updateFile((file) => ({ ...file, oauth: cloneOAuth(normalized) }))
    )

  const saveRefreshedOAuth = (
    expected: StoredOAuth | undefined,
    next: StoredOAuth
  ): Effect.Effect<boolean, OperationalError> =>
    Effect.gen(function* () {
      const normalized = yield* normalizeOAuth(next)
      const authPath = yield* filePath
      const expectedOAuth = expected === undefined ? undefined : fromStored(expected)

      return yield* lock.withLock(
        lockPathFor(authPath),
        Effect.gen(function* () {
          const { file } = yield* loadFile(authPath)
          // Compare-and-swap. A mismatch — including a file removed by a
          // concurrent `logout` — writes NOTHING and reports false, not an
          // error. This is what stops a refresh from resurrecting credentials.
          if (!sameOAuth(file.oauth, expectedOAuth)) return false
          yield* saveFile(authPath, { apiKey: file.apiKey, oauth: cloneOAuth(normalized) })
          return true
        })
      )
    })

  const clearOAuth: Effect.Effect<string, OperationalError> = updateFile((file) => ({
    ...file,
    oauth: undefined
  }))

  interface RemoveResult {
    readonly path: string
    readonly removed: boolean
  }

  const remove: Effect.Effect<RemoveResult, OperationalError> = Effect.gen(function* () {
    const authPath = yield* filePath
    const lockPath = lockPathFor(authPath)
    // The lockfile lives in the config dir, so the dir has to exist before the
    // lock can be taken even when there is nothing to remove.
    yield* ensureSecureDirectory(fs, path.dirname(authPath))

    // Taking the same lock as saves is deliberate: a concurrent save that has
    // already read the file must not be able to recreate it after removal.
    return yield* lock.withLock(
      lockPath,
      fs.remove(authPath).pipe(
        Effect.as<RemoveResult>({ path: authPath, removed: true }),
        Effect.catch((cause) =>
          isNotFound(cause)
            ? Effect.succeed<RemoveResult>({ path: authPath, removed: false })
            : Effect.fail(
                new OperationalError({
                  message: `remove credentials: ${errorText(cause)}`,
                  cause
                })
              )
        )
      )
    )
  })

  const envKeySet: Effect.Effect<boolean> = Effect.sync(() => trimSpace(env(ENV_KEY)) !== "")

  const oauthBootstrap: Effect.Effect<readonly [clientId: string, clientSecret: string]> =
    Effect.sync(
      () =>
        [trimSpace(env(ENV_OAUTH_CLIENT_ID)), trimSpace(env(ENV_OAUTH_CLIENT_SECRET))] as const
    )

  return {
    dir,
    path: filePath,
    load,
    save,
    saveOAuth,
    saveRefreshedOAuth,
    clearOAuth,
    remove,
    fingerprint,
    envKeySet,
    oauthBootstrap
  }
})

export const CredentialStoreLive = Layer.effect(CredentialStore, makeCredentialStore)

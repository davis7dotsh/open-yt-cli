/**
 * Service tags and interfaces — THE CONTRACT.
 *
 * Every implementation package codes against these signatures. Bodies live in
 * `src/impl/`; nothing in this file has an implementation. Signatures are
 * frozen once the foundation lands: changing one invalidates work in flight
 * across every parallel package.
 */

import type { Effect, Option, Redacted } from "effect"
import { Context } from "effect"
import type { ListResult, PageOptions } from "../domain/listResult.ts"
import type {
  ApiError,
  MissingKeyError,
  MissingOAuthError,
  OAuthError,
  OperationalError,
  OytcError
} from "../domain/errors.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import type { AnalyticsResponse } from "../schema/analytics.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"

/** Query parameters as ordered pairs; the client sorts them at encode time. */
export type Params = ReadonlyArray<readonly [string, string]>

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface HttpCoreRequest {
  readonly baseUrl: string
  /** May contain a slash, e.g. "liveChat/messages". */
  readonly resource: string
  readonly params: Params
  /** When true, attach OAuth bearer or API key; OAuth strictly wins. */
  readonly authenticate: boolean
}

export interface HttpCoreShape {
  readonly getJson: (
    request: HttpCoreRequest
  ) => Effect.Effect<JsonValue, ApiError | OperationalError | MissingKeyError | MissingOAuthError>
}

export const HttpCore = Context.Service<HttpCoreShape>("oytc/HttpCore")

// ---------------------------------------------------------------------------
// YouTube Data API
// ---------------------------------------------------------------------------

export interface ResolvedChannel {
  readonly id: string
  readonly requests: number
}

export interface YouTubeApiShape {
  readonly get: (resource: string, params: Params) => Effect.Effect<DataApiResponse, OytcError>
  readonly list: (
    resource: string,
    params: Params,
    options: PageOptions
  ) => Effect.Effect<ListResult, OytcError>
  /** Accepts a UC… id, an @handle, or a channel URL. */
  readonly resolveChannel: (reference: string) => Effect.Effect<ResolvedChannel, OytcError>
}

export const YouTubeApi = Context.Service<YouTubeApiShape>("oytc/YouTubeApi")

// ---------------------------------------------------------------------------
// YouTube Analytics API
// ---------------------------------------------------------------------------

export interface AnalyticsQuery {
  readonly metrics: string
  readonly dimensions: string
  readonly filters: string
  readonly sort: string
  readonly startDate: string
  readonly endDate: string
  readonly limit: number
  readonly startIndex: number
}

export interface AnalyticsApiShape {
  readonly report: (query: AnalyticsQuery) => Effect.Effect<AnalyticsResponse, OytcError>
  /** Column headers + rows flattened into objects, short rows padded with null. */
  readonly normalize: (response: AnalyticsResponse) => ReadonlyArray<JsonObject>
}

export const AnalyticsApi = Context.Service<AnalyticsApiShape>("oytc/AnalyticsApi")

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface StoredOAuth {
  readonly clientId: string
  readonly clientSecret: string
  readonly accessToken: string
  readonly refreshToken: string
  /** RFC3339 UTC, or "" when unset. */
  readonly expiry: string
  readonly scopes: ReadonlyArray<string>
}

export type CredentialSource = "" | "auth.json" | "OYTC_API_KEY"

export interface Credentials {
  readonly key: string
  readonly source: CredentialSource
  readonly oauth: StoredOAuth | undefined
  readonly path: string
}

export interface CredentialStoreShape {
  readonly dir: Effect.Effect<string, OperationalError>
  readonly path: Effect.Effect<string, OperationalError>
  readonly load: Effect.Effect<Credentials, OperationalError>
  readonly save: (key: string) => Effect.Effect<string, OytcError>
  readonly saveOAuth: (credentials: StoredOAuth) => Effect.Effect<string, OytcError>
  /**
   * Compare-and-swap. Returns false — writing nothing, failing nothing — when
   * the stored block no longer matches `expected`, so a token refresh racing a
   * `logout` cannot resurrect removed credentials.
   */
  readonly saveRefreshedOAuth: (
    expected: StoredOAuth | undefined,
    next: StoredOAuth
  ) => Effect.Effect<boolean, OytcError>
  readonly clearOAuth: Effect.Effect<string, OytcError>
  readonly remove: Effect.Effect<
    { readonly path: string; readonly removed: boolean },
    OperationalError
  >
  /** "sha256:" + first 12 hex chars of sha256(key). */
  readonly fingerprint: (key: string) => string
  readonly envKeySet: Effect.Effect<boolean>
  readonly oauthBootstrap: Effect.Effect<
    readonly [clientId: string, clientSecret: string]
  >
}

export const CredentialStore = Context.Service<CredentialStoreShape>("oytc/CredentialStore")

// ---------------------------------------------------------------------------
// Cross-process locking
// ---------------------------------------------------------------------------

export interface FileLockShape {
  /** Blocking and cross-process; held across an entire read-modify-write. */
  readonly withLock: <A, E, R>(
    lockPath: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | OperationalError, R>
}

export const FileLock = Context.Service<FileLockShape>("oytc/FileLock")

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface OAuthLoginRequest {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
}

export interface OAuthServiceShape {
  readonly login: (
    request: OAuthLoginRequest
  ) => Effect.Effect<StoredOAuth, OAuthError | OperationalError>
  readonly refresh: (
    credentials: StoredOAuth
  ) => Effect.Effect<StoredOAuth, OAuthError | OperationalError>
  /** Best-effort; a failure is a warning, never fatal. */
  readonly revoke: (credentials: StoredOAuth) => Effect.Effect<void, never>
  /**
   * Current access token, refreshing when within the skew window.
   * `force` bypasses the cache after a 401.
   */
  readonly tokenSource: (
    force: boolean
  ) => Effect.Effect<Redacted.Redacted<string>, OAuthError | OperationalError | MissingOAuthError>
}

export const OAuthService = Context.Service<OAuthServiceShape>("oytc/OAuthService")

// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  readonly checkOnly: boolean
  readonly targetVersion: string
}

export interface UpdateResult {
  readonly currentVersion: string
  readonly latestVersion: string
  readonly updated: boolean
  readonly asset: string
  readonly executable: string
}

export interface UpdaterShape {
  readonly run: (options: UpdateOptions) => Effect.Effect<UpdateResult, OytcError>
}

export const Updater = Context.Service<UpdaterShape>("oytc/Updater")

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillInstallResult {
  readonly path: string
  readonly files: ReadonlyArray<string>
}

export interface SkillInstallerShape {
  readonly defaultPath: Effect.Effect<string, OperationalError>
  readonly install: (target: string) => Effect.Effect<SkillInstallResult, OytcError>
}

export const SkillInstaller = Context.Service<SkillInstallerShape>("oytc/SkillInstaller")

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type OutputFormat = "table" | "json" | "jsonl" | "tsv"

export interface RenderOptions {
  readonly format: OutputFormat
  readonly columns: ReadonlyArray<string>
  readonly noHeader: boolean
}

export interface RendererShape {
  readonly render: (result: ListResult, options: RenderOptions) => Effect.Effect<void, OytcError>
  /** A bare object with no list envelope (status, version, update). */
  readonly renderObject: (
    object: JsonObject,
    options: RenderOptions
  ) => Effect.Effect<void, OytcError>
}

export const Renderer = Context.Service<RendererShape>("oytc/Renderer")

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export interface PromptsShape {
  readonly readLine: (prompt: string) => Effect.Effect<string, OperationalError>
  /** Must work when stdin is a pipe; `secret-manager | oytc login` is documented. */
  readonly readSecret: (
    prompt: string
  ) => Effect.Effect<Redacted.Redacted<string>, OperationalError>
  readonly confirm: (block: string) => Effect.Effect<boolean, OperationalError>
}

export const Prompts = Context.Service<PromptsShape>("oytc/Prompts")

export interface BrowserOpenerShape {
  readonly open: (url: string) => Effect.Effect<void, never>
}

export const BrowserOpener = Context.Service<BrowserOpenerShape>("oytc/BrowserOpener")

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface VersionDetails {
  readonly version: string
  readonly commit: string
  readonly date: string
  /** Retained as a documented JSON column; carries the Bun version. */
  readonly goVersion: string
  readonly os: string
  readonly arch: string
}

export interface VersionInfoShape {
  readonly get: Effect.Effect<VersionDetails>
}

export const VersionInfo = Context.Service<VersionInfoShape>("oytc/VersionInfo")

export interface ProcessEnvShape {
  readonly env: (name: string) => Option.Option<string>
  readonly platform: string
  readonly arch: string
  readonly argv: ReadonlyArray<string>
  readonly executablePath: Effect.Effect<string, OperationalError>
  readonly isOutputTTY: boolean
  readonly homeDir: Effect.Effect<string, OperationalError>
}

export const ProcessEnv = Context.Service<ProcessEnvShape>("oytc/ProcessEnv")

/** Resolved global flags, provided per invocation rather than in AppLayer. */
export interface AppOptionsShape {
  readonly format: OutputFormat
  readonly columns: ReadonlyArray<string>
  readonly noHeader: boolean
  readonly quiet: boolean
  readonly timeoutMillis: number
  readonly isOutputTTY: boolean
}

export const AppOptions = Context.Service<AppOptionsShape>("oytc/AppOptions")

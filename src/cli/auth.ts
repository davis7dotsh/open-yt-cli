/**
 * `login`, `status`, `logout` — the port of `internal/cli/auth.go`.
 *
 * ## The redaction contract (DEVIATIONS.md G2)
 *
 * `status` renders EXACTLY these fields and nothing else, in every format,
 * with and without `--check`:
 *
 *     path
 *     api_key.configured, api_key.source, api_key.fingerprint [, api_key.valid]
 *     oauth.configured, oauth.client_id, oauth.scopes, oauth.expiry [, oauth.valid]
 *
 * The access token, the refresh token and the client secret are loaded into
 * memory (they live on the same `StoredOAuth` record) and must never reach the
 * state object. This is a security property, not a formatting preference; the
 * test suite asserts the absence of distinctive fixture values in all four
 * formats rather than asserting the presence of the allowed ones.
 *
 * ## G1 — `status` scopes render WITH brackets in table/tsv
 *
 * `internal/output/output.go:cell()` comma-joins a `[]any`, which is what a
 * list result's items decode to. But `status` renders a typed Go struct whose
 * `scopes` field is `[]string` — a different dynamic type — so the `[]any`
 * case does not match and it falls through to `default: json.Marshal`:
 *
 *     oytc status --format tsv
 *     … OAUTH.SCOPES …
 *     … ["https://www.googleapis.com/auth/youtube.readonly"] …
 *
 * and a nil scope slice renders as the literal `null`, not as an empty cell.
 * Verified against the binary. The TS port has no static types at that
 * boundary — everything is `JsonValue` — so `cell()` would comma-join here and
 * silently diverge. The fix is local: for the row-based formats the scopes
 * value is PRE-ENCODED into its JSON text, so `cell()` sees a string and emits
 * it verbatim. `json`/`jsonl` keep the real array, because Go's marshaller
 * produced a real array there.
 *
 * ## `--check` renders before it fails
 *
 * Full stdout is written first and the non-zero exit follows. That ordering is
 * deliberate in Go (DEVIATIONS "everything else stays parity") and scripts
 * depend on it: `oytc status --check --format json | jq .oauth.valid` works
 * even when the command exits 3. Both credentials are also validated even when
 * the first one fails, so a stale API key cannot mask a working OAuth grant.
 */

import { Effect, Option, Redacted, Result, Stdio, Stream } from "effect"
import { Command, Flag, HttpClient } from "../effect.ts"
import {
  ApiError,
  AuthHintError,
  MissingKeyError,
  OperationalError,
  UsageError,
  type AuthHintPrefix,
  type OytcError
} from "../domain/errors.ts"
import { encodeGoValue } from "../json/encode.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { statusCheckDateRange } from "../impl/analyticsApi.ts"
import { makeHttpCore } from "../impl/httpCore.ts"
import { makeYouTubeApi } from "../impl/youtubeApi.ts"
import { statusCheckColumns, statusColumns } from "../output/columns.ts"
import {
  AnalyticsApi,
  AppOptions,
  CredentialStore,
  HttpCore,
  OAuthService,
  Prompts,
  Renderer,
  YouTubeApi,
  type AnalyticsApiShape,
  type Credentials,
  type StoredOAuth,
  type YouTubeApiShape
} from "../services/index.ts"

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

const write = (
  pick: "stdout" | "stderr",
  text: string
): Effect.Effect<void, OperationalError, Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const sink = pick === "stdout" ? stdio.stdout() : stdio.stderr()
    yield* Stream.run(Stream.make(text), sink).pipe(
      Effect.catch((cause) =>
        Effect.fail(new OperationalError({ message: "could not write output", cause }))
      )
    )
  })

const writeOut = (text: string) => write("stdout", text)
const writeErr = (text: string) => write("stderr", text)

// ---------------------------------------------------------------------------
// Shared auth helpers
// ---------------------------------------------------------------------------

/** Go's `valueOr(value, fallback)`: the fallback only for the empty string. */
export const valueOr = (value: string, fallback: string): string =>
  value === "" ? fallback : value

/**
 * Go's `oauthAuthHint`.
 *
 * Turns three specific upstream failures into an actionable re-login message
 * while preserving the cause, so the exit code stays 3 and the original text
 * still appears after the colon. Note the asymmetry preserved from Go: the
 * `invalid_grant` test is a case-INSENSITIVE substring of the whole rendered
 * message, while `insufficientPermissions` is matched case-insensitively
 * against each structured reason.
 */
export const oauthAuthHint = (error: OytcError): OytcError => {
  const hint = (prefix: AuthHintPrefix): AuthHintError => new AuthHintError({ prefix, cause: error })

  if (error.message.toLowerCase().includes("invalid_grant")) {
    return hint("OAuth authorization failed; re-run 'oytc login --oauth'")
  }
  if (!(error instanceof ApiError)) return error
  if (error.httpStatus === 401) {
    return hint("OAuth authorization failed; re-run 'oytc login --oauth'")
  }
  for (const reason of error.reasons) {
    if (reason.toLowerCase() === "insufficientpermissions") {
      return hint("OAuth scopes are insufficient; re-run 'oytc login --oauth'")
    }
  }
  return error
}

/**
 * A `YouTubeApi` bound to ONE API key, ignoring any stored OAuth.
 *
 * Go built `a.client(key)` for the `login` probe and the `status --check`
 * key probe, which sends `X-Goog-Api-Key` and no bearer token. The ambient
 * `YouTubeApi` cannot stand in: its `HttpCore` attaches OAuth strictly ahead of
 * the key whenever OAuth is stored, so with both credentials present the "API
 * key check" would actually exercise OAuth — precisely the masking Go's
 * comment says must not happen.
 *
 * `HttpClient` is not exported by `AppLayer` today, so this degrades rather
 * than fails: when the service is absent the ambient `YouTubeApi` is used and
 * the probe is merely less precise. Adding `HttpClient` to `AppLayer`'s
 * exports activates the exact path with no change here.
 */
const keyScopedApi = (key: string, timeoutMillis: number) =>
  Effect.gen(function* () {
    const client = yield* Effect.serviceOption(HttpClient.HttpClient)
    if (Option.isNone(client)) return yield* YouTubeApi
    const core = yield* makeHttpCore({
      apiKey: key,
      tokenSource: undefined,
      timeoutMillis
    }).pipe(Effect.provideService(HttpClient.HttpClient, client.value))
    return yield* makeYouTubeApi().pipe(Effect.provideService(HttpCore, core))
  })

/** The cheapest quota-1 probe Go used to validate an API key. */
const probeApiKey = (
  key: string,
  timeoutMillis: number
): Effect.Effect<void, OytcError, YouTubeApiShape> =>
  Effect.gen(function* () {
    const api = yield* keyScopedApi(key, timeoutMillis)
    yield* api.get("i18nLanguages", [["part", "snippet"]])
  })

/**
 * `App.checkOAuth`: a liveness probe against the Analytics API, which is the
 * service the analytics commands actually need. The window INCLUDES today,
 * unlike the analytics flag defaults — it is a probe, not a report.
 */
const probeOAuth = (now: Date): Effect.Effect<void, OytcError, AnalyticsApiShape> =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsApi
    const range = statusCheckDateRange(now)
    yield* analytics
      .report({
        metrics: "views",
        dimensions: "",
        filters: "",
        sort: "",
        startDate: range.start,
        endDate: range.end,
        limit: 1,
        startIndex: 0
      })
      .pipe(Effect.mapError(oauthAuthHint))
  })

// ---------------------------------------------------------------------------
// status: state assembly
// ---------------------------------------------------------------------------

export interface StatusChecks {
  /** `undefined` = not checked; `null` = checked and valid; else the failure. */
  readonly key: OytcError | null | undefined
  readonly oauth: OytcError | null | undefined
}

/**
 * Encode `scopes` for the target format.
 *
 * G1: `json`/`jsonl` get the real array (or `null` for a nil slice), while
 * `table`/`tsv` get the JSON TEXT of that value, because Go reached those cells
 * through `json.Marshal` rather than through the array-joining branch.
 */
export const encodeScopes = (
  scopes: ReadonlyArray<string>,
  rowFormat: boolean
): JsonValue => {
  // credentialStore normalizes Go's nil slice to `[]`; Go marshalled nil as
  // `null`, and an empty-but-non-nil slice is unreachable through `cloneOAuth`.
  const value: JsonValue = scopes.length === 0 ? null : [...scopes]
  return rowFormat ? encodeGoValue(value, { indent: "" }) : value
}

/** The whole `status` state object, and the ONLY place secrets could leak. */
export const statusState = (
  credentials: Credentials,
  checks: StatusChecks,
  rowFormat: boolean
): JsonObject => {
  const keyConfigured = credentials.key !== ""
  const oauth = credentials.oauth

  const apiKey: Record<string, JsonValue> = {
    configured: keyConfigured,
    source: valueOr(credentials.source, "none")
  }
  if (keyConfigured) apiKey["fingerprint"] = fingerprintPlaceholder
  if (checks.key !== undefined) apiKey["valid"] = checks.key === null

  const oauthState: Record<string, JsonValue> =
    oauth === undefined
      ? { configured: false }
      : {
          configured: true,
          client_id: oauth.clientId,
          scopes: encodeScopes(oauth.scopes, rowFormat),
          expiry: oauth.expiry
        }
  if (oauth !== undefined && checks.oauth !== undefined) {
    oauthState["valid"] = checks.oauth === null
  }

  return { path: credentials.path, api_key: apiKey, oauth: oauthState }
}

/**
 * Sentinel replaced by the caller, which owns the `CredentialStore` needed to
 * compute a fingerprint. Keeping `statusState` pure makes it directly testable
 * against the redaction contract.
 */
const fingerprintPlaceholder = " fingerprint "

const withFingerprint = (state: JsonObject, fingerprint: string): JsonObject => {
  const apiKey = state["api_key"] as Record<string, JsonValue>
  if (apiKey["fingerprint"] !== fingerprintPlaceholder) return state
  return { ...state, api_key: { ...apiKey, fingerprint } }
}

/** Go's `checkVerdict`. */
export const checkVerdict = (error: OytcError | null): string =>
  error === null ? "valid" : `invalid (${error.message})`

/** The human `table` rendering, byte-for-byte. */
export const statusTableText = (credentials: Credentials, checks: StatusChecks): string => {
  const keyConfigured = credentials.key !== ""
  const oauth = credentials.oauth
  let out =
    `Path: ${credentials.path}\n` +
    `API key configured: ${keyConfigured}\n` +
    `API key source: ${valueOr(credentials.source, "none")}\n`
  if (keyConfigured) out += `API key fingerprint: ${fingerprintPlaceholder}\n`
  out += `OAuth configured: ${oauth !== undefined}\n`
  if (oauth !== undefined) {
    out +=
      `OAuth client ID: ${oauth.clientId}\n` +
      // The table path joins with ", " — this is `strings.Join`, NOT `cell()`,
      // so G1's bracket rendering does not apply here.
      `OAuth scopes: ${oauth.scopes.join(", ")}\n` +
      `OAuth token expiry: ${valueOr(oauth.expiry, "unknown")}\n`
  }
  if (checks.key !== undefined && keyConfigured) {
    out += `API key remote check: ${checkVerdict(checks.key)}\n`
  }
  if (checks.oauth !== undefined && oauth !== undefined) {
    out += `OAuth remote check: ${checkVerdict(checks.oauth)}\n`
  }
  return out
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

const loginApiKey = Effect.gen(function* () {
  const prompts = yield* Prompts
  const store = yield* CredentialStore
  const options = yield* AppOptions

  // `readSecret` owns the prompt AND the trailing newline, matching Go's
  // Fprint-then-ReadSecret-then-Fprintln sequence on stderr.
  const secret = yield* prompts
    .readSecret("YouTube Data API key: ")
    .pipe(
      Effect.catch((error) =>
        Effect.fail(new OperationalError({ message: `read API key: ${error.message}`, cause: error }))
      )
    )
  const key = Redacted.value(secret).trim()
  if (key === "") return yield* Effect.fail(new UsageError({ message: "API key cannot be empty" }))

  yield* probeApiKey(key, options.timeoutMillis).pipe(
    Effect.mapError((error) =>
      // Go: fmt.Errorf("API key validation failed: %w", err). The wrapper is an
      // OperationalError, so a bad key exits 6 here where the bare ApiError
      // would have exited 3 — same as Go, whose exitCode() unwraps %w and DOES
      // still see the APIError. Preserve the code explicitly.
      new WrappedError({ prefix: "API key validation failed", cause: error })
    )
  )

  const path = yield* store.save(key)
  yield* writeOut(`API key validated and saved to ${path} (${store.fingerprint(key)})\n`)
  if (yield* store.envKeySet) {
    yield* writeOut("Note: OYTC_API_KEY remains the active, higher-precedence credential.\n")
  }
})

/**
 * `fmt.Errorf("%s: %w", prefix, cause)`.
 *
 * Go's `exitCode(err)` walks the `%w` chain with `errors.As`, so a wrapped
 * `APIError` still classified by its own rules. A plain `OperationalError`
 * wrapper would flatten every such failure to 6, so the wrapper forwards both
 * the message and the exit code of its cause.
 */
class WrappedError extends OperationalError {
  constructor(args: { readonly prefix: string; readonly cause: OytcError }) {
    super({ message: `${args.prefix}: ${args.cause.message}`, cause: args.cause })
  }
}

const loginOAuth = Effect.gen(function* () {
  const prompts = yield* Prompts
  const store = yield* CredentialStore
  const oauth = yield* OAuthService

  const [bootstrapId, bootstrapSecret] = yield* store.oauthBootstrap

  let clientId = bootstrapId
  if (clientId === "") {
    clientId = yield* prompts
      .readLine("OAuth client ID: ")
      .pipe(
        Effect.catch((error) =>
          Effect.fail(
            new OperationalError({
              message: `read OAuth client ID: ${error.message}`,
              cause: error
            })
          )
        )
      )
    clientId = clientId.trim()
  }

  let clientSecret = bootstrapSecret
  if (clientSecret === "") {
    const secret = yield* prompts
      .readSecret("OAuth client secret: ")
      .pipe(
        Effect.catch((error) =>
          Effect.fail(
            new OperationalError({
              message: `read OAuth client secret: ${error.message}`,
              cause: error
            })
          )
        )
      )
    clientSecret = Redacted.value(secret).trim()
  }

  if (clientId === "" || clientSecret === "") {
    return yield* Effect.fail(
      new UsageError({ message: "OAuth client ID and client secret cannot be empty" })
    )
  }

  const stored = yield* oauth
    .login({ clientId, clientSecret: Redacted.make(clientSecret) })
    .pipe(
      Effect.mapError((error) => new WrappedError({ prefix: "OAuth login failed", cause: error }))
    )

  const path = yield* store.saveOAuth(stored)
  yield* writeOut(
    `OAuth authorization saved to ${path}\nGranted scopes: ${stored.scopes.join(", ")}\n`
  )
})

export const loginCommand = Command.make(
  "login",
  {
    oauth: Flag.boolean("oauth").pipe(
      Flag.withDescription("authorize read-only access to your channel and Analytics")
    )
  },
  // A ternary between two Effects with DIFFERENT requirement sets produces a
  // union type that is not assignable to a single Effect; suspending inside a
  // gen block unifies both arms' R instead.
  ({ oauth }) =>
    Effect.gen(function* () {
      if (oauth) yield* loginOAuth
      else yield* loginApiKey
    })
).pipe(Command.withDescription("Validate and save an API key or read-only OAuth authorization"))

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export const statusCommand = Command.make(
  "status",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("validate configured credentials with the API")
    )
  },
  ({ check }) =>
    Effect.gen(function* () {
      const options = yield* AppOptions
      const store = yield* CredentialStore
      const credentials = yield* store.load

      const keyConfigured = credentials.key !== ""
      const oauthConfigured = credentials.oauth !== undefined

      let checks: StatusChecks = { key: undefined, oauth: undefined }
      if (check) {
        // Nothing to validate: fail BEFORE any output, as Go did.
        if (!keyConfigured && !oauthConfigured) {
          return yield* Effect.fail(new MissingKeyError())
        }
        // Both are validated even if the first fails, so a stale API key
        // cannot mask a working OAuth authorization or vice versa.
        const keyResult = keyConfigured
          ? yield* Effect.result(probeApiKey(credentials.key, options.timeoutMillis))
          : undefined
        const oauthResult = oauthConfigured
          ? yield* Effect.result(probeOAuth(new Date()))
          : undefined
        checks = { key: failureOf(keyResult), oauth: failureOf(oauthResult) }
      }

      const fingerprint = keyConfigured ? store.fingerprint(credentials.key) : ""

      if (options.format !== "table") {
        const rowFormat = options.format === "tsv"
        const state = withFingerprint(
          statusState(credentials, checks, rowFormat),
          fingerprint
        )
        const columns =
          options.columns.length > 0
            ? options.columns
            : check
              ? statusCheckColumns
              : statusColumns
        const renderer = yield* Renderer
        yield* renderer.renderObject(state, {
          format: options.format,
          columns,
          noHeader: options.noHeader
        })
      } else {
        // `--columns` is silently ignored for the table rendering because Go's
        // runStatus bypasses RenderObject entirely there. Preserved.
        yield* writeOut(
          statusTableText(credentials, checks).replace(fingerprintPlaceholder, fingerprint)
        )
      }

      // Output first, THEN the non-zero exit. Key error wins over OAuth error.
      const failure = checks.key ?? checks.oauth
      if (failure !== null && failure !== undefined) yield* Effect.fail(failure)
    })
).pipe(Command.withDescription("Show API-key and OAuth status; optionally validate them"))

/**
 * A probe outcome flattened to the tri-state `StatusChecks` uses:
 * `undefined` (not run), `null` (ran and passed), or the error.
 */
const failureOf = (
  result: Result.Result<void, OytcError> | undefined
): OytcError | null | undefined => {
  if (result === undefined) return undefined
  return Result.isFailure(result) ? result.failure : null
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

export const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const store = yield* CredentialStore
    const oauth = yield* OAuthService

    // Removal must still work when auth.json is corrupt. Revocation is
    // impossible without parsed credentials, so warn and carry on.
    const loaded = yield* Effect.result(store.load)
    let stored: StoredOAuth | undefined
    if (loaded._tag === "Success") {
      stored = loaded.success.oauth
    } else {
      yield* writeErr(
        "Warning: could not read stored credentials (skipping OAuth revocation): " +
          `${loaded.failure.message}\n`
      )
    }

    // `revoke` is best-effort by contract (`Effect<void, never>`), so the
    // "Warning: could not revoke OAuth token" line Go printed on a revoke
    // failure has no trigger here — the failure is swallowed one layer down.
    if (stored !== undefined) yield* oauth.revoke(stored)

    const { path, removed } = yield* store.remove
    yield* writeOut(
      removed
        ? `Removed stored credentials at ${path}.\n`
        : `No stored credentials at ${path}.\n`
    )
    if (yield* store.envKeySet) {
      yield* writeOut("OYTC_API_KEY is still set; environment credentials remain active.\n")
    }
  })
).pipe(Command.withDescription("Revoke OAuth best-effort and remove stored credentials"))

/** Registered by the orchestrator in root.ts. */
export const authCommands = [loginCommand, statusCommand, logoutCommand] as const

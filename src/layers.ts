/**
 * The application Layer graph.
 *
 * One subtlety dominates this file: `HttpCore` needs a token source so it can
 * attach `Authorization: Bearer` and force a refresh after a 401, and that
 * token source lives on `OAuthService` — which itself needs an `HttpClient`
 * (to hit Google's token endpoint) and a `CredentialStore` (to persist a
 * refreshed token). Wiring `HttpCore <- OAuthService` directly would be a
 * dependency cycle.
 *
 * It is broken the same way Go broke it: the token source is a *function*
 * handed to the transport, not a service the transport depends on. The
 * transport calls `tokenSource(force)` and neither knows nor cares that the
 * implementation reaches back into OAuth. Effect makes this explicit — the
 * function is resolved inside the layer body, after OAuthService is built.
 *
 * `AppOptions` is deliberately absent: it is per-invocation and supplied by
 * `Command.provide` in cli/root.ts, because it depends on parsed flags.
 */

import { Effect, Layer } from "effect"
import { FetchHttpClient } from "./effect.ts"
import { AnalyticsApiLive } from "./impl/analyticsApi.ts"
import { BrowserOpenerLive } from "./impl/browserOpener.ts"
import { CredentialStoreLive } from "./impl/credentialStore.ts"
import { FileLockLive } from "./impl/fileLock.ts"
import { makeHttpCore } from "./impl/httpCore.ts"
import { OAuthServiceLive } from "./impl/oauth.ts"
import { ProcessEnvLive } from "./impl/processEnv.ts"
import { PromptsLive } from "./impl/prompts.ts"
import { RendererLive } from "./impl/renderer.ts"
import { SkillInstallerLive } from "./impl/skillInstaller.ts"
import { UpdaterLive } from "./impl/updater.ts"
import { VersionInfoLive } from "./impl/versionInfo.ts"
import { makeYouTubeApi } from "./impl/youtubeApi.ts"
import { CredentialStore, HttpCore, OAuthService, YouTubeApi } from "./services/index.ts"

/** HTTP transport + Fetch. */
const HttpClientLive = FetchHttpClient.layer

/**
 * `ProcessEnv` is a dependency of CredentialStore, BrowserOpener,
 * SkillInstaller and Updater — not merely a sibling of them.
 *
 * Effect does NOT let members of a `Layer.mergeAll` satisfy each other's
 * requirements: an unmet requirement propagates outward as a requirement of
 * the whole merge, and providing it at the outer edge is too late for a layer
 * that needs it during construction. So every consumer gets it explicitly via
 * `Layer.provide`. (Symptom when this is wrong: adding CredentialStore to the
 * merge makes ProcessEnv itself vanish with "Service not found".)
 */
const EnvLive = ProcessEnvLive

/** Credential storage, which serializes writes through the file lock. */
const CredentialsLive = CredentialStoreLive.pipe(
  Layer.provide(Layer.mergeAll(FileLockLive, EnvLive))
)

const BrowserLive = BrowserOpenerLive.pipe(Layer.provide(EnvLive))

/** OAuth needs the HTTP client, the credential store, and a browser opener. */
const OAuthLive = OAuthServiceLive.pipe(
  Layer.provide(Layer.mergeAll(HttpClientLive, CredentialsLive, BrowserLive))
)

/**
 * The transport.
 *
 * An API key is read once at construction (matching Go, which resolved it
 * before issuing any request), and the token source is only attached when
 * OAuth credentials actually exist — otherwise `HttpCore`'s first-match-wins
 * auth switch would take the OAuth branch and fail with MissingOAuthError
 * instead of falling through to the key.
 */
const HttpCoreLive = Layer.effect(
  HttpCore,
  Effect.gen(function* () {
    const credentials = yield* CredentialStore
    const oauth = yield* OAuthService
    const stored = yield* credentials.load

    return yield* makeHttpCore({
      apiKey: stored.key,
      tokenSource: stored.oauth === undefined ? undefined : oauth.tokenSource
    })
  })
).pipe(Layer.provide(Layer.mergeAll(HttpClientLive, CredentialsLive, OAuthLive)))

const YouTubeApiLive = Layer.effect(YouTubeApi, makeYouTubeApi()).pipe(
  Layer.provide(HttpCoreLive)
)

const AnalyticsLive = AnalyticsApiLive.pipe(Layer.provide(HttpCoreLive))

export const AppLayer = Layer.mergeAll(
  EnvLive,
  /**
   * The raw HTTP client is part of AppLayer's OUTPUT, not just an internal
   * dependency of HttpCoreLive.
   *
   * `cli/auth.ts:keyScopedApi` builds a throwaway `YouTubeApi` bound to a
   * specific key — the key just typed at the `login` prompt, or the stored key
   * being validated by `status --check` — via
   * `Effect.serviceOption(HttpClient.HttpClient)`. Without HttpClient in the
   * output that lookup returned None in the compiled binary and the code fell
   * back to the AMBIENT `YouTubeApi`, which is bound to whatever is in the
   * credential store. Consequences, both verified against the Go binary:
   *   - `login` on an empty config probed with NO key and reported
   *     "no API key configured" instead of the API's rejection.
   *   - `status --check` probed the API key using the OAUTH credentials, so a
   *     bad key was reported through an OAuth error message.
   * The unit tests never caught it because they provide HttpClient themselves.
   */
  HttpClientLive,
  CredentialsLive,
  HttpCoreLive,
  YouTubeApiLive,
  AnalyticsLive,
  OAuthLive,
  UpdaterLive.pipe(
    Layer.provide(Layer.mergeAll(HttpClientLive, EnvLive, VersionInfoLive))
  ),
  SkillInstallerLive.pipe(Layer.provide(EnvLive)),
  RendererLive,
  PromptsLive,
  BrowserLive,
  VersionInfoLive
)

/**
 * MANDATED BARREL — the single import site for `effect/unstable/*`.
 *
 * The `unstable/` path prefix is a stability marker: these modules may be
 * renamed before Effect 4.0 final. Every other file in `src/` MUST import
 * these symbols from here, never from `effect/unstable/...` directly, so that
 * a rename is a one-file fix rather than a repo-wide change.
 *
 * CI enforces this:
 *   ! grep -rn "effect/unstable" src/ --exclude=effect.ts
 */

export {
  Argument,
  CliError,
  Command,
  Flag,
  HelpDoc,
  Prompt
} from "effect/unstable/cli"

export {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  UrlParams
} from "effect/unstable/http"

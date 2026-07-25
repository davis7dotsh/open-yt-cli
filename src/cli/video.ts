/**
 * `oytc video {get,stats,popular,trainability}`.
 *
 * Ports `videoGetCommand(false)`, `videoGetCommand(true)`, `videoPopularCommand`
 * and `videoTrainabilityCommand` from `internal/cli/channel_video.go`.
 *
 * `get` and `stats` are ONE Go constructor parameterised by a boolean; they are
 * built the same way here, so the batching, `--fields` injection and
 * `validateRequestedItems` logic cannot drift between them.
 */

import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { OperationalError } from "../domain/errors.ts"
import type { OytcError } from "../domain/errors.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { DEFAULT_BASE_URL } from "../impl/httpCore.ts"
import {
  videoGetColumns,
  videoPopularColumns,
  videoStatsColumns,
  videoTrainabilityColumns
} from "../output/columns.ts"
import { HttpCore, YouTubeApi } from "../services/index.ts"
import type { Params, YouTubeApiShape } from "../services/index.ts"
import { fieldsWithRequired, stripItemIds } from "./fields.ts"
import { renderObject, renderResult } from "./render.ts"
import {
  apiFlagsWithHl,
  BATCH_SIZE,
  batch,
  exactArgs,
  firstFailure,
  listFlags,
  minimumArgs,
  pageOptionsOf,
  partsOr,
  raise,
  setValues,
  validatePagination,
  validateParts,
  validateRequestedItems
} from "./validate.ts"

/**
 * Parts that require owner/OAuth access. The same list for `get`, `stats` and
 * `popular`, because all three hit the `videos` resource.
 */
const FORBIDDEN_VIDEO_PARTS = ["fileDetails", "processingDetails", "suggestions"]

/**
 * The kind name `encoding/json` uses in an `UnmarshalTypeError`. Go names the
 * JSON kind, not the Go type: both booleans are "bool" and every number is
 * "number". `null` never reaches here — it unmarshals successfully.
 */
const goJsonKind = (value: JsonValue): string => {
  if (Array.isArray(value)) return "array"
  if (typeof value === "string") return "string"
  if (typeof value === "number") return "number"
  return "bool"
}

// ---------------------------------------------------------------------------
// video get / video stats
// ---------------------------------------------------------------------------

/**
 * The shared body of `get` and `stats`: batch the IDs 50 at a time, concatenate
 * every page in batch order, assert nothing went missing, then strip the
 * injected `items/id` if one was injected.
 *
 * `requests` counts one per BATCH, not one per ID.
 */
const runVideoBatchGet = (
  ids: ReadonlyArray<string>,
  parts: string,
  api: { readonly fields: string; readonly hl: string }
): Effect.Effect<ListResult, OytcError, YouTubeApiShape> =>
  Effect.gen(function* () {
    const youtube = yield* YouTubeApi
    const { fields: requestFields, preserve: preserveId } = fieldsWithRequired(
      api.fields,
      "items/id"
    )

    const collected: Array<JsonObject> = []
    let requests = 0

    for (const group of batch(ids, BATCH_SIZE)) {
      const params: Params = setValues(
        [
          ["part", parts],
          ["id", group.join(",")]
        ],
        { hl: api.hl, fields: requestFields }
      )
      const response = yield* youtube.get("videos", params)
      requests++
      collected.push(...((response.items ?? []) as ReadonlyArray<JsonObject>))
    }

    yield* validateRequestedItems("videos", ids, collected)

    return {
      items: stripItemIds(collected, preserveId),
      nextPageToken: "",
      requests
    }
  })

const videoBatchCommand = (kind: "get" | "stats") => {
  const isStats = kind === "stats"
  const defaultParts = isStats ? "statistics" : "snippet,contentDetails,statistics,status"
  const columns = isStats ? videoStatsColumns : videoGetColumns
  const description = isStats ? "Get video counters" : "Get videos by ID"

  return Command.make(
    kind,
    {
      ids: Argument.string("VIDEO_ID").pipe(
        Argument.withDescription("YouTube video IDs"),
        Argument.variadic()
      ),
      ...apiFlagsWithHl
    },
    ({ ids, ...api }) =>
      Effect.gen(function* () {
        const parts = partsOr(api.parts, defaultParts)
        // Arg count first, then the semantic check — Go's order.
        const invalid = firstFailure([
          minimumArgs(1, ids.length),
          validateParts(parts, FORBIDDEN_VIDEO_PARTS)
        ])
        if (Option.isSome(invalid)) return yield* raise(invalid.value)

        const result = yield* runVideoBatchGet(ids, parts, api)
        yield* renderResult(result, columns)
      })
  ).pipe(Command.withDescription(description))
}

export const videoGetCommand = videoBatchCommand("get")
export const videoStatsCommand = videoBatchCommand("stats")

// ---------------------------------------------------------------------------
// video popular
// ---------------------------------------------------------------------------

/**
 * `--region` defaults to `US` and, unlike most flags here, is ALWAYS sent —
 * `setValues` only skips empty strings, and the default is not empty.
 */
export const videoPopularCommand = Command.make(
  "popular",
  {
    // `video popular` takes no positionals, and Go rejects extras with
    // `expected 0 argument(s), received N`. A variadic argument is the only way
    // to observe them and reproduce that message; the framework would otherwise
    // ignore them silently.
    extra: Argument.string("").pipe(Argument.variadic()),
    ...listFlags({ pageSize: 25 }),
    ...apiFlagsWithHl,
    region: Flag.string("region").pipe(
      Flag.withDefault("US"),
      Flag.withDescription("ISO 3166-1 alpha-2 chart region")
    ),
    category: Flag.string("category").pipe(
      Flag.withDefault(""),
      Flag.withDescription("video category ID")
    )
  },
  ({ extra, region, category, ...rest }) =>
    Effect.gen(function* () {
      const parts = partsOr(rest.parts, "snippet,contentDetails,statistics")
      const invalid = firstFailure([
        exactArgs(0, extra.length),
        validatePagination(rest, 50),
        validateParts(parts, FORBIDDEN_VIDEO_PARTS)
      ])
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const youtube = yield* YouTubeApi
      const params: Params = setValues(
        [
          ["part", parts],
          ["chart", "mostPopular"]
        ],
        { regionCode: region, videoCategoryId: category, hl: rest.hl, fields: rest.fields }
      )
      const result = yield* youtube.list("videos", params, pageOptionsOf(rest))
      yield* renderResult(result, videoPopularColumns)
    })
).pipe(Command.withDescription("List the most popular videos"))

// ---------------------------------------------------------------------------
// video trainability
// ---------------------------------------------------------------------------

/**
 * The ONLY unauthenticated endpoint, and the only command that bypasses
 * `YouTubeApi` entirely.
 *
 * Go calls `client.GetJSON(ctx, "videoTrainability", …, authenticate=false, …)`
 * — no API key, no bearer, no `part` param, and no list envelope: it decodes
 * into a bare `map[string]any` and renders it through `RenderObject`.
 * `YouTubeApi.get` always authenticates and always decodes the envelope, so
 * this reaches for `HttpCore` directly, which is exactly the seam
 * `authenticate: false` exists for.
 *
 * NON-OBJECT BODIES follow `json.Unmarshal` into a `map[string]any`, which is
 * NOT simply "reject everything that is not an object" — measured against the
 * binary through an intercepting server:
 *
 *   `null`             -> SUCCEEDS, leaving the map NIL. Go re-encodes a nil
 *                         map as `null` (NOT `{}`) in json/jsonl, and the
 *                         table/TSV writers find no keys and emit a header plus
 *                         one blank row. So `null` is rendered, not rejected.
 *   array/string/       -> `decode YouTube API response: json: cannot unmarshal
 *   number/bool            <kind> into Go value of type map[string]interface {}`,
 *                         an OperationalError at exit 6 — not a NotFoundError
 *                         at exit 4.
 *
 * Go's kind names come from `reflect`, so a JSON array is "array", a string is
 * "string", any number is "number" and both booleans are "bool".
 */
export const videoTrainabilityCommand = Command.make(
  "trainability",
  {
    ids: Argument.string("VIDEO_ID").pipe(
      Argument.withDescription("YouTube video ID"),
      Argument.variadic()
    )
  },
  ({ ids }) =>
    Effect.gen(function* () {
      const invalid = exactArgs(1, ids.length)
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const core = yield* HttpCore
      const body = yield* core.getJson({
        baseUrl: DEFAULT_BASE_URL,
        resource: "videoTrainability",
        params: [["id", ids[0]!]],
        authenticate: false
      })
      // `null` unmarshals into a NIL map, which Go's encoder writes back as
      // `null` (not `{}`), while the table/TSV writers see no keys and emit a
      // header plus one blank row. The renderer reproduces all four formats
      // byte for byte from `null` itself, so it is passed straight through.
      if (body === null) {
        yield* renderObject(null as unknown as JsonObject, videoTrainabilityColumns)
        return
      }
      if (typeof body !== "object" || Array.isArray(body)) {
        return yield* Effect.fail(
          new OperationalError({
            message: `decode YouTube API response: json: cannot unmarshal ${goJsonKind(body)} into Go value of type map[string]interface {}`
          })
        )
      }
      yield* renderObject(body as JsonObject, videoTrainabilityColumns)
    })
).pipe(Command.withDescription("Get third-party AI trainability (no key or quota required)"))

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

/** A group command with NO handler: `oytc video` prints help and exits 0. */
export const videoCommand = Command.make("video").pipe(
  Command.withDescription("Read videos, statistics, charts, and trainability"),
  Command.withSubcommands([
    videoGetCommand,
    videoStatsCommand,
    videoPopularCommand,
    videoTrainabilityCommand
  ])
)

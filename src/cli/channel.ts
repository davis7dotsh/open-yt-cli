/**
 * `oytc channel {get,activities,sections,uploads}`.
 *
 * Ports `channelGetCommand`, `channelActivitiesCommand`, `channelSectionsCommand`
 * and `channelUploadsCommand` from `internal/cli/channel_video.go`.
 *
 * REQUEST ACCOUNTING is the theme of this file. Three of the four commands
 * resolve a `@handle` / URL / `UC…` reference before they can do anything, and
 * `ResolveChannel` costs 0 requests for a bare `UC…` id but 1 for everything
 * else. Each command adds that cost to whatever its own fetch spent:
 *
 *   get         resolveCost per reference, + 1 per 50-id batch
 *   activities  resolveCost + whatever List spent
 *   sections    resolveCost (0 when --id was used) + 1
 *   uploads     resolveCost + 1 (the channels lookup) + whatever List spent
 */

import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { NotFoundError } from "../domain/errors.ts"
import { isJsonObject } from "../json/value.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { goQuote } from "../impl/resolveChannel.ts"
import {
  channelActivitiesColumns,
  channelGetColumns,
  channelSectionsColumns,
  channelUploadsColumns
} from "../output/columns.ts"
import { YouTubeApi } from "../services/index.ts"
import type { Params } from "../services/index.ts"
import { fieldsWithRequired, stripItemIds } from "./fields.ts"
import { renderResult } from "./render.ts"
import {
  apiFlags,
  apiFlagsWithHl,
  BATCH_SIZE,
  batch,
  exactArgs,
  firstFailure,
  listFlags,
  maximumArgs,
  minimumArgs,
  pageOptionsOf,
  partsOr,
  publishedFlags,
  raise,
  requireExactlyOne,
  setValues,
  validatePagination,
  validateParts,
  validateRequestedItems,
  validateTimestamp
} from "./validate.ts"

/** Parts on `channels` that require owner/OAuth access. */
const FORBIDDEN_CHANNEL_PARTS = ["auditDetails", "contentOwnerDetails"]

/** `mapPathString(item, …path)` — a string at a nested path, or undefined. */
const nestedString = (item: JsonObject, ...path: ReadonlyArray<string>): string | undefined => {
  let value: JsonValue = item
  for (const key of path) {
    if (!isJsonObject(value)) return undefined
    const next: JsonValue | undefined = value[key]
    if (next === undefined) return undefined
    value = next
  }
  return typeof value === "string" ? value : undefined
}

// ---------------------------------------------------------------------------
// channel get
// ---------------------------------------------------------------------------

/**
 * References are resolved one at a time, IN ORDER, and the running cost is kept
 * even when a later resolution fails — Go accumulates `requests += used` before
 * checking `err`. That partial count is then discarded along with the result, so
 * it is only observable as "the failure happened after N requests"; the
 * behaviour is preserved anyway because a future caller might surface it.
 */
export const channelGetCommand = Command.make(
  "get",
  {
    references: Argument.string("REFERENCE").pipe(
      Argument.withDescription("Channel IDs, @handles, or channel URLs"),
      Argument.variadic()
    ),
    ...apiFlagsWithHl
  },
  ({ references, ...api }) =>
    Effect.gen(function* () {
      const parts = partsOr(api.parts, "snippet,contentDetails,statistics")
      const invalid = firstFailure([
        minimumArgs(1, references.length),
        validateParts(parts, FORBIDDEN_CHANNEL_PARTS)
      ])
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const youtube = yield* YouTubeApi
      const ids: Array<string> = []
      let requests = 0
      for (const reference of references) {
        const resolved = yield* youtube.resolveChannel(reference)
        requests += resolved.requests
        ids.push(resolved.id)
      }

      const { fields: requestFields, preserve: preserveId } = fieldsWithRequired(
        api.fields,
        "items/id"
      )
      const collected: Array<JsonObject> = []
      for (const group of batch(ids, BATCH_SIZE)) {
        const params: Params = setValues(
          [
            ["part", parts],
            ["id", group.join(",")]
          ],
          { hl: api.hl, fields: requestFields }
        )
        const response = yield* youtube.get("channels", params)
        requests++
        collected.push(...((response.items ?? []) as ReadonlyArray<JsonObject>))
      }

      // Note the resource name is the API's, `channels`, not `channel`.
      yield* validateRequestedItems("channels", ids, collected)

      yield* renderResult(
        { items: stripItemIds(collected, preserveId), nextPageToken: "", requests },
        channelGetColumns
      )
    })
).pipe(Command.withDescription("Get channels by ID, @handle, or common channel URL"))

// ---------------------------------------------------------------------------
// channel activities
// ---------------------------------------------------------------------------

/**
 * Both timestamp checks run BEFORE the channel is resolved, so a malformed
 * `--published-after` costs no quota.
 *
 * `--fields` is passed through untouched: there is no injected field to strip,
 * because activities are not fetched by ID.
 */
export const channelActivitiesCommand = Command.make(
  "activities",
  {
    channels: Argument.string("CHANNEL").pipe(
      Argument.withDescription("Channel ID, @handle, or channel URL"),
      Argument.variadic()
    ),
    ...listFlags({ pageSize: 25 }),
    ...apiFlags,
    ...publishedFlags
  },
  ({ channels, publishedAfter, publishedBefore, ...rest }) =>
    Effect.gen(function* () {
      const invalid = firstFailure([
        exactArgs(1, channels.length),
        validatePagination(rest, 50),
        validateTimestamp("--published-after", publishedAfter),
        validateTimestamp("--published-before", publishedBefore)
      ])
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const youtube = yield* YouTubeApi
      const resolved = yield* youtube.resolveChannel(channels[0]!)

      const params: Params = setValues(
        [
          ["part", partsOr(rest.parts, "snippet,contentDetails")],
          ["channelId", resolved.id]
        ],
        { publishedAfter, publishedBefore, fields: rest.fields }
      )
      const result = yield* youtube.list("activities", params, pageOptionsOf(rest))
      yield* renderResult(
        { ...result, requests: result.requests + resolved.requests },
        channelActivitiesColumns
      )
    })
).pipe(Command.withDescription("List a channel's public activities"))

// ---------------------------------------------------------------------------
// channel sections
// ---------------------------------------------------------------------------

/**
 * Exactly one of the positional CHANNEL or `--id` — Go's test is
 * `(ids == "") == (len(args) == 0)`, which fails when both are given AND when
 * neither is.
 *
 * This is a `Get`, not a `List`: no `maxResults`, no `pageToken`, no `--all`,
 * and the request count is a flat 1 plus whatever resolution cost.
 */
export const channelSectionsCommand = Command.make(
  "sections",
  {
    channels: Argument.string("CHANNEL").pipe(
      Argument.withDescription("Channel ID, @handle, or channel URL"),
      Argument.variadic()
    ),
    ...apiFlagsWithHl,
    id: Flag.string("id").pipe(
      Flag.withDefault(""),
      Flag.withDescription("comma-separated channel section IDs")
    )
  },
  ({ channels, id, ...api }) =>
    Effect.gen(function* () {
      const invalid = firstFailure([
        maximumArgs(1, channels.length),
        requireExactlyOne(id === "", channels.length === 0, "provide exactly one of CHANNEL or --id")
      ])
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const youtube = yield* YouTubeApi
      let params: Params = [["part", partsOr(api.parts, "snippet,contentDetails")]]
      let requests = 0
      if (id !== "") {
        params = [...params, ["id", id]]
      } else {
        const resolved = yield* youtube.resolveChannel(channels[0]!)
        requests += resolved.requests
        params = [...params, ["channelId", resolved.id]]
      }
      params = setValues(params, { hl: api.hl, fields: api.fields })

      const response = yield* youtube.get("channelSections", params)
      yield* renderResult(
        {
          items: (response.items ?? []) as ReadonlyArray<JsonObject>,
          nextPageToken: "",
          requests: requests + 1
        },
        channelSectionsColumns
      )
    })
).pipe(Command.withDescription("List a channel's sections or get section IDs"))

// ---------------------------------------------------------------------------
// channel uploads
// ---------------------------------------------------------------------------

/**
 * The most expensive command in the package: resolve the reference, look the
 * channel up to read `contentDetails.relatedPlaylists.uploads`, then paginate
 * that playlist. The lookup is a hard `+1` on top of the resolution cost.
 *
 * Both failure messages quote the ORIGINAL reference (`args[0]`), not the
 * resolved `UC…` id, so `oytc channel uploads @handle` says `@handle`. Both are
 * bare `fmt.Errorf`s in Go, classified to exit 4 by their message text
 * ("not found" and "no public uploads" are both in the substring table); a
 * `NotFoundError` carries that code directly.
 *
 * The channel lookup deliberately sends only `part=contentDetails` — NOT the
 * user's `--parts`, and NOT their `--fields`, because it is an internal probe
 * whose result is never rendered.
 */
export const channelUploadsCommand = Command.make(
  "uploads",
  {
    channels: Argument.string("CHANNEL").pipe(
      Argument.withDescription("Channel ID, @handle, or channel URL"),
      Argument.variadic()
    ),
    ...listFlags({ pageSize: 50 }),
    ...apiFlags
  },
  ({ channels, ...rest }) =>
    Effect.gen(function* () {
      const invalid = firstFailure([exactArgs(1, channels.length), validatePagination(rest, 50)])
      if (Option.isSome(invalid)) return yield* raise(invalid.value)

      const reference = channels[0]!
      const youtube = yield* YouTubeApi
      const resolved = yield* youtube.resolveChannel(reference)
      let requests = resolved.requests

      const lookup = yield* youtube.get("channels", [
        ["part", "contentDetails"],
        ["id", resolved.id]
      ])
      requests++

      const first = (lookup.items ?? [])[0] as JsonObject | undefined
      if (first === undefined) {
        return yield* Effect.fail(
          new NotFoundError({ message: `channel ${goQuote(reference)} not found` })
        )
      }
      const uploads = nestedString(first, "contentDetails", "relatedPlaylists", "uploads")
      if (uploads === undefined || uploads === "") {
        return yield* Effect.fail(
          new NotFoundError({
            message: `channel ${goQuote(reference)} has no public uploads playlist`
          })
        )
      }

      const params: Params = setValues(
        [
          ["part", partsOr(rest.parts, "snippet,contentDetails")],
          ["playlistId", uploads]
        ],
        { fields: rest.fields }
      )
      const result = yield* youtube.list("playlistItems", params, pageOptionsOf(rest))
      yield* renderResult(
        { ...result, requests: result.requests + requests },
        channelUploadsColumns
      )
    })
).pipe(Command.withDescription("Resolve and enumerate a channel's uploads playlist"))

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

/** A group command with NO handler: `oytc channel` prints help and exits 0. */
export const channelCommand = Command.make("channel").pipe(
  Command.withDescription("Read channels, activities, sections, and uploads"),
  Command.withSubcommands([
    channelGetCommand,
    channelActivitiesCommand,
    channelSectionsCommand,
    channelUploadsCommand
  ])
)

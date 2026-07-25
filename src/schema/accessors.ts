/**
 * The complete set of reads into an opaque `items` element.
 *
 * These are the ONLY nested paths the Go code touches. Every accessor is
 * tolerant: a missing key, a wrong type, or a non-object intermediate yields
 * `Option.none` rather than failing, matching Go's comma-ok map lookups.
 */

import { Option, Schema } from "effect"
import type { JsonObject } from "../json/value.ts"
import { rawToNumber } from "../json/value.ts"
import type { DataApiResponse } from "./dataapi.ts"

const decodeOption = <A, I>(schema: Schema.Codec<A, I>) => Schema.decodeUnknownOption(schema)

const NonEmptyStringSchema = Schema.String.pipe(
  Schema.refine((s): s is string => s.length > 0, { title: "NonEmptyString" })
)

const SearchIdSchema = Schema.Struct({
  id: Schema.Struct({
    kind: Schema.optional(Schema.String),
    channelId: Schema.optional(Schema.String)
  })
})

const FlatIdSchema = Schema.Struct({ id: NonEmptyStringSchema })

const UploadsSchema = Schema.Struct({
  contentDetails: Schema.Struct({
    relatedPlaylists: Schema.Struct({
      uploads: NonEmptyStringSchema
    })
  })
})

const LiveChatSchema = Schema.Struct({
  liveStreamingDetails: Schema.Struct({
    activeLiveChatId: NonEmptyStringSchema
  })
})

const decodeSearchId = decodeOption(SearchIdSchema)
const decodeFlatId = decodeOption(FlatIdSchema)
const decodeUploads = decodeOption(UploadsSchema)
const decodeLiveChat = decodeOption(LiveChatSchema)

/** `id.kind` on a search result. */
export const searchItemKind = (item: JsonObject): Option.Option<string> =>
  Option.flatMap(decodeSearchId(item), (v) => Option.fromNullishOr(v.id.kind))

/** `id.channelId` on a search result. */
export const searchItemChannelId = (item: JsonObject): Option.Option<string> =>
  Option.flatMap(decodeSearchId(item), (v) => Option.fromNullishOr(v.id.channelId))

/** Top-level `id` when it is a flat non-empty string (channels, videos, …). */
export const channelItemId = (item: JsonObject): Option.Option<string> =>
  Option.map(decodeFlatId(item), (v) => v.id)

/** Alias kept for call-site clarity; identical semantics. */
export const itemId = channelItemId

/** `contentDetails.relatedPlaylists.uploads`. */
export const channelUploadsPlaylist = (item: JsonObject): Option.Option<string> =>
  Option.map(decodeUploads(item), (v) => v.contentDetails.relatedPlaylists.uploads)

/** `liveStreamingDetails.activeLiveChatId`. */
export const videoActiveLiveChatId = (item: JsonObject): Option.Option<string> =>
  Option.map(decodeLiveChat(item), (v) => v.liveStreamingDetails.activeLiveChatId)

/** `pollingIntervalMillis` as a real number — one of the few numeric reads. */
export const pollingIntervalMillis = (r: DataApiResponse): Option.Option<number> =>
  Option.fromNullishOr(rawToNumber(r.pollingIntervalMillis))

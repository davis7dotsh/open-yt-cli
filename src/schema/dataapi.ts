/**
 * YouTube Data API v3 response schemas.
 *
 * DELIBERATELY LOOSE. `--parts` and `--fields` let users request arbitrary
 * field subsets, so any fixed per-resource schema (Video, Channel, Playlist…)
 * would reject responses the Go client accepts. Only the list envelope is
 * typed; `items` stays an opaque record, and the handful of nested paths the
 * code actually reads get narrow, tolerant accessors in `accessors.ts`.
 *
 * Do not add per-resource schemas here.
 */

import { Schema } from "effect"

export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown)

export const DataApiResponse = Schema.Struct({
  items: Schema.optional(Schema.Array(JsonObjectSchema)),
  nextPageToken: Schema.optional(Schema.String),
  prevPageToken: Schema.optional(Schema.String),
  /** RawNumber at runtime; decoded as Unknown and narrowed on demand. */
  pollingIntervalMillis: Schema.optional(Schema.Unknown),
  offlineAt: Schema.optional(Schema.String),
  pageInfo: Schema.optional(JsonObjectSchema),
  kind: Schema.optional(Schema.String),
  etag: Schema.optional(Schema.String)
})

export type DataApiResponse = typeof DataApiResponse.Type

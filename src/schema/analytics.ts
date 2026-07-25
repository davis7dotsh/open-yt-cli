/**
 * YouTube Analytics API response schema.
 *
 * Unlike the Data API, this shape IS genuinely typed — the reports endpoint
 * always returns column headers plus a row matrix. Both fields are optional
 * and default to empty, because an empty report omits them.
 */

import { Schema } from "effect"

export const AnalyticsColumnHeader = Schema.Struct({
  name: Schema.String,
  columnType: Schema.optional(Schema.String),
  dataType: Schema.optional(Schema.String)
})

export type AnalyticsColumnHeader = typeof AnalyticsColumnHeader.Type

export const AnalyticsResponse = Schema.Struct({
  columnHeaders: Schema.optional(Schema.Array(AnalyticsColumnHeader)),
  /** Cell values are RawNumber | string | boolean | null at runtime. */
  rows: Schema.optional(Schema.Array(Schema.Array(Schema.Unknown)))
})

export type AnalyticsResponse = typeof AnalyticsResponse.Type

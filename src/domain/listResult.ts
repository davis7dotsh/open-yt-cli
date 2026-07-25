/**
 * The list envelope shared by every paginated command.
 *
 * JSON key ordering follows Go's struct-field order — `items`, then
 * `nextPageToken` (omitted entirely when empty), then `requests` (always
 * present, even at 0). Nested objects inside `items` are sorted alphabetically
 * at every depth, because Go marshals maps sorted. Both rules apply at once.
 */

import { encodeGoStruct, encodeGoValue } from "../json/encode.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"
import { rawNumber } from "../json/value.ts"

export interface ListResult {
  /** Never null; an empty array when the response carried no items. */
  readonly items: ReadonlyArray<JsonObject>
  /** "" means: omit the key from the envelope. */
  readonly nextPageToken: string
  readonly requests: number
}

export const emptyListResult: ListResult = {
  items: [],
  nextPageToken: "",
  requests: 0
}

const envelopeEntries = (r: ListResult): ReadonlyArray<readonly [string, JsonValue]> => {
  const entries: Array<readonly [string, JsonValue]> = [["items", r.items]]
  if (r.nextPageToken !== "") entries.push(["nextPageToken", r.nextPageToken])
  entries.push(["requests", rawNumber(String(r.requests))])
  return entries
}

/** Pretty envelope with a trailing newline, as `--format json` emits. */
export const encodeListResultJson = (r: ListResult): string =>
  `${encodeGoStruct(envelopeEntries(r), { indent: "  " })}\n`

/**
 * One compact object per line, as `--format jsonl` emits. Produces zero bytes
 * for an empty result — not an empty line.
 */
export const encodeListResultJsonl = (r: ListResult): string =>
  r.items.map((item) => `${encodeGoValue(item, { indent: "" })}\n`).join("")

/** Pagination inputs shared by the client and the command layer. */
export interface PageOptions {
  readonly all: boolean
  /** 0 means no cap. */
  readonly limit: number
  /** 0 means: do not send maxResults. */
  readonly pageSize: number
  /** "" means: do not send pageToken. */
  readonly pageToken: string
  readonly filter?: ((item: JsonObject) => boolean) | undefined
}

export const defaultPageOptions: PageOptions = {
  all: false,
  limit: 0,
  pageSize: 0,
  pageToken: ""
}

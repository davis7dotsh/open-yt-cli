/**
 * The two JSON output shapes.
 *
 * `json` emits the full `ListResult` envelope: struct-ordered keys, 2-space
 * indent, trailing newline. `jsonl` emits one compact object per line with NO
 * envelope — `nextPageToken` and `requests` are lost, and an empty result set
 * produces ZERO bytes rather than an empty line.
 *
 * `renderObject*` are the `RenderObject` path (`video trainability`, `status`,
 * `version`, `update`): a bare object, no envelope, same indentation rules.
 *
 * All four go through `json/encode.ts` so that Go's escaping and key ordering
 * are preserved; the stdlib JSON serializer is banned outside that file (CI
 * enforces it with a text grep, so it must not appear even in a comment).
 */

import { encodeGoValue } from "../json/encode.ts"
import { encodeListResultJson, encodeListResultJsonl } from "../domain/listResult.ts"
import type { ListResult } from "../domain/listResult.ts"
import type { JsonObject } from "../json/value.ts"

/** `--format json` for a list result. */
export const renderJson = (result: ListResult): string => encodeListResultJson(result)

/** `--format jsonl` for a list result; "" when there are no items. */
export const renderJsonl = (result: ListResult): string => encodeListResultJsonl(result)

/** `RenderObject` with `--format json`: indented, trailing newline. */
export const renderObjectJson = (object: JsonObject): string =>
  `${encodeGoValue(object, { indent: "  " })}\n`

/** `RenderObject` with `--format jsonl`: compact, one line, trailing newline. */
export const renderObjectJsonl = (object: JsonObject): string =>
  `${encodeGoValue(object, { indent: "" })}\n`

/**
 * Google partial-response `--fields` selector support.
 *
 * Ports `internal/cli/fields.go` (the grammar parser) plus the three call-site
 * helpers that live in `internal/cli/app.go`: `fieldsWithRequired`,
 * `stripItemIDs`, and the id/kind deletion half of `searchResultFilter`.
 *
 * The shape of the problem: several commands need a field in the response that
 * the user's own selector may have excluded — `items/id` for the batch-get
 * commands, `items/id/kind` for `search`'s client-side kind filter. So the
 * outbound selector is rewritten to append the required path, and the injected
 * key is deleted from every item again before rendering, leaving the user with
 * exactly what they asked for.
 *
 * SHARED HELPER — P8b and P8c import from here read-only. Do not edit outside
 * P8a.
 */

import { isJsonObject } from "../json/value.ts"
import type { JsonObject, JsonValue } from "../json/value.ts"

// ---------------------------------------------------------------------------
// The grammar parser
// ---------------------------------------------------------------------------

/**
 * The delimiter set `readName` stops on, and (minus `/`, `(`, `)`, `,`) the set
 * `skipSpaces` consumes. Transcribed from `strings.ContainsRune("/(), \t\r\n", …)`.
 *
 * Go indexes the selector by BYTE while JS indexes by UTF-16 code unit. Every
 * delimiter here is ASCII, so both slice at identical boundaries and any
 * multi-byte name survives intact either way.
 */
const NAME_TERMINATORS = new Set(["/", "(", ")", ",", " ", "\t", "\r", "\n"])
const SPACES = new Set([" ", "\t", "\r", "\n"])

class FieldSelectorParser {
  position = 0
  constructor(readonly selector: string) {}

  /**
   * `terminator` of `""` is Go's zero byte: no terminator, run to the end.
   */
  parseList(prefix: ReadonlyArray<string>, terminator: string): ReadonlyArray<string> {
    const paths: Array<string> = []
    while (this.position < this.selector.length) {
      this.skipSpacesAndCommas()
      if (this.position >= this.selector.length) break
      if (terminator !== "" && this.selector[this.position] === terminator) {
        this.position++
        break
      }
      paths.push(...this.parseField(prefix))
    }
    return paths
  }

  parseField(prefix: ReadonlyArray<string>): ReadonlyArray<string> {
    const name = this.readName()
    if (name === "") {
      // A stray `/`, `(` or `)`; consume it and contribute nothing.
      this.position++
      return []
    }
    const path = [...prefix, name]
    this.skipSpaces()
    if (this.position >= this.selector.length) return [path.join("/")]
    switch (this.selector[this.position]) {
      case "/":
        this.position++
        this.skipSpaces()
        return this.parseField(path)
      case "(":
        this.position++
        return this.parseList(path, ")")
      default:
        return [path.join("/")]
    }
  }

  readName(): string {
    const start = this.position
    while (
      this.position < this.selector.length &&
      !NAME_TERMINATORS.has(this.selector[this.position]!)
    ) {
      this.position++
    }
    return this.selector.slice(start, this.position)
  }

  skipSpacesAndCommas(): void {
    while (this.position < this.selector.length) {
      const ch = this.selector[this.position]!
      if (ch !== "," && !SPACES.has(ch)) break
      this.position++
    }
  }

  skipSpaces(): void {
    while (this.position < this.selector.length && SPACES.has(this.selector[this.position]!)) {
      this.position++
    }
  }
}

/** Every `a/b/c` path a selector expands to, groups flattened. */
export const fieldSelectorPaths = (selector: string): ReadonlyArray<string> =>
  new FieldSelectorParser(selector).parseList([], "")

/**
 * Does `selector` already cover `target`?
 *
 * True when ANY expanded path satisfies one of:
 *   - the path is `*` or the bare `items` (everything under items is returned)
 *   - the path IS the target
 *   - the path is deeper than the target (`items/id/kind` covers `items/id`)
 *   - the path is an ancestor of the target (`items/id` covers `items/id/kind`)
 *   - the path ends in `/*` and the target is under that parent
 *
 * All five rules are load-bearing; `internal/cli/fields_test.go` pins them.
 */
export const fieldSelectorIncludes = (selector: string, target: string): boolean => {
  for (const path of fieldSelectorPaths(selector)) {
    const wildcardParent = path.endsWith("/*") ? path.slice(0, -2) : path
    if (
      path === "*" ||
      path === "items" ||
      path === target ||
      path.startsWith(`${target}/`) ||
      target.startsWith(`${path}/`) ||
      (wildcardParent !== path && target.startsWith(`${wildcardParent}/`))
    ) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Request rewriting
// ---------------------------------------------------------------------------

export interface RequiredFields {
  /** The selector to actually send; `""` still means "send no fields param". */
  readonly fields: string
  /**
   * True when the required path was already covered (or no selector was given
   * at all), so nothing has to be stripped from the response afterwards.
   */
  readonly preserve: boolean
}

/**
 * `fieldsWithRequired` — append `,<required>` unless the user's selector
 * already covers it.
 *
 * An empty selector reports `preserve: true`: no partial response was
 * requested, so every field is present and nothing is injected.
 */
export const fieldsWithRequired = (fields: string, required: string): RequiredFields =>
  fields === "" || fieldSelectorIncludes(fields, required)
    ? { fields, preserve: true }
    : { fields: `${fields},${required}`, preserve: false }

// ---------------------------------------------------------------------------
// Response stripping
// ---------------------------------------------------------------------------

const omit = (object: JsonObject, key: string): JsonObject => {
  const next: Record<string, JsonValue> = {}
  for (const name of Object.keys(object)) {
    if (name !== key) next[name] = object[name]!
  }
  return next
}

/**
 * `stripItemIDs` — drop the injected `items/id` from every item.
 *
 * Go mutates the maps in place; here `JsonObject` is deeply readonly, so a new
 * item is produced. Nested key order is irrelevant: the JSON encoder sorts
 * every nested object and the table/TSV writers address cells by path.
 */
export const stripItemIds = (
  items: ReadonlyArray<JsonObject>,
  preserve: boolean
): ReadonlyArray<JsonObject> => (preserve ? items : items.map((item) => omit(item, "id")))

/**
 * The deletion half of `searchResultFilter`: drop the injected `id.kind`, and
 * drop `id` entirely when that emptied it.
 *
 * Go performs this inside the page filter, on accepted items only. Doing it
 * after the list returns is equivalent — the accepted items ARE the result
 * items — and is the only option here, because a filter predicate over readonly
 * values cannot mutate.
 */
export const stripSearchKind = (item: JsonObject): JsonObject => {
  const id = item["id"]
  if (id === undefined || !isJsonObject(id)) return item
  const nextId = omit(id, "kind")
  if (Object.keys(nextId).length === 0) return omit(item, "id")
  return { ...item, id: nextId }
}

/** `stripSearchKind` over a page, skipped wholesale when the kind is preserved. */
export const stripSearchKinds = (
  items: ReadonlyArray<JsonObject>,
  preserve: boolean
): ReadonlyArray<JsonObject> => (preserve ? items : items.map(stripSearchKind))

/**
 * Channel-reference resolution — a port of `internal/youtube/list.go`'s
 * `ResolveChannel` / `parseChannelReference`.
 *
 * A reference is a `UC…` ID, an `@handle`, or a YouTube URL. The classifier is
 * deliberately quirky and the quirks are load-bearing, so this file reproduces
 * Go's `net/url` semantics rather than reaching for `new URL`. The two differ
 * in ways the classifier can actually observe, all verified against Go 1.26.5:
 *
 *   | reference                        | Go           | `new URL`        |
 *   |----------------------------------|--------------|------------------|
 *   | `//youtube.com/@x`               | search       | handle `@x`      |
 *   | `https://WWW.YOUTUBE.COM/@Foo`   | search       | handle `@Foo`    |
 *   | `https://youtube.com/%40handle`  | handle `@handle` | (no match)   |
 *   | `https://youtube.com/@x<TAB>y`   | search (err) | handle `@xy`     |
 *   | `https://youtube.com/@x%`        | search (err) | handle `@x%`     |
 *
 * The `WWW.YOUTUBE.COM` row is the important one: Go's `url.Parse` does not
 * lowercase the host, and `strings.TrimPrefix(host, "www.")` runs BEFORE
 * `strings.ToLower`, so an uppercase `WWW.` prefix survives and the host test
 * fails. `new URL` lowercases eagerly and would silently "fix" it.
 */

import { Effect } from "effect"
import { NotFoundError, OperationalError, type OytcError } from "../domain/errors.ts"
import { searchItemChannelId, channelItemId } from "../schema/accessors.ts"
import type { DataApiResponse } from "../schema/dataapi.ts"
import type { JsonObject } from "../json/value.ts"
import type { Params, ResolvedChannel } from "../services/index.ts"

/** `^UC[A-Za-z0-9_-]{22}$` — exactly 24 characters. */
export const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/

// ---------------------------------------------------------------------------
// Go string formatting
// ---------------------------------------------------------------------------

const HEX_LOWER = "0123456789abcdef"

/**
 * Go's `unicode.IsPrint`: general categories L, M, N, P, S, plus the ASCII
 * space. Notably NOT other space separators (U+00A0, U+2000, U+3000), format
 * characters (U+200B, U+FEFF), line/paragraph separators, private use, or
 * unassigned code points — all of which Go escapes.
 */
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v"
}

/**
 * Go's `strconv.Quote`, which is what `fmt.Errorf("%q")` uses for the two
 * user-facing messages this file produces.
 *
 * Verified against Go 1.26.5: `\a\b\f\v` short escapes, `\x1b` for other
 * control bytes, ` ` / `​` / `﻿` / ` ` for non-printable
 * BMP code points, `\U000e0000` for non-printable astral ones, and literal
 * pass-through for `café`, `日本` and emoji.
 */
export const goQuote = (s: string): string => {
  let out = '"'
  for (const char of s) {
    const code = char.codePointAt(0)!
    if (char === '"') {
      out += '\\"'
    } else if (char === "\\") {
      out += "\\\\"
    } else if (SHORT_ESCAPES[code] !== undefined) {
      out += SHORT_ESCAPES[code]
    } else if (code >= 0x20 && code < 0x7f) {
      out += char
    } else if (code < 0x80) {
      out += `\\x${HEX_LOWER[(code >> 4) & 0xf]}${HEX_LOWER[code & 0xf]}`
    } else if (PRINTABLE.test(char)) {
      out += char
    } else if (code < 0x10000) {
      out += `\\u${code.toString(16).padStart(4, "0")}`
    } else {
      out += `\\U${code.toString(16).padStart(8, "0")}`
    }
  }
  return `${out}"`
}

// ---------------------------------------------------------------------------
// A faithful subset of Go's net/url.Parse
// ---------------------------------------------------------------------------

export interface GoUrl {
  /** Empty when the URL has no authority component. */
  readonly host: string
  /** `Hostname()` — `host` without its port and without IPv6 brackets. */
  readonly hostname: string
  /** `Path` — percent-DECODED, so `%40` has already become `@`. */
  readonly path: string
}

const isHexDigit = (c: string): boolean => /^[0-9A-Fa-f]$/.test(c)

/** `stringContainsCTLByte` — any byte `< 0x20` or `== 0x7f`. */
const containsControl = (s: string): boolean => {
  for (const char of s) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Go's `unescape` escape validation; returns false on a malformed `%XY`. */
const escapesValid = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "%") continue
    if (i + 2 >= s.length || !isHexDigit(s[i + 1]!) || !isHexDigit(s[i + 2]!)) return false
    i += 2
  }
  return true
}

/**
 * Percent-decode. Go produces raw bytes here, which may be invalid UTF-8; a
 * non-fatal decode turns those into U+FFFD instead. Only reachable via an
 * exotic hand-written URL, and the resulting path segment is looked up
 * remotely either way.
 */
const percentDecode = (s: string): string => {
  if (!s.includes("%")) return s
  const bytes: Array<number> = []
  const raw = new TextEncoder().encode(s)
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x25 && i + 2 < raw.length) {
      bytes.push(parseInt(String.fromCharCode(raw[i + 1]!, raw[i + 2]!), 16))
      i += 2
    } else {
      bytes.push(raw[i]!)
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes))
}

/**
 * Go's `shouldEscape(c, encodeHost)` inverted: the bytes allowed unescaped in a
 * host. Anything else (notably a space) makes `parseHost` fail.
 */
const HOST_ALLOWED = /^[A-Za-z0-9\-._~!$&'()*+,;=:[\]<>"%]$/

const validOptionalPort = (colonPort: string): boolean =>
  colonPort === "" || /^:[0-9]*$/.test(colonPort)

/**
 * `parseHost` — validates the port suffix and every host byte.
 *
 * The `%2e` rule is the subtle one: `unescape(..., encodeHost)` rejects any
 * escape whose high nibble is `< 8` unless it is literally `%25`, because
 * "hosts can't use %-encoding for ASCII bytes". So `//youtube%2ecom/@x` is a
 * parse ERROR in Go and classifies as a keyword search, where a naive decoder
 * would see `youtube.com` and call it a handle. Caught by differential fuzzing
 * against Go 1.26.5 — 100 corpus rows hinged on it.
 */
const parseHost = (authority: string): string | undefined => {
  if (authority.startsWith("[")) {
    // A bracketed IP-literal: the port, if any, follows the closing bracket.
    // Go additionally parses the address itself (rejecting `[v7.abc]`); that is
    // not reproduced because no bracketed host can ever equal youtube.com, so
    // it cannot change a classification.
    const close = authority.lastIndexOf("]")
    if (close < 0) return undefined
    if (!validOptionalPort(authority.slice(close + 1))) return undefined
    return authority
  }
  const colon = authority.lastIndexOf(":")
  if (colon !== -1 && !validOptionalPort(authority.slice(colon))) return undefined
  for (const char of authority) {
    if (char === "%") continue
    if (char.codePointAt(0)! >= 0x80) continue
    if (!HOST_ALLOWED.test(char)) return undefined
  }
  if (!escapesValid(authority)) return undefined
  for (let i = 0; i < authority.length; i++) {
    if (authority[i] !== "%") continue
    if (parseInt(authority[i + 1]!, 16) < 8 && authority.slice(i, i + 3) !== "%25") return undefined
    i += 2
  }
  return percentDecode(authority)
}

/** `getScheme` — a leading alpha followed by alnum/`+`/`-`/`.` up to a `:`. */
const getScheme = (raw: string): { scheme: string; rest: string } | undefined => {
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (/[A-Za-z]/.test(c)) continue
    if (/[0-9+\-.]/.test(c)) {
      if (i === 0) return { scheme: "", rest: raw }
      continue
    }
    if (c === ":") {
      if (i === 0) return undefined // "missing protocol scheme"
      return { scheme: raw.slice(0, i), rest: raw.slice(i + 1) }
    }
    return { scheme: "", rest: raw }
  }
  return { scheme: "", rest: raw }
}

/**
 * `url.Parse`, restricted to what the channel classifier observes: control-byte
 * rejection, fragment/query splitting, scheme detection, the relative-path
 * colon rule, `//authority` extraction with userinfo stripping, host
 * validation, and percent-decoded paths.
 *
 * Returns `undefined` where Go returns an error — the classifier treats both
 * identically (fall through to a keyword search).
 */
export const goUrlParse = (raw: string): GoUrl | undefined => {
  const hash = raw.indexOf("#")
  const beforeFragment = hash === -1 ? raw : raw.slice(0, hash)
  const fragment = hash === -1 ? "" : raw.slice(hash + 1)

  if (containsControl(beforeFragment)) return undefined

  const scheme = getScheme(beforeFragment)
  if (scheme === undefined) return undefined

  // Go splits the query off before touching the authority, and never validates
  // its escapes — `?q=%zz` parses fine.
  const question = scheme.rest.indexOf("?")
  let rest = question === -1 ? scheme.rest : scheme.rest.slice(0, question)

  if (!rest.startsWith("/")) {
    // A rootless path under a scheme is opaque: no host, no path.
    if (scheme.scheme !== "") return { host: "", hostname: "", path: "" }
    const firstSegment = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest
    if (firstSegment.includes(":")) return undefined
  }

  let host = ""
  if ((scheme.scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
    let authority = rest.slice(2)
    rest = ""
    const slash = authority.indexOf("/")
    if (slash >= 0) {
      rest = authority.slice(slash)
      authority = authority.slice(0, slash)
    }
    const at = authority.lastIndexOf("@")
    const parsed = parseHost(at < 0 ? authority : authority.slice(at + 1))
    if (parsed === undefined) return undefined
    host = parsed
  }

  if (!escapesValid(rest)) return undefined
  if (fragment !== "" && !escapesValid(fragment)) return undefined

  // Hostname(): drop a valid `:port`, then unwrap IPv6 brackets.
  let hostname = host
  const colon = hostname.lastIndexOf(":")
  if (colon !== -1 && validOptionalPort(hostname.slice(colon))) hostname = hostname.slice(0, colon)
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1)

  return { host, hostname, path: percentDecode(rest) }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ChannelReferenceKind = "handle" | "id" | "username" | "search"

export interface ChannelReference {
  readonly kind: ChannelReferenceKind
  readonly value: string
}

/** `strings.Trim(s, "/")` — strips ALL leading and trailing slashes. */
const trimSlashes = (s: string): string => s.replace(/^\/+/, "").replace(/\/+$/, "")

/**
 * `parseChannelReference`. Note two deliberate Go quirks preserved verbatim:
 *
 *  - `strings.TrimPrefix(hostname, "www.")` runs BEFORE `strings.ToLower`, so
 *    an uppercase `WWW.` is not stripped and the host test then fails.
 *  - the scheme is never checked, so `ftp://youtube.com/@x` classifies as a
 *    handle.
 */
export const parseChannelReference = (reference: string): ChannelReference => {
  if (reference.startsWith("@")) return { kind: "handle", value: reference }

  let candidate = reference
  if (
    !candidate.includes("://") &&
    (candidate.includes("youtube.com/") || candidate.includes("youtu.be/"))
  ) {
    candidate = `https://${candidate}`
  }

  const parsed = goUrlParse(candidate)
  if (parsed !== undefined && parsed.host !== "") {
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase()
    if (host === "youtube.com" || host === "m.youtube.com") {
      const parts = trimSlashes(parsed.path).split("/")
      const first = parts[0]
      if (first !== undefined && first.startsWith("@")) return { kind: "handle", value: first }
      if (parts.length >= 2) {
        const second = parts[1]!
        if (first === "channel") return { kind: "id", value: second }
        if (first === "user") return { kind: "username", value: second }
        if (first === "c") return { kind: "search", value: second }
      }
    }
  }

  return { kind: "search", value: reference }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The single-shot `Get` this module needs; injected to avoid a cycle. */
export type GetResponse = (
  resource: string,
  params: Params
) => Effect.Effect<DataApiResponse, OytcError>

const firstItem = (response: DataApiResponse): JsonObject | undefined =>
  // Safe: the decoded value came from parseJson, whose leaves are all JsonValue.
  (response.items?.[0] as JsonObject | undefined) ?? undefined

const notFound = (reference: string): NotFoundError =>
  new NotFoundError({ message: `channel ${goQuote(reference)} not found` })

/**
 * `(channelID, requestsUsed)` where `requestsUsed` is 0 or 1.
 *
 * Go returns the partial request count alongside the error; every caller adds
 * it and then discards the total by returning the error, so failing outright
 * is equivalent.
 */
export const resolveChannelWith =
  (get: GetResponse) =>
  (reference: string): Effect.Effect<ResolvedChannel, OytcError> =>
    Effect.gen(function* () {
      // Go's TrimSpace uses unicode.IsSpace, which includes U+0085 and U+00A0
      // but excludes U+FEFF and U+200B. JS `trim` uses WhiteSpace + LineTerminator
      // + U+FEFF — the only divergence is a BOM-padded reference, which JS
      // trims and Go does not.
      const trimmed = reference.trim()
      if (trimmed === "") {
        // Go uses errors.New here, not a UsageError, so this exits 6.
        return yield* Effect.fail(
          new OperationalError({ message: "channel reference cannot be empty" })
        )
      }
      if (CHANNEL_ID_PATTERN.test(trimmed)) return { id: trimmed, requests: 0 }

      const classified = parseChannelReference(trimmed)

      if (classified.kind === "id") {
        if (!CHANNEL_ID_PATTERN.test(classified.value)) {
          return yield* Effect.fail(
            new OperationalError({ message: `invalid channel ID ${goQuote(classified.value)}` })
          )
        }
        return { id: classified.value, requests: 0 }
      }

      if (classified.kind === "search") {
        const response = yield* get("search", [
          ["part", "snippet"],
          ["type", "channel"],
          ["q", classified.value],
          ["maxResults", "1"]
        ])
        const item = firstItem(response)
        if (item === undefined) return yield* Effect.fail(notFound(trimmed))
        // search returns an OBJECT-valued `id`, so the channel ID is nested.
        const id = searchItemChannelId(item)
        if (id._tag === "None" || id.value === "") return yield* Effect.fail(notFound(trimmed))
        return { id: id.value, requests: 1 }
      }

      const params: Params =
        classified.kind === "handle"
          ? [
              ["part", "id"],
              ["forHandle", classified.value.replace(/^@/, "")]
            ]
          : [
              ["part", "id"],
              ["forUsername", classified.value]
            ]

      const response = yield* get("channels", params)
      const item = firstItem(response)
      if (item === undefined) return yield* Effect.fail(notFound(trimmed))
      // channels returns a FLAT string `id`, unlike search.
      const id = channelItemId(item)
      if (id._tag === "None") return yield* Effect.fail(notFound(trimmed))
      return { id: id.value, requests: 1 }
    })

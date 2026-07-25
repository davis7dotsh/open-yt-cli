/**
 * Shared flag definitions.
 *
 * Global flags are attached with `Command.withSharedFlags`, which is the only
 * mechanism that makes them visible to subcommands AND available to
 * `Command.provide`. See root.ts for the mandatory composition order.
 */

import type { Option } from "effect"
import { Flag } from "../effect.ts"
import type { OutputFormat } from "../services/index.ts"

export const FORMATS = ["table", "json", "jsonl", "tsv"] as const

/**
 * `--format` is optional rather than defaulted: the effective default depends
 * on whether stdout is a TTY (table) or a pipe (json), and `live-chat stream`
 * overrides it to jsonl. Resolution happens in resolveGlobals().
 */
export const globalFlags = {
  format: Flag.choice("format", FORMATS).pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Output format (default: table on a terminal, json when piped)"),
    Flag.optional
  ),
  columns: Flag.string("columns").pipe(
    Flag.withDescription("Comma-separated column paths to display"),
    Flag.optional
  ),
  noHeader: Flag.boolean("no-header").pipe(
    Flag.withDescription("Omit the header row in table and tsv output")
  ),
  quiet: Flag.boolean("quiet").pipe(
    Flag.withAlias("q"),
    Flag.withDescription("Suppress the request-count summary on stderr")
  ),
  /**
   * Accepted and ignored, exactly as in Go: "disable color (accepted for
   * scripting; first draft emits no color)". Scripts and CI configs pass it,
   * so rejecting it is a regression even though it has no effect.
   */
  noColor: Flag.boolean("no-color").pipe(
    Flag.withDescription("disable color (accepted for scripting; first draft emits no color)")
  ),
  timeout: Flag.string("timeout").pipe(
    Flag.withDescription("Request timeout, e.g. 20s or 1m30s"),
    Flag.withDefault("20s")
  )
}

export interface GlobalFlagValues {
  readonly format: Option.Option<OutputFormat>
  readonly columns: Option.Option<string>
  readonly noHeader: boolean
  readonly quiet: boolean
  /** Parsed for compatibility and deliberately unused; see globalFlags. */
  readonly noColor: boolean
  readonly timeout: string
}

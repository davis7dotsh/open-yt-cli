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
    Flag.withDescription("Suppress the request-count summary on stderr")
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
  readonly timeout: string
}

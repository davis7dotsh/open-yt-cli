/**
 * The subset of Go's `text/tabwriter` that `oytc` actually exercises:
 *
 *     tabwriter.NewWriter(w, minwidth=0, tabwidth=4, padding=2, padchar=' ', flags=0)
 *
 * This is a direct port of the `Write`/`flush`/`format`/`writeLines` state
 * machine from `$GOROOT/src/text/tabwriter/tabwriter.go`, not an approximation.
 * Reimplementing the algorithm rather than "pad each column to its max width"
 * matters because of three behaviors a naive version gets wrong, all three
 * verified byte-for-byte against the Go implementation:
 *
 *   1. **Trailing whitespace DOES occur.** SPEC_CLI §3.4 claims "every line
 *      therefore has no trailing whitespace". That is FALSE. The last cell on a
 *      line is unpadded only because no width was pushed for its column — but a
 *      column only counts as "last" per line, and `format` skips the final cell
 *      of each line when computing widths. When the final cell is EMPTY, the
 *      preceding cell still gets padded and the line ends in spaces:
 *
 *          columns ["a","b"], items [{a:"xxxx"},{a:"y",b:"bb"}]
 *          => "A     B\nxxxx  \ny     bb\n"
 *                        ^^ two real trailing spaces
 *
 *   2. **`\v` splits a cell and `\f` splits a cell AND forces a flush.**
 *      `clean()` maps only tab/CR/LF to spaces, so a vertical tab or form feed
 *      inside a title survives into the tabwriter input, where both are cell
 *      terminators. A `\f` additionally ends the current block, so the rows
 *      after it get INDEPENDENTLY computed column widths.
 *
 *   3. **A line whose cell count is 1 forces a flush too** (`ncells == 1` in
 *      `Write`). Single-column output therefore never aligns anything — each
 *      line is its own block. Observable: `--columns id` emits every id with no
 *      padding at all, regardless of length differences.
 *
 * Widths are counted in RUNES (`utf8.RuneCount`), so double-width CJK and emoji
 * deliberately misalign; that misalignment is part of the contract.
 */

import { runeLength } from "../util/gostring.ts"

/** minwidth: a column is only as wide as its widest cell plus the padding. */
const MIN_WIDTH = 0

/** padding: added to a cell's width before it becomes the column width. */
const PADDING = 2

interface Cell {
  readonly text: string
  /** Width in runes (code points), not UTF-16 units and not bytes. */
  readonly width: number
  /** True when the cell was terminated by a horizontal tab. */
  readonly htab: boolean
}

/**
 * Run the tabwriter over a raw input stream — the exact byte sequence Go writes
 * into `tabwriter.Writer` (cells joined by `\t`, lines terminated by `\n`).
 *
 * Exported for differential testing against the Go implementation; production
 * callers want `renderTable`.
 */
export const tabwrite = (input: string): string => {
  let out = ""

  // Buffered lines; `lines[lines.length - 1]` is the line being built.
  let lines: Array<Array<Cell>> = [[]]
  // Text accumulated for the cell currently being built.
  let cellText = ""
  // The column-width stack `format` pushes onto as it descends.
  const widths: Array<number> = []

  const writePadding = (textWidth: number, cellWidth: number): void => {
    const n = cellWidth - textWidth
    if (n > 0) out += " ".repeat(n)
  }

  const writeLines = (line0: number, line1: number): void => {
    for (let i = line0; i < line1; i++) {
      const line = lines[i]!
      for (let j = 0; j < line.length; j++) {
        const c = line[j]!
        // Go branches on `c.size == 0`, but with TabIndent and AlignRight both
        // unset the empty and non-empty branches are identical: emit the text
        // (possibly ""), then pad if a width exists for this column.
        out += c.text
        if (j < widths.length) writePadding(c.width, widths[j]!)
      }
      if (i + 1 === lines.length) {
        // The last buffered line has no newline; flush any incomplete cell.
        // `flush` always terminates a non-empty cell first, so this is "".
        out += cellText
      } else {
        out += "\n"
      }
    }
  }

  const format = (line0: number, line1: number): void => {
    const column = widths.length
    let start = line0
    for (let self = start; self < line1; self++) {
      // The final cell of a line is tab-TERMINATED text before the newline and
      // does not belong to a column, hence `length - 1`.
      if (column >= lines[self]!.length - 1) continue

      // Print everything before this column block, then measure the block.
      writeLines(start, self)
      start = self

      let width = MIN_WIDTH
      for (; self < line1; self++) {
        if (column >= lines[self]!.length - 1) break
        const c = lines[self]![column]!
        const w = c.width + PADDING
        if (w > width) width = w
      }
      // DiscardEmptyColumns is not set, so `discardable` never zeroes `width`.

      widths.push(width)
      format(start, self)
      widths.pop()
      start = self
    }
    writeLines(start, line1)
  }

  const terminateCell = (htab: boolean): number => {
    const line = lines[lines.length - 1]!
    line.push({ text: cellText, width: runeLength(cellText), htab })
    cellText = ""
    return line.length
  }

  const flush = (): void => {
    if (cellText.length > 0) terminateCell(false)
    format(0, lines.length)
    // reset()
    lines = [[]]
    cellText = ""
    widths.length = 0
  }

  for (const ch of input) {
    if (ch === "\t" || ch === "\v" || ch === "\n" || ch === "\f") {
      const ncells = terminateCell(ch === "\t")
      if (ch === "\n" || ch === "\f") {
        lines.push([])
        // A form feed always forces a flush. So does a line with exactly one
        // cell, because the last cell of a line never affects the widths of the
        // lines that follow it.
        if (ch === "\f" || ncells === 1) flush()
      }
      continue
    }
    cellText += ch
  }

  flush()
  return out
}

/**
 * Render pre-generated rows (see `columns.generateRows`) as an aligned table.
 *
 * Cells are joined with `\t` and each row is terminated by `\n` — the byte
 * stream Go builds with `fmt.Fprint`/`fmt.Fprintln` — and the whole thing is
 * flushed once at the end.
 */
export const renderTable = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  let input = ""
  for (const row of rows) input += `${row.join("\t")}\n`
  return tabwrite(input)
}

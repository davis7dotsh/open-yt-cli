/**
 * `--format tsv`: the same row generator as `table`, written straight to the
 * output with no tabwriter in between.
 *
 * Fields are separated by a single literal `\t`, rows by `\n`, with no padding
 * and no alignment. `clean()` has already replaced any tab inside a cell with a
 * space, so the separator is unambiguous — but `\v` and `\f` are NOT cleaned
 * and pass through verbatim here (unlike in `table`, where they split cells).
 */

export const renderTsv = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  let out = ""
  for (const row of rows) out += `${row.join("\t")}\n`
  return out
}

/**
 * Dim-join NULL heuristic (Phase 6 of trace-2026-05-21 plan).
 *
 * Symptom: agent joins a fact table to dim.Client / dim.Branch / dim.Product
 * etc. on what it *thinks* is the correct key, but the join silently
 * mis-matches and the *Name / *Description columns come back almost
 * entirely NULL. The numeric aggregates still SUM (they live in the fact
 * table) so nothing looks wrong — until the user reads the row labels.
 *
 * Heuristic: scan the result rows for columns whose name ends in `Name`
 * or `Description` (case-insensitive). If ≥ NULL_FRACTION_THRESHOLD of
 * the rows have a NULL value in that column AND the rowset has at least
 * `MIN_ROWS_FOR_SIGNAL` rows, surface a banner.
 *
 * The banner does NOT block — sometimes a dim row legitimately has no
 * name (e.g. a placeholder "unassigned" client). The agent is expected
 * to read the hint and either (a) re-verify the join key with
 * explore_mssql_schema, or (b) explicitly note that NULLs are expected.
 */

export const NULL_FRACTION_THRESHOLD = 0.5
export const MIN_ROWS_FOR_SIGNAL = 4
const DIM_LABEL_COLUMN = /(?:Name|Description)$/i

export interface DimJoinNullFinding {
  readonly column: string
  readonly nullCount: number
  readonly totalRows: number
  readonly nullFraction: number
}

/**
 * Inspect a single recordset for likely-broken dim joins.
 *
 * Accepts an array of plain row objects (the shape returned by `mssql`'s
 * `result.recordsets[i]`). Returns one finding per offending column,
 * sorted by descending null-fraction. Empty array ⇒ no findings.
 */
export function detectDimJoinNullRot(
  rows: ReadonlyArray<Record<string, unknown>>,
): DimJoinNullFinding[] {
  if (rows.length < MIN_ROWS_FOR_SIGNAL) return []
  const sample = rows[0]
  if (!sample || typeof sample !== "object") return []
  const findings: DimJoinNullFinding[] = []
  for (const col of Object.keys(sample)) {
    if (!DIM_LABEL_COLUMN.test(col)) continue
    let nullCount = 0
    for (const row of rows) {
      const v = row[col]
      if (v === null || v === undefined) nullCount += 1
    }
    const nullFraction = nullCount / rows.length
    if (nullFraction >= NULL_FRACTION_THRESHOLD) {
      findings.push({ column: col, nullCount, totalRows: rows.length, nullFraction })
    }
  }
  return findings.sort((a, b) => b.nullFraction - a.nullFraction)
}

/**
 * Render a banner describing the findings, suitable for prepending to
 * the formatted result body. Returns `null` if there are no findings.
 */
export function renderDimJoinNullBanner(
  findings: ReadonlyArray<DimJoinNullFinding>,
): string | null {
  if (findings.length === 0) return null
  const lines = [
    `⚠ JOIN-KEY LIKELY WRONG — review BEFORE trusting the row labels below:`,
    ``,
  ]
  for (const f of findings) {
    const pct = Math.round(f.nullFraction * 100)
    lines.push(`  • column \`${f.column}\` is NULL in ${f.nullCount} of ${f.totalRows} rows (${pct}%)`)
  }
  lines.push(``)
  lines.push(`This usually means the dim-join key is wrong (e.g. joining on \`pkClient\` when the fact uses \`pkClientHistory\`).`)
  lines.push(`Fix: call \`explore_mssql_schema table='<dim>'\` to confirm the PK, then re-run the query with the correct join column.`)
  lines.push(`If the NULLs are expected (e.g. unassigned/placeholder rows), state that explicitly in the answer.`)
  lines.push(`---`)
  return lines.join("\n")
}

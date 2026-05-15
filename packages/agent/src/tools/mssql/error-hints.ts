/**
 * MSSQL error → recovery hint formatter.
 *
 * The agent's biggest failure mode on the SQL tool is *retrying the same shape*
 * after a SQL error. Raw mssql error text ("Invalid column name 'Name'.") is
 * too terse to break that loop — the next LLM turn often just renames `Name`
 * to `name` or guesses again.
 *
 * This module pattern-matches the most common errors and appends an actionable
 * hint that tells the model exactly what to do differently:
 *   - call explore_mssql_schema before rewriting
 *   - wrap a bit aggregate in CAST
 *   - swap a Postgres/Snowflake keyword for the T-SQL equivalent
 *
 * Errors that don't match any pattern pass through unchanged.
 */

interface ErrorHint {
  /** Pattern matched against the raw mssql error message. */
  match: RegExp
  /** Function returning the hint string given the regex match. */
  hint: (m: RegExpExecArray) => string
}

const HINTS: ErrorHint[] = [
  {
    match: /Invalid column name '([^']+)'/i,
    hint: (m) =>
      `HINT: Column '${m[1]}' does not exist on the referenced table. STOP guessing — ` +
      `call explore_mssql_schema(table='schema.Table') to list real columns, then rewrite ` +
      `the query. Generic names like Name / Balance / Date / Amount usually do not exist verbatim — ` +
      `this DB uses pk-prefixed keys (pkClient, pkMonth, pkDate) and explicit suffixes.`,
  },
  {
    match: /Invalid object name '([^']+)'/i,
    hint: (m) =>
      `HINT: Object '${m[1]}' does not exist (or wrong schema). Call search_catalog(search='${m[1].split(".").pop()}') ` +
      `to find the correct schema-qualified name before retrying. Always use the schema prefix (e.g. publish.Revenue, not Revenue).`,
  },
  {
    match: /Operand data type bit is invalid for (min|max|sum|avg) operator/i,
    hint: (m) =>
      `HINT: ${m[1].toUpperCase()} on a bit column is not supported. Wrap it: ` +
      `${m[1].toUpperCase()}(CAST(col AS int)). Confirm the column type via explore_mssql_schema first.`,
  },
  {
    match: /Incorrect syntax near 'QUALIFY'/i,
    hint: () =>
      `HINT: QUALIFY is Snowflake/BigQuery syntax — not T-SQL. Use ROW_NUMBER() OVER (...) inside ` +
      `a CTE or subquery, then filter the rank in the outer query.`,
  },
  {
    match: /Incorrect syntax near 'LIMIT'/i,
    hint: () =>
      `HINT: LIMIT is not T-SQL. Use SELECT TOP n …, or OFFSET m ROWS FETCH NEXT n ROWS ONLY.`,
  },
  {
    match: /Incorrect syntax near 'ILIKE'/i,
    hint: () =>
      `HINT: ILIKE is Postgres syntax. T-SQL collations are usually case-insensitive — use LIKE; ` +
      `or force lowercase: LOWER(col) LIKE LOWER('…').`,
  },
  {
    match: /Incorrect syntax near 'OFFSET'/i,
    hint: () =>
      `HINT: T-SQL OFFSET requires the full form: ORDER BY col OFFSET n ROWS FETCH NEXT m ROWS ONLY. ` +
      `Bare OFFSET / LIMIT (Postgres style) does not work.`,
  },
  {
    match: /Conversion failed when converting (?:date|datetime|the varchar value)/i,
    hint: () =>
      `HINT: T-SQL date parsing is strict. Use explicit CONVERT(date, '2025-01-01', 23) (ISO 8601 = style 23) ` +
      `or DATEFROMPARTS(year, month, day) instead of relying on implicit conversion.`,
  },
  {
    match: /must be the first statement in a query batch/i,
    hint: () =>
      `HINT: Some statements (CREATE PROCEDURE, CREATE VIEW, CTE WITH …) must be the first/only thing in the batch. ` +
      `Split the batch into separate executions, or use a temp table to stage data instead of a CTE.`,
  },
  {
    match: /A CREATE INDEX statement is not allowed on a view/i,
    hint: () =>
      `HINT: You cannot CREATE INDEX on a view (only on tables, including #temp tables). Stage the view data into a #temp table first, then index the #temp.`,
  },
  {
    match: /timeout|timed out/i,
    hint: () =>
      `HINT: Query timed out. Almost certainly a full scan of a large object. Refactor as a micro-ETL: ` +
      `SELECT … INTO #scope FROM <small filtered slice>; CREATE INDEX on #scope keys; then join the big view to #scope.`,
  },
]

/**
 * Decorate an mssql error message with a recovery hint if any pattern matches.
 * Returns the original message unchanged if no hint applies.
 */
export function decorateMssqlError(rawMessage: string): string {
  for (const { match, hint } of HINTS) {
    const m = match.exec(rawMessage)
    if (m) return `${rawMessage}\n\n${hint(m)}`
  }
  return rawMessage
}

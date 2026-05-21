// Doctrine fixHint registry — code → canonical refactor advice.
//
// This module has NO imports on purpose: both the validator
// (packages/agent/src/tools/mssql/validation.ts) and the doctrine
// modules import from here, so any dependency would create a cycle.
//
// Each entry is one paragraph, doctrine-owned, and shown verbatim to
// the agent on a block. Keep them short, mechanical, and shape-focused
// — the agent has already seen the rule body in the system prompt; on
// failure it needs the fix shape, not another lecture.

export const DOCTRINE_FIX_HINTS: Readonly<Record<string, string>> = {
  aggregate_semantic_mismatch: [
    "Change the aggregate function to match the alias (or vice-versa).",
    "The function name is the implementation; the output alias is the contract with the reader. They MUST agree.",
    "Common cases: `SUM(...) AS Avg…` → use `AVG(...)`. `SUM(...MTD)` over multiple months → use `AVG(...)` or pick a single `pkMonth` row.",
  ].join(" "),

  temp_table_integrity: [
    "Pick one 8-hex suffix at the top of the batch (e.g. `a3f91c08`) and reuse it literally in every #temp name, every index name and every DROP.",
    "Create every #temp in the same single batch that reads it: in a pooled connection a #temp from a prior call may not exist.",
    "If a previous call already failed, do not assume staged temps survived — restart the batch from CREATE.",
    "Send the whole micro-ETL as ONE query_mssql call (one batch). Never split CREATE / INSERT / SELECT across multiple tool calls.",
  ].join(" "),

  temp_scalar_subquery_overused: [
    "Aggregate the staged #temp ONCE per business key (usually pkClient), produce all needed metrics in that single grouped result, then JOIN that small aggregate once.",
    "Bad shape:  SELECT ..., (SELECT COUNT(*) FROM #revLines_x WHERE ...), (SELECT SUM(...) FROM #revLines_x WHERE ...)",
    "Good shape: WITH revAgg AS (SELECT pkClient, COUNT(*) AS Lines, SUM(...) AS Revenue FROM #revLines_x GROUP BY pkClient) SELECT ... FROM base LEFT JOIN revAgg ON revAgg.pkClient = base.pkClient",
  ].join(" "),

  large_object_overused: [
    "Refactor to the two-stage pattern: Stage 1 narrows keys into a #temp (one touch of the big view), Stage 2 fetches detail rows for those keys (second and last touch).",
    "Derive every remaining metric from the #temp \u2014 never re-query the big view a third time.",
  ].join(" "),
}

export function getDoctrineFixHint(code: string): string | null {
  return DOCTRINE_FIX_HINTS[code] ?? null
}

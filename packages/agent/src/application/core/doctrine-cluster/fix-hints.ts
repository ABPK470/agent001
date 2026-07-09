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
    "Common cases: `SUM(...) AS Avg…` → use `AVG(...)`. `SUM(...Snapshot)` / `SUM(...EOM)` / `SUM(...Spot)` — these are point-in-time values: use `AVG(...)` or pick the `MAX(<dateKey>)` row.",
    "NOTE: columns suffixed `…MTD / …YTD / …QTD / …WTD` ARE summable in this warehouse — they are row-grain period slices, not cumulative snapshots. SUM them within their period key (`pkMonth` / `pkYear` / …) normally.",
    "If you are unsure whether a column is summable, call `profile_data table=<schema.Table> columns=[<column>]` first — it reports distribution and distinct-cardinality clues that distinguish snapshot columns from period-additive ones.",
    'Once confirmed, save the finding with `note subject=<schema.Table.Column> claim="<summable | snapshot> — <one-line rule>" category=column_semantics` so the next turn does not re-derive it.'
  ].join(" "),

  temp_table_integrity: [
    "Pick one 8-hex suffix at the top of the batch (e.g. `a3f91c08`) and reuse it literally in every #temp name, every index name and every DROP.",
    "Create every #temp in the same single batch that reads it: in a pooled connection a #temp from a prior call may not exist.",
    "If a previous call already failed, do not assume staged temps survived — restart the batch from CREATE.",
    "Send the whole micro-ETL as ONE query_mssql call (one batch). Never split CREATE / INSERT / SELECT across multiple tool calls.",
    "If the staged set is too large to keep alive across a single batch, materialize it instead with `export_query_to_file` and read it back with a follow-up SELECT — that is the supported cross-batch handoff, not a #temp."
  ].join(" "),

  temp_scalar_subquery_overused: [
    "Aggregate the staged #temp ONCE per business key (usually pkClient), produce all needed metrics in that single grouped result, then JOIN that small aggregate once.",
    "Bad shape:  SELECT ..., (SELECT COUNT(*) FROM #revLines_x WHERE ...), (SELECT SUM(...) FROM #revLines_x WHERE ...)",
    "Good shape: WITH revAgg AS (SELECT pkClient, COUNT(*) AS Lines, SUM(...) AS Revenue FROM #revLines_x GROUP BY pkClient) SELECT ... FROM base LEFT JOIN revAgg ON revAgg.pkClient = base.pkClient",
    "If you don't yet know which key joins the #temp to the outer table, call `discover_relationships between=[#yourTemp, <sourceTable>]` (or the equivalent for the underlying base tables) — it returns FK candidates and key cardinality so you can pick the right GROUP BY."
  ].join(" "),

  large_object_overused: [
    "Refactor to the two-stage pattern: Stage 1 narrows keys into a #temp (one touch of the big view), Stage 2 fetches detail rows for those keys (second and last touch).",
    "Derive every remaining metric from the #temp — never re-query the big view a third time.",
    "When the second stage still needs to fan out across many tables, prefer `export_query_to_file` for the stage-1 keys and join from the exported file rather than re-touching the big view."
  ].join(" "),

  publish_view_topn_without_branch_aggregation: [
    "Do branch-local aggregation. Aggregate inside each required source branch first, UNION ALL the small per-branch results, then re-aggregate and rank.",
    "Skeleton:  SELECT TOP N x.<keyCol>, SUM(x.<metric>) AS <metric> INTO #top_<suffix> FROM ( SELECT <keyCol>, SUM(<sourceMetric>) AS <metric> FROM <schema>.<BranchA> WITH (NOLOCK) WHERE <dateKey> BETWEEN @from AND @to GROUP BY <keyCol> UNION ALL SELECT <keyCol>, SUM(<sourceMetric>) AS <metric> FROM <schema>.<BranchB> WITH (NOLOCK) WHERE <dateKey> BETWEEN @from AND @to GROUP BY <keyCol> /* repeat per required branch */ ) x GROUP BY x.<keyCol> ORDER BY SUM(x.<metric>) DESC, x.<keyCol>;",
    "Branch names come from curated lineage: call `search_catalog lineage=<wide-union-view>` to get the exact branch list — do NOT guess branch names.",
    "Only after #top_<suffix> exists, do Stage 2: `SELECT … INTO #detail FROM <wide-union-view> WHERE <keyCol> IN (SELECT <keyCol> FROM #top_<suffix>)`. That second touch is fine — it has a tiny IN-list.",
    "Escape valve: if you already have a small #temp narrowing the <keyCol> set, joining to it (`JOIN #scope s ON s.<keyCol> = r.<keyCol>`) lets the optimizer push the small set into each UNION branch — that pattern is allowed."
  ].join(" "),

  avg_of_coalesce_zero: [
    "Drop the COALESCE/ISNULL inside AVG: T-SQL `AVG(col)` already skips NULLs, so `AVG(col)` returns the true mean of observed values.",
    "If you genuinely want to treat missing months as observed zeros, make the assumption explicit: compute `SUM(COALESCE(col, 0)) / NULLIF(<MonthsExpected>, 0)` with a stated denominator.",
    "Default behaviour for balance / revenue averages over a date range: AVG of non-null observations. Document the period and the row count alongside the figure."
  ].join(" "),

  invented_column: [
    "Stop. The column does not exist on the table you aliased — confirm column names via `search_catalog mode=column column=<name>` (or `mode=table table=<schema.table>`) BEFORE writing the next SQL.",
    "Common failure mode: the model imagines display-name columns (`<X>Name`, `fullName`, …) on transactional / fact / wide-union views. Those views carry foreign keys to dimension tables; the display name lives on the corresponding dimension — join to the dim.* table to fetch it.",
    "If the catalog is stale (the column was just added), call `refresh_catalog` and retry. Never invent a column to make a query 'feel right' — the validator will block it and the row would have been NULL anyway."
  ].join(" "),

  unverified_table_reference: [
    "Discover EVERY table before writing SQL. For each table in your final JOIN list, call `search_catalog(table='schema.Table')` or `explore_mssql_schema(table='schema.Table')` and read the column list.",
    "Do not explore only the fact table and guess dimension columns — `dim.Client` uses `ClientName`, not `Name`.",
    "Workflow: (1) list all tables needed, (2) verify each, (3) write one batch query_mssql using only columns you saw."
  ].join(" "),

  union_group_by_illegal: [
    "Each SELECT inside UNION / UNION ALL must carry its own GROUP BY when aggregating.",
    "Bad: `SELECT … FROM t1 UNION ALL SELECT … FROM t2 GROUP BY x`.",
    "Good: aggregate inside each branch, or wrap the UNION in a CTE and GROUP BY on the outer query."
  ].join(" ")
}

export function getDoctrineFixHint(code: string): string | null {
  return DOCTRINE_FIX_HINTS[code] ?? null
}

// ── Doctrine lesson templates (Gap 2) ────────────────────────────
//
// Each block-emitting doctrine MAY define a lesson template — a pure function
// that converts the (query, analysis) context of the block into a
// `NoteLessonPayload`. The mssql tool call site fires the lesson at the
// agent-runtime memory writer, which routes it to ingestAgentNote on the
// server. The net effect is that a doctrine block writes one durable
// "do not repeat this mistake" entry into working memory, without the LLM
// having to make a separate `note` tool call.
//
// Lesson templates are intentionally simple. They return null when they
// cannot produce a useful subject/claim from the available context (e.g.
// the query is too short to extract a recognizable table or alias). Null
// means "no auto-note this time" — the doctrine block still fires, the
// fix hint is still shown; only the durable memory write is skipped.
//
// Subjects use `doctrine:<rule-id>:<short-locator>` so multiple blocks of
// the same rule on different artifacts produce distinct memory entries
// (dedup within a session is a feature; collapsing across distinct
// artifacts would be a bug).

export interface NoteLessonPayload {
  subject: string
  claim: string
  evidence?: string
  category: "schema_fact" | "column_semantics" | "performance" | "observation"
}

export interface LessonContext {
  query: string
  /** Subset of analysis used by templates. Optional so callers can pass {}. */
  detail?: string
}

export type DoctrineLessonTemplate = (ctx: LessonContext) => NoteLessonPayload | null

/**
 * Truncate a string to `max` chars (whole-codepoint-safe, with ellipsis).
 * Used so a long offending SELECT doesn't blow the lesson body.
 */
function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return t.slice(0, Math.max(0, max - 1)) + "…"
}

export const DOCTRINE_LESSON_TEMPLATES: Readonly<Record<string, DoctrineLessonTemplate>> = {
  aggregate_semantic_mismatch: (ctx) => {
    // The detail field carries the validator's single-line snippet of the
    // offending aggregate (e.g. "SUM(RevenueZARMTD) AS AvgRev"). We use it
    // as the subject locator so two distinct mismatches in the same run
    // don't collapse into a single memory entry.
    const snippet = ctx.detail ? shorten(ctx.detail, 80) : null
    if (!snippet) return null
    return {
      subject: `doctrine:aggregate-semantic-mismatch:${snippet}`,
      claim:
        "Aggregate function and output alias must agree. " +
        "Confirm column summability with `profile_data` before choosing SUM vs AVG; " +
        "for *Snapshot / *EOM / *Spot / *Latest columns the answer is almost always AVG (or single-row), not SUM. " +
        "`*MTD / *YTD / *QTD / *WTD` columns ARE summable within their period key in this warehouse.",
      evidence: `Blocked shape: ${snippet}`,
      category: "column_semantics"
    }
  },

  temp_table_integrity: (ctx) => {
    // For temp-table integrity the validator emits a sentence naming the
    // offending #temp(s). We pass that through as the detail so the lesson
    // pins the actual identifier. If unavailable, fall back to a query
    // fingerprint so two different batches with the same class of bug get
    // distinct entries.
    const locator = ctx.detail ? shorten(ctx.detail, 100) : shorten(ctx.query, 60)
    return {
      subject: `doctrine:temp-table-integrity:${locator}`,
      claim:
        "Send the whole #temp micro-ETL as ONE query_mssql call. " +
        "Reuse one 8-hex suffix across every CREATE/INSERT/SELECT/DROP. " +
        "If state must survive across batches, use `export_query_to_file` and read the file back — not a #temp.",
      category: "observation"
    }
  },

  temp_scalar_subquery_overused: (ctx) => {
    const locator = ctx.detail ? shorten(ctx.detail, 100) : shorten(ctx.query, 60)
    return {
      subject: `doctrine:temp-scalar-subquery:${locator}`,
      claim:
        "Aggregate the staged #temp ONCE per business key (usually pkClient) and join the small grouped result. " +
        "Use `discover_relationships` to confirm the join key before grouping.",
      evidence: ctx.detail ? `Blocked locator: ${ctx.detail}` : undefined,
      category: "performance"
    }
  },

  publish_view_topn_without_branch_aggregation: (ctx) => {
    const locator = ctx.detail ? shorten(ctx.detail, 100) : shorten(ctx.query, 60)
    return {
      subject: `doctrine:publish-view-topn-branch-agg:${locator}`,
      claim:
        "Wide UNION views cannot be ranked with a direct TOP-N + GROUP BY on a high-cardinality key — that scans every UNION branch and times out. " +
        "Always aggregate per source-mapping branch first, UNION ALL the branch-local aggregates, then rank. " +
        "Get the branch list from `search_catalog lineage=<view>`.",
      evidence: ctx.detail ? `Blocked locator: ${ctx.detail}` : undefined,
      category: "performance"
    }
  },

  avg_of_coalesce_zero: (ctx) => {
    const snippet = ctx.detail ? shorten(ctx.detail, 80) : null
    if (!snippet) return null
    return {
      subject: `doctrine:avg-of-coalesce-zero:${snippet}`,
      claim:
        "Never wrap NULL in COALESCE(..., 0) inside AVG — it understates the true average by counting missing observations as observed zeros. " +
        "Use AVG(col) directly (AVG already skips NULLs), or compute an explicit weighted average with a stated denominator.",
      evidence: `Blocked shape: ${snippet}`,
      category: "column_semantics"
    }
  },

  invented_column: (ctx) => {
    const locator = ctx.detail ? shorten(ctx.detail, 100) : shorten(ctx.query, 60)
    return {
      subject: `doctrine:invented-column:${locator}`,
      claim:
        "Catalog-verify every qualified column reference before writing SQL — the validator blocks references whose column does not exist on the aliased table. " +
        "Display names (ClientName, BankerName) live on dim.* tables; fact/publish views carry FKs only. Use `search_catalog` to confirm the column lives where you think it does.",
      evidence: ctx.detail ? `Blocked reference: ${ctx.detail}` : undefined,
      category: "schema_fact"
    }
  }
}

export function getDoctrineLessonTemplate(code: string): DoctrineLessonTemplate | null {
  return DOCTRINE_LESSON_TEMPLATES[code] ?? null
}

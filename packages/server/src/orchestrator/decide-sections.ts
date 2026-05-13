/**
 * Goal-aware system-prompt section gating.
 *
 * Without this, every run shipped the full database knowledge body
 * (~12K tokens), the chart-spec catalogue (~120 lines), the MSSQL
 * orchestration guidance (~80 lines) and the memory-context trailer
 * (~30 lines) — regardless of whether the goal needed any of them.
 * On the canonical "what can you tell me about these logs?" trace
 * that was 245K input tokens for 4 calls.
 *
 * `decideSections` looks at the goal text and currently-injected
 * memory tiers and returns a small set of booleans the assemblers in
 * `system-messages.ts` and `prompt-builder.ts` honour. Heuristics
 * mirror the existing `isSyncRelatedGoal` pattern: a regex-based
 * classifier; deliberately not LLM-based — the cost of a misroute
 * (one extra discovery call) is far less than always shipping every
 * block.
 */

export interface SectionDecision {
  /** Inject the ABI-sync SME block. */
  includeAbiSync:        boolean
  /** Include the MSSQL "DATA TOOLS / RULES / EFFICIENCY" guidance prose. */
  includeMssqlGuidance:  boolean
  /** Include the per-connection knowledge body (the largest single block). */
  includeMssqlKnowledge: boolean
  /** Include the live schema-catalog summary. */
  includeMssqlCatalog:   boolean
  /**
   * Include the chart-kinds reference. True ONLY when the goal explicitly
   * mentions a chart / graph / plot / dashboard / etc.; otherwise the model
   * fetches the catalogue on demand via the `get_chart_specs` tool. We used
   * to also imply `isVisual` from `isDbLike` (analytics → likely visual),
   * but that shipped ~5 KB per call on every DB goal where the user never
   * actually asked for a chart. Tool-on-demand is cheaper.
   */
  includeChartCatalogue: boolean
  /** Append the memory-XML-tag guidance trailer. Only useful when a tier is present. */
  includeMemoryGuidance: boolean
}

const SYNC_RE = /\bsync\b.*\benviron|\benviron.*\bsync\b|\babi.sync\b|\bsync.preview\b|\bsync.execute\b|\blist.environments\b|\bcompare.catalog|\buspSync|\bmymi\b|\bpipelineActivity\b|\bgateMetadata\b|\bsync.contract\b|\bcontract.sync\b|\bsync.recipe\b|\bsync.entity\b|\benv.sync\b/i

// Words that indicate the goal is database-shaped. Conservative on
// purpose — false positives cost a few thousand tokens; false negatives
// cost a follow-up tool call. We bias to "include when in doubt".
const DB_RE = /\b(sql|t-sql|tsql|mssql|sqlserver|database|schema|tables?|columns?|rows?|join(s|ed|ing)?|select|from\s+\w|where\s+\w|group\s+by|order\s+by|index(es|ing)?|view(s)?|stored?\s+proc|catalog|lineage|fact|dim\.|publish\.|archive|persistedView|core\.|gate\.|agent\.PipelineRun|query|queries|profile_data|inspect_definition|search_catalog|explore_mssql|discover_relationships|export_query|dwh|warehouse|client(s)?|revenue|balances?|merchant|risk|rwa|impairment|trading|markets?|sales\s+credits?|africa(flex|brains)|FrontArena|UnoTranspose|IMEX|recipe|pipeline\s+(run|status)|etl|dataset(s)?|rule(s)?\s+(test|created|modified|engine))\b/i

// "Visual" intent — any of these usually benefits from the chart catalogue.
const CHART_RE = /\b(chart|charts|graph|graphs|graphed|plot|plots|plotted|visuali[sz]e|visuali[sz]ation|dashboard|kpi|kpis|trend(s)?|distribution|breakdown|histogram|heatmap|relationship\s+map|diagram|figure|render)\b/i

export function decideSections(opts: {
  goal:    string
  memory?: { working?: string; episodic?: string; semantic?: string }
}): SectionDecision {
  const goal       = opts.goal ?? ""
  const isSync     = SYNC_RE.test(goal)
  const isDbLike   = DB_RE.test(goal) || isSync
  // Chart catalogue requires EXPLICIT visual intent. DB-shaped goals no
  // longer auto-include it — the model can call `get_chart_specs` if it
  // decides a visualisation is warranted.
  const isVisual   = CHART_RE.test(goal)
  const hasMemory  = !!(opts.memory && (opts.memory.working || opts.memory.episodic || opts.memory.semantic))

  return {
    includeAbiSync:        isSync,
    includeMssqlGuidance:  isDbLike,
    includeMssqlKnowledge: isDbLike,
    includeMssqlCatalog:   isDbLike,
    includeChartCatalogue: isVisual,
    includeMemoryGuidance: hasMemory,
  }
}

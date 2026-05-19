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
  /**
   * Include the big-table / micro-ETL discipline section (canonical
   * #temp staging pattern + anti-patterns). Same trigger as
   * `includeMssqlGuidance` — fires whenever the goal looks DB-shaped.
   */
  includeBigTableEtl:    boolean
  /** Include the per-connection knowledge body (the largest single block). */
  includeMssqlKnowledge: boolean
  /**
   * Granularity for the knowledge body when `includeMssqlKnowledge` is true.
   *
   *  - "full"   — full body (`mymi-knowledge.md` per connection). Used when
   *               the goal is strongly DB-shaped (score ≥ 4) or sync, where
   *               column-level accuracy actually matters this turn.
   *  - "header" — first paragraph + namespace summary only (~600B), with a
   *               note telling the agent the rest is available via the
   *               discovery tools. Used for borderline DB goals (score 2-3)
   *               where mentioning the warehouse is plausible but a 5-15 KB
   *               prose dump is overkill.
   */
  mssqlKnowledgeMode:    "full" | "header"
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
  /**
   * Inject the MIA data persona block (HARD RULES on column verification,
   * MyMI SME context, banker/controller anchors, data tool hierarchy,
   * insight discipline, monetary formatting). Fires whenever the goal is
   * DB-shaped, chart-shaped, or sync-shaped. Generic engineering / coding
   * tasks skip it — they get the generic operating manual only.
   */
  includeDataPersona:    boolean
  /**
   * Optional debug payload. Additive — kept here so tests and the run
   * trace can assert on / log *why* a gate fired. Not consumed by the
   * prompt assembler.
   */
  dbScore?: number
  triggers?: {
    operational: boolean
    domain:      boolean
    tableHint:   boolean
    nonDb:       boolean
    sync:        boolean
  }
}

const SYNC_RE = /\bsync\b.*\benviron|\benviron.*\bsync\b|\babi.sync\b|\bsync.preview\b|\bsync.execute\b|\blist.environments\b|\bcompare.catalog|\buspSync|\bmymi\b|\bpipelineActivity\b|\bgateMetadata\b|\bsync.contract\b|\bcontract.sync\b|\bsync.recipe\b|\bsync.entity\b|\benv.sync\b/i

// ── DB gate — two-signal scorer ────────────────────────────────────
//
// Replaces the previous flat `DB_RE` OR-list. Three orthogonal signals:
//
//   DB_OPERATIONAL_RE — strong SQL / platform / tool tokens. If this
//     fires, we are very confident this is a DB task regardless of any
//     other cue (it cancels the NON_DB down-score).
//
//   DB_DOMAIN_RE — banking / DWH domain vocabulary. In THIS product these
//     terms almost always refer to the data warehouse (the user's chief
//     concern was that "visualize revenue by client" must trigger DB
//     blocks even though it has zero SQL syntax). Domain alone is
//     sufficient to fire the gate.
//
//   NON_DB_RE — narrowly scoped to "this is not a data-warehouse task at
//     all" cues (Monte Carlo, mockup, Sharpe ratio, etc.). DESIGN RULE:
//     rendering verbs (chart / plot / visualize / render / dashboard /
//     animated) MUST NEVER appear here — they're orthogonal to data
//     source and would false-negative legitimate DWH-viz questions.
//
// Scoring:
//   +2  DB_OPERATIONAL_RE
//   +2  DB_DOMAIN_RE
//   +1  TABLE_DB_HINT_RE | DB_TABLE_HINT_RE
//   +3  SYNC_RE
//   −3  NON_DB_RE matches AND DB_OPERATIONAL_RE does NOT match
// isDbLike = score >= 2.
const DB_OPERATIONAL_RE = /\b(sql|t-sql|tsql|mssql|sqlserver|select|from\s+\w|where\s+\w|group\s+by|order\s+by|join(s|ed|ing)?|query|queries|schema|columns?|rows?|view(s)?|stored?\s+proc|catalog|lineage|fact\.|dim\.|publish\.|core\.|gate\.|persistedView|agent\.PipelineRun|search_catalog|explore_mssql|inspect_definition|discover_relationships|query_mssql|profile_data|export_query|dwh|warehouse|etl|dataset(s)?|pipeline\s+(run|status)|recipe|database)\b/i

const DB_DOMAIN_RE = /\b(client(s)?|customer(s)?|banker(s)?|revenue|balances?|merchant(s)?|risk|rwa|impairment|trading|markets?|sales\s+credits?|africa(flex|brains)|FrontArena|UnoTranspose|IMEX|country(ies)?|branch(es)?|cost\s+cent(re|er)|counterparty|facility|book\s+group|segment|breakdown)\b/i

// "Non-DB task type" cues only. NEVER add rendering verbs here.
const NON_DB_RE = /\b(monte\s*carlo|simulation|mockup|mock-up|wireframe|prototype|sharpe\s+ratio|black.scholes|brownian|stochastic\s+process|geometric\s+brownian)\b/i

// "table" only counts as a DB signal when it co-occurs with a clearly
// DB-shaped qualifier in the same goal. This catches "table in the
// fact schema", "list tables", "describe table dim.X" — without
// catching "render the table you just did" or "recreate the table".
const TABLE_DB_HINT_RE = /\b(table(s)?)\b[^.\n]{0,80}\b(in\s+(the\s+)?(database|schema|db)|schema|sql|database|db|join|column|row|query|publish|fact|dim|core|gate|persistedView|archive)\b/i
const DB_TABLE_HINT_RE = /\b(database|schema|sql|join|column|row|query|publish|fact|dim|core|gate|persistedView|archive)\b[^.\n]{0,80}\b(table(s)?)\b/i

// "Visual" intent — any of these usually benefits from the chart catalogue.
const CHART_RE = /\b(chart|charts|graph|graphs|graphed|plot|plots|plotted|visuali[sz]e|visuali[sz]ation|dashboard|kpi|kpis|trend(s)?|distribution|breakdown|histogram|heatmap|relationship\s+map|diagram|figure|render)\b/i

export interface DbScoreResult {
  score:       number
  operational: boolean
  domain:      boolean
  tableHint:   boolean
  nonDb:       boolean
  sync:        boolean
}

/** Compute the DB-likelihood score for a goal. Exported for telemetry / tests. */
export function scoreDbLikelihood(goal: string): DbScoreResult {
  const operational = DB_OPERATIONAL_RE.test(goal)
  const domain      = DB_DOMAIN_RE.test(goal)
  const tableHint   = TABLE_DB_HINT_RE.test(goal) || DB_TABLE_HINT_RE.test(goal)
  const nonDb       = NON_DB_RE.test(goal)
  const sync        = SYNC_RE.test(goal)

  let score = 0
  if (operational)             score += 2
  if (domain)                  score += 2
  if (tableHint)               score += 1
  if (sync)                    score += 3
  if (nonDb && !operational)   score -= 3

  return { score, operational, domain, tableHint, nonDb, sync }
}

export function decideSections(opts: {
  goal:    string
  memory?: { working?: string; episodic?: string; semantic?: string }
}): SectionDecision {
  const goal       = opts.goal ?? ""
  const db         = scoreDbLikelihood(goal)
  const isDbLike   = db.score >= 2
  // Chart catalogue requires EXPLICIT visual intent. DB-shaped goals no
  // longer auto-include it — the model can call `get_chart_specs` if it
  // decides a visualisation is warranted.
  const isVisual   = CHART_RE.test(goal)
  const hasMemory  = !!(opts.memory && (opts.memory.working || opts.memory.episodic || opts.memory.semantic))

  return {
    includeAbiSync:        db.sync,
    includeMssqlGuidance:  isDbLike,
    includeMssqlKnowledge: isDbLike,
    // Strong DB intent (score ≥ 4) or any sync goal → full knowledge body;
    // borderline DB intent → header-only. Single-signal hits (score 2-3:
    // e.g. just "join" or just "schema" in the goal) shouldn't ship the
    // full warehouse manual.
    mssqlKnowledgeMode:    (db.score >= 4 || db.sync) ? "full" : "header",
    includeMssqlCatalog:   isDbLike,
    includeBigTableEtl:    isDbLike,
    includeChartCatalogue: isVisual,
    includeMemoryGuidance: hasMemory,
    includeDataPersona:    isDbLike || isVisual || db.sync,
    dbScore:               db.score,
    triggers: {
      operational: db.operational,
      domain:      db.domain,
      tableHint:   db.tableHint,
      nonDb:       db.nonDb,
      sync:        db.sync,
    },
  }
}

// ── Tool-eagerness gating ──────────────────────────────────────────
//
// Mirror of `decideSections`, but for the **tool list** sent to the LLM.
//
// Until now there were two parallel concerns: which *prose sections* to
// inject (handled by `decideSections`) and which *tools* to advertise
// (handled by nothing — every run got the full registry). The second
// concern is what produced the trace where a trivial "Hi" still saw the
// agent reach for `search_catalog(stats=true)`: when MSSQL and sync
// tools sit in the registry, their descriptions appear in the LLM tool
// schema, which steers behavior independently of the system prompt.
//
// Policy: when the goal is clearly not DB- or sync-shaped, drop the
// DB-discovery and sync tools from the registry for this run. The agent
// keeps the full generic toolset (files, shell, internet, ask_user,
// fetch_url, …) and can never trip into a 50 KB catalog dump for a
// greeting. If the user pivots mid-conversation to a DB question, that
// is a new run (or a resume after explicit re-classification) — the
// per-run gate is the right granularity.
//
// Conservative: gate fires only when `decideSections` says no DB content
// at all (dbScore < 2 AND no sync). Borderline goals keep all tools.

const DB_DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_catalog",
  "explore_mssql_schema",
  "discover_relationships",
  "profile_data",
  "inspect_definition",
  "query_mssql",
  "export_query_to_file",
])

const SYNC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_environments",
  "sync_preview",
  "sync_execute",
  "compare_catalogs",
])

export interface ToolFilterResult<T extends { name: string }> {
  /** Final tool list to advertise to the LLM. */
  tools:   T[]
  /** Names dropped for this run. Used for the observability log line. */
  dropped: string[]
  /** True when no filtering occurred (borderline / DB-shaped / sync goals). */
  passThrough: boolean
}

/**
 * Filter a tool list based on the same goal classification used for
 * section gating. See the block comment above for policy.
 *
 * Generic over the Tool shape so server-side governed/wrapped tools
 * (which add fields beyond {name, description}) can be filtered without
 * losing their identity.
 */
export function filterToolsByGoal<T extends { name: string }>(
  tools: T[],
  decision: SectionDecision,
): ToolFilterResult<T> {
  const score = decision.dbScore ?? 0
  const isDbLike = score >= 2
  const isSync   = !!decision.triggers?.sync
  if (isDbLike || isSync) {
    return { tools, dropped: [], passThrough: true }
  }
  const dropped: string[] = []
  const kept = tools.filter((t) => {
    if (DB_DISCOVERY_TOOL_NAMES.has(t.name) || SYNC_TOOL_NAMES.has(t.name)) {
      dropped.push(t.name)
      return false
    }
    return true
  })
  return { tools: kept, dropped, passThrough: false }
}

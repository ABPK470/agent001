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
 *
 * Customer-specific schema and domain tokens come from the live
 * catalog (`listSchemas()`) and the tenant config
 * (`routingKeywords.domain`, `routingKeywords.sync`). The code here
 * contains zero deployment-specific identifiers.
 */
import { defaultCatalogAccessor, getTenantConfig, listSchemas } from "@mia/agent"

export interface SectionDecision {
  /** Inject the ABI-sync SME block. */
  includeAbiSync: boolean
  /** Include the MSSQL "DATA TOOLS / RULES / EFFICIENCY" guidance prose. */
  includeMssqlGuidance: boolean
  /**
   * Include the big-table / micro-ETL discipline section (canonical
   * #temp staging pattern + anti-patterns). Same trigger as
   * `includeMssqlGuidance` — fires whenever the goal looks DB-shaped.
   */
  includeBigTableEtl: boolean
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
  mssqlKnowledgeMode: "full" | "header"
  /** Include the live schema-catalog summary. */
  includeMssqlCatalog: boolean
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
  includeDataPersona: boolean
  /**
   * Optional debug payload. Additive — kept here so tests and the run
   * trace can assert on / log *why* a gate fired. Not consumed by the
   * prompt assembler.
   */
  dbScore?: number
  triggers?: {
    operational: boolean
    domain: boolean
    tableHint: boolean
    nonDb: boolean
    sync: boolean
    bi: boolean
  }
}

const SYNC_SHAPE_RE =
  /\b(?:sync|synchroni[sz]e)\b.*\b(?:from|to)\b|\b(?:sync|synchroni[sz]e)\b.*\benviron|\benviron.*\b(?:sync|synchroni[sz]e)\b|\babi.sync\b|\bsync.preview\b|\bsync.execute\b|\blist.environments\b|\bcompare.catalog|\bsync.contract\b|\bcontract.sync\b|\bsync.recipe\b|\bsync.entity\b|\benv.sync\b|\bsearch[\s._-]?sync[\s._-]?entit/i

// ── DB gate — two-signal scorer ────────────────────────────────────
//
// Replaces the previous flat `DB_RE` OR-list. Three orthogonal signals:
//
//   DB_OPERATIONAL_RE — strong SQL / platform / tool tokens. If this
//     fires, we are very confident this is a DB task regardless of any
//     other cue (it cancels the NON_DB down-score).
//
//   DB_DOMAIN_RE — domain vocabulary supplied by the tenant config
//     (`routingKeywords.domain`). Empty by default; populating it
//     lets a deployment fire the gate on its own business terms
//     (e.g. "revenue" for a finance tenant, "stock" for retail).
//     Domain alone is sufficient to fire the gate.
//
//   NON_DB_RE — narrowly scoped to "this is not a data-warehouse task at
//     all" cues (Monte Carlo, mockup, Sharpe ratio, etc.). DESIGN RULE:
//     rendering verbs (chart / plot / visualize / render / dashboard /
//     animated) MUST NEVER appear here — they're orthogonal to data
//     source and would false-negative legitimate DWH-viz questions.
//
// Scoring:
//   +2  DB_OPERATIONAL_RE
//   +2  DB_DOMAIN_RE (per-tenant)
//   +2  BI_DOMAIN_RE  (universal business-vocabulary anchor)
//   +1  TABLE_DB_HINT_RE | DB_TABLE_HINT_RE
//   +3  SYNC_RE
//   −3  NON_DB_RE matches AND DB_OPERATIONAL_RE does NOT match
//        (BI vocab does NOT cancel non-DB — `Monte Carlo portfolio
//        simulation` matches `portfolio` but is still non-DB.)
// isDbLike = score >= 2.

// Universal SQL / discovery-tool tokens. NO customer-specific schema
// or table names — those flow in via `DB_OPERATIONAL_SCHEMA_RE`,
// rebuilt per-call from the live catalog.
const DB_OPERATIONAL_CORE_RE =
  /\b(sql|t-sql|tsql|mssql|sqlserver|select|from\s+\w|where\s+\w|group\s+by|order\s+by|join(s|ed|ing)?|query|queries|schema|columns?|rows?|view(s)?|stored?\s+proc|catalog|lineage|search_catalog|explore_mssql|inspect_definition|discover_relationships|query_mssql|profile_data|export_query|dwh|warehouse|etl|dataset(s)?|pipeline\s+(run|status)|recipe|database)\b/i

// ── Universal BI / business-question vocabulary ─────────────────────
//
// Captures the way users actually ASK warehouse questions — without any
// SQL keyword. These are the archetypal BI patterns we should always
// recognize as DB-shaped, regardless of tenant config:
//
//   - Metric nouns: revenue, sales, profit, margin, balance, exposure,
//     volume, count, amount, transaction, order, invoice, payment
//   - Entity nouns: product(s), customer(s), client(s), account(s),
//     merchant(s), supplier(s), order(s), branch(es), region(s),
//     segment(s), portfolio(s), book(s)
//   - Aggregation phrasing: top N, bottom N, ranked, leaderboard,
//     biggest, largest, smallest, highest, lowest, most/least <noun>,
//     by month/quarter/year/region/product/customer
//   - Time framing: YTD, MTD, QTD, fiscal, quarterly, monthly,
//     year-over-year, YoY, MoM, QoQ, last (N) (days|weeks|months|years),
//     since YYYY, in (Jan|Feb|...|January|...|Q1|Q2) (YYYY)?
//
// Anchors a goal as DB-shaped with +2 — same weight as the explicit
// SQL/operational signal. Crucially, this fires even when neither the
// hardcoded SQL vocab nor the per-tenant `domainRe` would catch the
// question (production gap: "list top 3 products based on revenue for
// April 2025" — 0 SQL keywords, untrained domain, but textbook BI).
const BI_DOMAIN_RE = new RegExp(
  [
    // Metric nouns
    "\\b(?:revenue|revenues|sales|profit|profits|margin|margins|gross|net",
    "|balance|balances|exposure|exposures|volume|volumes|amount|amounts",
    "|transaction|transactions|order|orders|invoice|invoices|payment|payments",
    "|fees?|charges?|commission|commissions|deposit|deposits|loan|loans",
    "|inventory|stock|holdings?|positions?|trades?|pnl|p&l)\\b",
    // Entity nouns (singular and plural)
    "|\\b(?:product|products|customer|customers|client|clients|account|accounts",
    "|merchant|merchants|supplier|suppliers|vendor|vendors|branch|branches",
    "|region|regions|country|countries|segment|segments|portfolio|portfolios",
    "|banker|bankers|advisor|advisors|broker|brokers|book|books|desk|desks)\\b",
    // Aggregation / ranking phrasing
    "|\\btop\\s+\\d+\\b|\\bbottom\\s+\\d+\\b|\\branked?\\b|\\branking\\b|\\bleaderboard\\b",
    "|\\b(?:biggest|largest|smallest|highest|lowest)\\b",
    "|\\bby\\s+(?:month|quarter|year|region|country|product|customer|client|account|segment|branch|portfolio|banker)\\b",
    // Time framing
    "|\\b(?:ytd|mtd|qtd|yoy|mom|qoq|y\\/y|m\\/m|q\\/q)\\b",
    "|\\b(?:fiscal|quarterly|monthly|annually|year[- ]over[- ]year|month[- ]over[- ]month)\\b",
    "|\\blast\\s+\\d+\\s+(?:days?|weeks?|months?|quarters?|years?)\\b",
    "|\\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+(?:19|20)\\d{2}\\b",
    "|\\bQ[1-4]\\s+(?:19|20)\\d{2}\\b"
  ].join(""),
  "i"
)

// "Non-DB task type" cues only. NEVER add rendering verbs here.
const NON_DB_RE =
  /\b(monte\s*carlo|simulation|mockup|mock-up|wireframe|prototype|sharpe\s+ratio|black.scholes|brownian|stochastic\s+process|geometric\s+brownian)\b/i

// "Visual" intent — any of these usually benefits from the chart catalogue.
const CHART_RE =
  /\b(chart|charts|graph|graphs|graphed|plot|plots|plotted|visuali[sz]e|visuali[sz]ation|dashboard|kpi|kpis|trend(s)?|distribution|breakdown|histogram|heatmap|relationship\s+map|diagram|figure|render)\b/i

/** Regex word-escape; keeps alphanumeric tokens safe to splice into a regex. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Build (and memoise) the four catalog/tenant-driven regexes that
 * power the DB gate. Recomputed only when the underlying inputs
 * (schemas, mirrorSchema, domain & sync keyword lists) change.
 */
interface DynamicGateRegexes {
  operationalSchemaRe: RegExp | null
  domainRe: RegExp | null
  tableSchemaRe: RegExp | null
  schemaTableRe: RegExp | null
  syncExtraRe: RegExp | null
}
let _gateCache: { key: string; re: DynamicGateRegexes } | null = null
function buildGateRegexes(): DynamicGateRegexes {
  const tenant = getTenantConfig()
  const catalog = defaultCatalogAccessor()
  const schemas = catalog ? listSchemas({ accessor: () => catalog }) : []
  const schemaTokens: string[] = []
  for (const s of schemas) schemaTokens.push(s)
  if (tenant.mirrorSchema) schemaTokens.push(tenant.mirrorSchema.toLowerCase())
  const domain = (tenant.routingKeywords?.domain ?? []).map((s) => s.toLowerCase())
  const sync = (tenant.routingKeywords?.sync ?? []).map((s) => s.toLowerCase())

  const key = JSON.stringify([schemaTokens, domain, sync])
  if (_gateCache && _gateCache.key === key) return _gateCache.re

  const schemaAlt = schemaTokens.length > 0 ? schemaTokens.map(escapeRe).join("|") : null
  const operationalSchemaRe = schemaAlt ? new RegExp(`\\b(?:${schemaAlt})\\.`, "i") : null
  const tableSchemaRe = schemaAlt
    ? new RegExp(
        `\\b(?:table(?:s)?)\\b[^.\\n]{0,80}\\b(?:in\\s+(?:the\\s+)?(?:database|schema|db)|schema|sql|database|db|join|column|row|query|${schemaAlt})\\b`,
        "i"
      )
    : /\b(?:table(?:s)?)\b[^.\n]{0,80}\b(?:in\s+(?:the\s+)?(?:database|schema|db)|schema|sql|database|db|join|column|row|query)\b/i
  const schemaTableRe = schemaAlt
    ? new RegExp(
        `\\b(?:database|schema|sql|join|column|row|query|${schemaAlt})\\b[^.\\n]{0,80}\\b(?:table(?:s)?)\\b`,
        "i"
      )
    : /\b(?:database|schema|sql|join|column|row|query)\b[^.\n]{0,80}\b(?:table(?:s)?)\b/i
  const domainRe = domain.length > 0 ? new RegExp(`\\b(?:${domain.map(escapeRe).join("|")})\\b`, "i") : null
  const syncExtraRe = sync.length > 0 ? new RegExp(`\\b(?:${sync.map(escapeRe).join("|")})\\b`, "i") : null

  const re: DynamicGateRegexes = {
    operationalSchemaRe,
    domainRe,
    tableSchemaRe,
    schemaTableRe,
    syncExtraRe
  }
  _gateCache = { key, re }
  return re
}
/** Test-only reset hook so regex memoisation cannot leak across tests. */
export function _resetDecideSectionsCache(): void {
  _gateCache = null
}

export interface DbScoreResult {
  score: number
  operational: boolean
  domain: boolean
  tableHint: boolean
  nonDb: boolean
  sync: boolean
  /** True when the goal matches the universal BI/business vocabulary. */
  bi: boolean
}

/**
 * Names of DB / sync tools whose presence in working memory (i.e. tool
 * calls the agent already made in this session) is direct evidence the
 * conversation is data-shaped. Used by `scoreDbLikelihood` to give
 * follow-up turns a strong DB signal even when the latest user message
 * is a short pronoun-only follow-up like "run it" or "show me the
 * results". Without this, a single non-DB-keyword reply would cause
 * `filterToolsByGoal` to drop the very tools the conversation has been
 * relying on — the user reports this as a "huge gap".
 *
 * Kept in sync with `DB_DISCOVERY_TOOL_NAMES` + `SYNC_TOOL_NAMES`
 * below; centralised here so the scorer never has to import them.
 */
const DB_TOOL_TRACE_RE =
  /\b(?:query_mssql|explore_mssql_schema|search_catalog|inspect_definition|discover_relationships|profile_data|export_query_to_file|compare_catalogs|search_sync_entities|sync_preview|sync_execute|list_environments)\b/i

/** Cap on how much context text the scorer scans — keeps regex cost bounded. */
const CONTEXT_SCAN_CAP = 8000

/**
 * Compute the DB-likelihood score for a goal.
 *
 * `context` (optional) lets callers feed in additional, conversation-
 * level evidence: recent user/assistant messages, working memory, and
 * episodic memory. When present, the classifier scans both `goal` and
 * `context` for DB tokens so that:
 *
 *   - A follow-up turn whose user message has no DB keywords still
 *     scores DB-like when the session is clearly mid-data-task.
 *   - The presence of prior DB tool calls in working memory (matched by
 *     `DB_TOOL_TRACE_RE`) is treated as a strong DB signal (+2).
 *
 * The current user `goal` always dominates: if the goal alone scores
 * strongly DB-like, context can only add to that. If the goal scores
 * non-DB (e.g. matches `NON_DB_RE`), the goal still down-scores even
 * when context is DB-shaped — explicit user intent wins.
 *
 * Exported for telemetry / tests.
 */
export function scoreDbLikelihood(goal: string, context?: string): DbScoreResult {
  const dyn = buildGateRegexes()
  const ctx = (context ?? "").slice(0, CONTEXT_SCAN_CAP)
  // Scan goal + context for positive DB signals.
  const probe = ctx ? `${goal}\n${ctx}` : goal

  const operational = DB_OPERATIONAL_CORE_RE.test(probe) || (dyn.operationalSchemaRe?.test(probe) ?? false)
  const domain = dyn.domainRe?.test(probe) ?? false
  const tableHint = (dyn.tableSchemaRe?.test(probe) ?? false) || (dyn.schemaTableRe?.test(probe) ?? false)
  // Universal BI / business-vocabulary signal — catches archetypal
  // warehouse questions phrased in business language ("top 3 products
  // by revenue for April 2025") that contain ZERO SQL keywords. Goal-
  // only, never context: a prior turn discussing "products" doesn't
  // make THIS turn's "hi" a DB question.
  const bi = BI_DOMAIN_RE.test(goal)
  // Non-DB intent must come from the GOAL only — context might legitimately
  // mention a Monte-Carlo discussion from earlier without the current turn
  // being non-DB. Honouring explicit current intent here.
  const nonDb = NON_DB_RE.test(goal)
  const sync = SYNC_SHAPE_RE.test(probe) || (dyn.syncExtraRe?.test(probe) ?? false)
  // Strong evidence: the agent already called DB tools in this session.
  // Only counted when found in CONTEXT (not goal) — the goal mentioning
  // a tool name is just a string, but working-memory trace is a fact.
  const priorDbToolCall = ctx ? DB_TOOL_TRACE_RE.test(ctx) : false

  let score = 0
  if (operational) score += 2
  if (domain) score += 2
  if (tableHint) score += 1
  if (bi) score += 2
  if (sync) score += 3
  if (priorDbToolCall) score += 2
  // NB: bi does NOT cancel nonDb — `Monte Carlo portfolio simulation`
  // legitimately matches BI vocab (`portfolio`) but the simulation cue
  // still wins. Operational SQL keywords remain the only nonDb cancel.
  if (nonDb && !operational) score -= 3

  return { score, operational, domain, tableHint, nonDb, sync, bi }
}

export function decideSections(opts: {
  goal: string
  memory?: { working?: string; episodic?: string; semantic?: string }
  /**
   * Conversation-level context (recent messages + memory) used to
   * classify ambiguous follow-up turns. See `scoreDbLikelihood`.
   * When omitted, falls back to scoring on `goal` alone (back-compat).
   */
  context?: string
}): SectionDecision {
  const goal = opts.goal ?? ""
  // Auto-derive context from `memory` when no explicit context is supplied,
  // so existing callers that only pass `memory` still get the benefit.
  const derived = opts.context ?? [opts.memory?.working, opts.memory?.episodic].filter(Boolean).join("\n")
  const db = scoreDbLikelihood(goal, derived || undefined)
  const isDbLike = db.score >= 2
  // Chart catalogue requires EXPLICIT visual intent. DB-shaped goals no
  // longer auto-include it — the model can call `get_chart_specs` if it
  // decides a visualisation is warranted.
  const isVisual = CHART_RE.test(goal)
  const hasMemory = !!(opts.memory && (opts.memory.working || opts.memory.episodic || opts.memory.semantic))

  return {
    includeAbiSync: db.sync,
    includeMssqlGuidance: isDbLike,
    includeMssqlKnowledge: isDbLike,
    // Strong DB intent (score ≥ 4) or any sync goal → full knowledge body;
    // borderline DB intent → header-only. Single-signal hits (score 2-3:
    // e.g. just "join" or just "schema" in the goal) shouldn't ship the
    // full warehouse manual.
    mssqlKnowledgeMode: db.score >= 4 || db.sync ? "full" : "header",
    includeMssqlCatalog: isDbLike,
    includeBigTableEtl: isDbLike,
    includeChartCatalogue: isVisual,
    includeMemoryGuidance: hasMemory,
    includeDataPersona: isDbLike || isVisual || db.sync,
    dbScore: db.score,
    triggers: {
      operational: db.operational,
      domain: db.domain,
      tableHint: db.tableHint,
      nonDb: db.nonDb,
      sync: db.sync,
      bi: db.bi
    }
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
  "export_query_to_file"
])

const SYNC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_environments",
  "search_sync_entities",
  "sync_preview",
  "sync_execute",
  "compare_catalogs"
])

export interface ToolFilterResult<T extends { name: string }> {
  /** Final tool list to advertise to the LLM. */
  tools: T[]
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
  decision: SectionDecision
): ToolFilterResult<T> {
  const score = decision.dbScore ?? 0
  const isDbLike = score >= 2
  const isSync = !!decision.triggers?.sync
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

/**
 * Goal classification — single source of truth for run **frame** + DB/sync intent.
 *
 * Used by `decide-sections.ts` for prompt gating and tool filtering.
 * Regex-based by design: a misroute costs one extra discovery call;
 * always shipping MSSQL + sync tools costs tens of thousands of tokens.
 *
 * ## Frames (closed set)
 *
 *   - `sync`         — cross-environment ABI metadata reconciliation
 *   - `data_query`   — warehouse / MSSQL work on this turn
 *   - `ops_config`   — DevOps / config / secrets / ADO (not catalog)
 *   - `general`      — everything else
 *
 * Capabilities (persona, catalog, MSSQL tools, catalog clarifiers) follow the
 * frame. History must not retarget: prior DB tools only reinforce when the
 * **current goal** still asks for data work or continues anaphorically.
 *
 * ## Sync intent (task model)
 *
 *   1. **explicit** — sync tool names, `sync from X to Y`, …
 *   2. **syncEntity** — published bundle entity id in goal
 *   3. **drift + crossEnv** — "out of sync between uat and dev"
 *   4. **crossEnv + metadata** — "compare pipelines uat vs dev"
 *
 * ## Data intent (score ≥ 2 → data_query when not ops_config/sync)
 *
 *   +2 strong SQL / platform / catalog-tool tokens (goal text)
 *   +2 compound weak lexicon (schema/table/… only with DB companions)
 *   +2 tenant domainKeywords
 *   +2 goal-class data-query shape
 *   +2 BI / ranking vocabulary (goal)
 *   +1 table-in-database phrasing
 *   +3 syncIntent
 *   +2 prior DB continuity **only** if goal is anaphoric or still data-compound
 *   −3 non-DB simulation/mockup cues
 *   ops_config cancel: forces general/ops_config unless strong SQL / sync / schema-aggregate
 */

import { defaultCatalogAccessor, getPublishedSyncEntityIds, getTenantConfig, listSchemas } from "@mia/agent"
import {
  DB_INTENT_GOAL_CLASSES,
  extractGoalClasses
} from "../../infra/persistence/adapters/sqlite/memory/goal-class.js"

// ── Tool sets (must match prompt + registry) ───────────────────────

/** MSSQL discovery tools dropped when the goal is clearly non-data. */
export const DB_DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_catalog",
  "explore_mssql_schema",
  "discover_relationships",
  "profile_data",
  "inspect_definition",
  "query_mssql",
  "export_query_to_file"
])

/** Sync capability tools — kept iff `syncIntent` or data frame. */
export const SYNC_CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_environments",
  "list_sync_definitions",
  "resolve_sync_scope",
  "search_sync_entities",
  "sync_preview",
  "sync_execute",
  "compare_catalogs",
  "sync_diff_scan"
])

export const DATA_CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DB_DISCOVERY_TOOL_NAMES,
  ...SYNC_CAPABILITY_TOOL_NAMES
])

const DB_TOOL_TRACE_RE = new RegExp(
  `\\b(?:${[...DATA_CAPABILITY_TOOL_NAMES].join("|")})\\b`,
  "i"
)

// ── Signal patterns ────────────────────────────────────────────────

/**
 * Strong operational tokens — alone enough for +2 on the **goal**.
 * Deliberately excludes bare schema/table/catalog/pipeline/database.
 */
const DB_OPERATIONAL_STRONG_RE =
  /\b(sql|t-sql|tsql|mssql|sqlserver|select\b|from\s+\w|where\s+\w|group\s+by|order\s+by|join(s|ed|ing)?|stored?\s+proc|lineage|search_catalog|explore_mssql|inspect_definition|discover_relationships|query_mssql|profile_data|export_query|dwh|warehouse|etl)\b/i

/** Weak lexicon — needs a compound companion before counting as operational. */
const DB_WEAK_LEXICON_RE =
  /\b(schema|columns?|rows?|views?|catalog|datasets?|recipe|database|pipelines?|quer(?:y|ies))\b/i

/**
 * Schema-aggregate asks ("biggest core schema tables", "tables in core").
 * These are data_query but must NOT trigger object-level schema-match clarify.
 */
export const SCHEMA_AGGREGATE_RE =
  /\b(?:tables?|views?)\s+in\s+(?:the\s+)?(?:\w+\s+)?(?:schema|database|db)\b|\b(?:tables?|views?)\s+in\s+\w+\b|\bin\s+(?:the\s+)?\w+\s+schema\b|\b\w+\s+schema\s+tables?\b|\bschema\s+\w+\s+tables?\b|\b(?:list|show|what\s+are|biggest|largest|smallest|top\s+\d+)\b[^\n.]{0,40}\b(?:schema\s+)?tables?\b|\b(?:biggest|largest|all)\s+\w+\s+tables?\b/i

/**
 * Config / DevOps / secrets discussion — cancels weak DB scores.
 * Does not cancel strong SQL, sync, or schema-aggregate warehouse asks.
 * Keep this tight: bare "defaults" / "configuration" alone must NOT cancel BI.
 */
const OPS_CONFIG_RE =
  /\b(?:azure\s*devops|\bado\b|appsettings|app\.config|web\.config|pipeline\s+ya?ml|github\s+actions|terraform|bicep|arm\s+template|key\s*vault|connection\s*strings?|environment\s+variables?|env\s*vars?|ci\/?cd|\bdevops\b|config(?:uration)?\s+file|\.ya?ml\b|secrets?\s+(?:in|as|array|object|from)|defaults?\s+(?:array|object|for\s+secrets?|declares?|declare))\b/i

/** Continuity: current goal refers to prior work rather than naming a new task. */
const DATA_ANAPHORA_RE =
  /\b(?:it|this|that|these|those|same|again|previous|prior|the\s+(?:query|result|results|table|rows|data|report)|run\s+it|do\s+it|for\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)|and\s+the\s+same)\b/i

const BI_DOMAIN_RE = new RegExp(
  [
    "\\b(?:revenue|revenues|sales|profit|profits|margin|margins|gross|net",
    "|balance|balances|exposure|exposures|volume|volumes|amount|amounts",
    "|transaction|transactions|order|orders|invoice|invoices|payment|payments",
    "|fees?|charges?|commission|commissions|deposit|deposits|loan|loans",
    "|inventory|stock|holdings?|positions?|trades?|pnl|p&l)\\b",
    "|\\b(?:product|products|customer|customers|client|clients|account|accounts",
    "|merchant|merchants|supplier|suppliers|vendor|vendors|branch|branches",
    "|region|regions|country|countries|segment|segments|portfolio|portfolios",
    "|banker|bankers|advisor|advisors|broker|brokers|book|books|desk|desks)\\b",
    "|\\btop\\s+\\d+\\b|\\bbottom\\s+\\d+\\b|\\branked?\\b|\\branking\\b|\\bleaderboard\\b",
    "|\\b(?:biggest|largest|smallest|highest|lowest)\\b",
    "|\\bby\\s+(?:month|quarter|year|region|country|product|customer|client|account|segment|branch|portfolio|banker)\\b",
    "|\\b(?:ytd|mtd|qtd|yoy|mom|qoq|y\\/y|m\\/m|q\\/q)\\b",
    "|\\b(?:fiscal|quarterly|monthly|annually|year[- ]over[- ]year|month[- ]over[- ]month)\\b",
    "|\\blast\\s+\\d+\\s+(?:days?|weeks?|months?|quarters?|years?)\\b",
    "|\\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+(?:19|20)\\d{2}\\b",
    "|\\bQ[1-4]\\s+(?:19|20)\\d{2}\\b"
  ].join(""),
  "i"
)

const NON_DB_RE =
  /\b(monte\s*carlo|simulation|mockup|mock-up|wireframe|prototype|sharpe\s+ratio|black.scholes|brownian|stochastic\s+process|geometric\s+brownian)\b/i

/** Explicit sync workflow vocabulary (tools, commands, directed sync). */
const SYNC_EXPLICIT_RE =
  /\b(?:sync|synchroni[sz]e)\b.*\b(?:from|to)\b|\b(?:sync|synchroni[sz]e)\b.*\benviron|\benviron.*\b(?:sync|synchroni[sz]e)\b|\babi[\s._-]?sync\b|\bsync[\s._-]?preview\b|\bsync[\s._-]?execute\b|\bsync[\s._-]?diff[\s._-]?scan\b|\blist[\s._-]?environments\b|\bcompare[\s._-]?catalog|\bsync[\s._-]?contract\b|\bcontract[\s._-]?sync\b|\bsync[\s._-]?recipe\b|\bsync[\s._-]?entit|\benv[\s._-]?sync\b|\bsearch[\s._-]?sync[\s._-]?entit|\blist[\s._-]?sync[\s._-]?definitions\b|\bresolve[\s._-]?sync[\s._-]?scope\b/i

/** Drift / divergence — how users describe metadata mismatch (not SQL drift). */
const DRIFT_INTENT_RE =
  /\bout\s+of\s+sync\b|\bnot\s+in\s+sync\b|\b(?:meta)?data\s+drift\b|\bdrift(?:ed|ing|s)?\b|\bdiverg(?:e|ent|ence|ing)?\b|\bmismatch(?:ed|es|ing)?\b|\bdesync(?:ed|hronized)?\b/i

/** Environment names and direction labels in cross-env questions. */
const ENV_LABEL_RE = /\b(?:uat|dev|prod|production|staging|source|target)\b/i

const CROSS_ENV_PHRASING_RE =
  /\b(?:between|from|to|vs\.?|versus)\b|\(\s*source\s*\)|\(\s*target\s*\)/i

function hasCrossEnvPhrasing(probe: string): boolean {
  if (ENV_LABEL_RE.test(probe) && CROSS_ENV_PHRASING_RE.test(probe)) return true
  if (/\bsource\b/i.test(probe) && /\btarget\b/i.test(probe) && ENV_LABEL_RE.test(probe)) return true
  return false
}

/** ABI metadata entities covered by published sync definitions. */
const ABI_METADATA_ENTITY_RE =
  /\b(?:pipeline(?:s)?|activit(?:y|ies)|contract(?:s)?|dataset(?:s)?|rule(?:s)?|gate\s*metadata|content)\b/i

const CONTEXT_SCAN_CAP = 8000

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface DynamicGateRegexes {
  operationalSchemaRe: RegExp | null
  domainRe: RegExp | null
  tableSchemaRe: RegExp | null
  schemaTableRe: RegExp | null
  syncEntityRe: RegExp | null
  knownSchemaRe: RegExp | null
}

let _gateCache: { key: string; re: DynamicGateRegexes } | null = null

function buildGateRegexes(): DynamicGateRegexes {
  const tenant = getTenantConfig()
  const catalog = defaultCatalogAccessor()
  const schemas = catalog ? listSchemas({ accessor: () => catalog }) : []
  const schemaTokens: string[] = []
  for (const s of schemas) schemaTokens.push(s)
  if (tenant.mirrorSchema) schemaTokens.push(tenant.mirrorSchema.toLowerCase())
  const domain = tenant.domainKeywords.map((s) => s.toLowerCase())
  const syncEntities = getPublishedSyncEntityIds().map((s) => s.toLowerCase())

  const key = JSON.stringify([schemaTokens, domain, syncEntities])
  if (_gateCache && _gateCache.key === key) return _gateCache.re

  const schemaAlt = schemaTokens.length > 0 ? schemaTokens.map(escapeRe).join("|") : null
  const operationalSchemaRe = schemaAlt ? new RegExp(`\\b(?:${schemaAlt})\\.`, "i") : null
  const knownSchemaRe = schemaAlt
    ? new RegExp(`\\b(?:${schemaAlt})\\b(?:\\s+schema)?\\b`, "i")
    : null
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
  const syncEntityRe =
    syncEntities.length > 0 ? new RegExp(`\\b(?:${syncEntities.map(escapeRe).join("|")})\\b`, "i") : null

  const re: DynamicGateRegexes = {
    operationalSchemaRe,
    domainRe,
    tableSchemaRe,
    schemaTableRe,
    syncEntityRe,
    knownSchemaRe
  }
  _gateCache = { key, re }
  return re
}

/** Test-only — reset memoised catalog/tenant regex cache. */
export function _resetGoalClassificationCache(): void {
  _gateCache = null
}

/** Closed set of per-run task frames. Capabilities follow the frame. */
export type RunFrame = "general" | "data_query" | "sync" | "ops_config"

export interface SyncIntentSignals {
  explicit: boolean
  drift: boolean
  crossEnv: boolean
  metadata: boolean
  syncEntity: boolean
}

export interface GoalClassification {
  /** Explicit task frame — source of truth for tools / persona / clarifiers. */
  frame: RunFrame
  dbScore: number
  syncIntent: boolean
  /** True when frame is data_query (or sync, which also keeps data tools). */
  isDbLike: boolean
  /** True when DB or sync tools must remain in the tool list. */
  keepDataTools: boolean
  /**
   * Goal asks about tables/views as a schema-level set (not a single object).
   * Catalog object disambiguation must stay off for the schema token.
   */
  schemaAggregate: boolean
  /** Short evidence strings for traces / tests. */
  evidence: string[]
  triggers: {
    operational: boolean
    domain: boolean
    tableHint: boolean
    nonDb: boolean
    sync: boolean
    bi: boolean
    dataQueryShape: boolean
    priorDataToolCall: boolean
    opsConfig: boolean
    schemaAggregate: boolean
    anaphora: boolean
  }
  syncSignals: SyncIntentSignals
}

function detectSyncIntent(probe: string, dyn: DynamicGateRegexes): SyncIntentSignals {
  const explicit = SYNC_EXPLICIT_RE.test(probe)
  const syncEntity = dyn.syncEntityRe?.test(probe) ?? false
  const drift = DRIFT_INTENT_RE.test(probe)
  const crossEnv = hasCrossEnvPhrasing(probe)
  const metadata = ABI_METADATA_ENTITY_RE.test(probe)
  return { explicit, drift, crossEnv, metadata, syncEntity }
}

function syncIntentFromSignals(s: SyncIntentSignals): boolean {
  if (s.explicit || s.syncEntity) return true
  if (s.drift && s.crossEnv) return true
  if (s.crossEnv && s.metadata) return true
  return false
}

function isSchemaAggregateGoal(goal: string, dyn: DynamicGateRegexes): boolean {
  if (SCHEMA_AGGREGATE_RE.test(goal)) return true
  // "core schema tables" / known-schema + tables without needing catalog warm-up
  if (/\b\w+\s+schema\s+tables?\b/i.test(goal)) return true
  if (dyn.knownSchemaRe && dyn.knownSchemaRe.test(goal) && /\btables?\b/i.test(goal)) return true
  return false
}

/**
 * Weak lexicon counts as operational only with a DB companion on the same goal.
 */
function weakLexiconCompound(goal: string): boolean {
  if (!DB_WEAK_LEXICON_RE.test(goal)) return false
  // Companion: SQL-ish verbs, env labels with schema/table ask, "in the database"
  if (/\b(?:sql|mssql|database|db|warehouse|dwh|t-sql)\b/i.test(goal)) return true
  if (/\b(?:list|show|describe|inspect|explore|profile|count|select)\b/i.test(goal) &&
    /\b(?:schema|table|column|view|catalog|row)\b/i.test(goal)) {
    return true
  }
  if (ENV_LABEL_RE.test(goal) && /\b(?:schema|table|column|view)\b/i.test(goal)) return true
  return false
}

function resolveFrame(opts: {
  syncIntent: boolean
  opsConfig: boolean
  isDbLike: boolean
  schemaAggregate: boolean
  strongOperational: boolean
}): RunFrame {
  if (opts.syncIntent) return "sync"
  // Ops/config discussion wins over weak DB scores unless the goal is
  // explicitly warehouse/SQL/schema-aggregate.
  if (
    opts.opsConfig &&
    !opts.strongOperational &&
    !opts.schemaAggregate &&
    !opts.syncIntent
  ) {
    return "ops_config"
  }
  if (opts.isDbLike) return "data_query"
  return "general"
}

/**
 * Classify a user goal (+ optional session context) for prompt and tool gating.
 *
 * `syncIntent` is derived from the **goal text only** so episodic memory or
 * prior-turn reconciliation context cannot arm sync tools on an unrelated ask.
 *
 * Operational / BI / domain scores use the **goal** (not memory). Context is
 * only used for continuity: prior tool traces + anaphora / still-compound goals.
 */
export function classifyGoal(goal: string, context?: string): GoalClassification {
  const dyn = buildGateRegexes()
  const ctx = (context ?? "").slice(0, CONTEXT_SCAN_CAP)
  const evidence: string[] = []

  const strongOperational =
    DB_OPERATIONAL_STRONG_RE.test(goal) || (dyn.operationalSchemaRe?.test(goal) ?? false)
  const weakCompound = weakLexiconCompound(goal)
  const operational = strongOperational || weakCompound
  if (strongOperational) evidence.push("strong-sql")
  if (weakCompound) evidence.push("weak-lexicon-compound")

  const domain = dyn.domainRe?.test(goal) ?? false
  if (domain) evidence.push("domain-keyword")

  const schemaAggregate = isSchemaAggregateGoal(goal, dyn)
  const tableHint =
    schemaAggregate ||
    (dyn.tableSchemaRe?.test(goal) ?? false) ||
    (dyn.schemaTableRe?.test(goal) ?? false)
  if (schemaAggregate) evidence.push("schema-aggregate")
  else if (tableHint) evidence.push("table-hint")

  const bi = BI_DOMAIN_RE.test(goal)
  if (bi) evidence.push("bi-vocab")

  const nonDb = NON_DB_RE.test(goal)
  if (nonDb) evidence.push("non-db-cue")

  const opsConfig = OPS_CONFIG_RE.test(goal)
  if (opsConfig) evidence.push("ops-config")

  const goalClasses = extractGoalClasses(goal)
  const dataQueryShape = goalClasses.some((tag) => DB_INTENT_GOAL_CLASSES.has(tag))
  if (dataQueryShape) evidence.push("goal-class-data")

  const syncSignals = detectSyncIntent(goal, dyn)
  const syncIntent = syncIntentFromSignals(syncSignals)
  if (syncIntent) evidence.push("sync-intent")

  const priorDataToolCall = ctx ? DB_TOOL_TRACE_RE.test(ctx) : false
  const priorSqlInContext = ctx ? DB_OPERATIONAL_STRONG_RE.test(ctx) : false
  const anaphora = DATA_ANAPHORA_RE.test(goal)
  const goalStillDataCompound =
    strongOperational || weakCompound || tableHint || schemaAggregate || dataQueryShape || bi
  const continuityBoost =
    (priorDataToolCall || priorSqlInContext) && (anaphora || goalStillDataCompound)
  if (continuityBoost) {
    evidence.push(anaphora ? "continuity-anaphora" : "continuity-compound")
  }

  let dbScore = 0
  if (operational) dbScore += 2
  if (domain) dbScore += 2
  if (tableHint) dbScore += 1
  if (bi) dbScore += 2
  if (dataQueryShape) dbScore += 2
  if (syncIntent) dbScore += 3
  if (continuityBoost) dbScore += 2
  if (nonDb && !strongOperational) dbScore -= 3

  // Ops/config cancel: strip weak scores so mid-thread ADO/config chat does
  // not inherit warehouse mode. Strong SQL / schema-aggregate / sync still win.
  if (opsConfig && !strongOperational && !schemaAggregate && !syncIntent) {
    dbScore = Math.min(dbScore, 0)
    evidence.push("ops-config-cancel")
  }

  const isDbLikeRaw = dbScore >= 2
  const frame = resolveFrame({
    syncIntent,
    opsConfig,
    isDbLike: isDbLikeRaw,
    schemaAggregate,
    strongOperational
  })
  const isDbLike = frame === "data_query" || frame === "sync"
  const keepDataTools = isDbLike

  return {
    frame,
    dbScore,
    syncIntent,
    isDbLike,
    keepDataTools,
    schemaAggregate: schemaAggregate && (frame === "data_query" || frame === "sync"),
    evidence,
    triggers: {
      operational,
      domain,
      tableHint,
      nonDb,
      sync: syncIntent,
      bi,
      dataQueryShape,
      priorDataToolCall: continuityBoost,
      opsConfig,
      schemaAggregate,
      anaphora
    },
    syncSignals
  }
}

/** @deprecated Use `classifyGoal` — kept for existing tests and telemetry. */
export interface DbScoreResult {
  score: number
  operational: boolean
  domain: boolean
  tableHint: boolean
  nonDb: boolean
  sync: boolean
  bi: boolean
}

export function scoreDbLikelihood(goal: string, context?: string): DbScoreResult {
  const c = classifyGoal(goal, context)
  return {
    score: c.dbScore,
    operational: c.triggers.operational,
    domain: c.triggers.domain,
    tableHint: c.triggers.tableHint,
    nonDb: c.triggers.nonDb,
    sync: c.syncIntent,
    bi: c.triggers.bi
  }
}

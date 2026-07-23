/**
 * Goal classification — single source of truth for DB/sync intent.
 *
 * Used by `decide-sections.ts` for prompt gating and tool filtering.
 * Regex-based by design: a misroute costs one extra discovery call;
 * always shipping MSSQL + sync tools costs tens of thousands of tokens.
 *
 * ## Sync intent (task model)
 *
 * User wants **cross-environment ABI metadata reconciliation** — not ad-hoc SQL
 * on one database. Signals:
 *
 *   1. **explicit** — sync tool names, `sync from X to Y`, universal shape patterns
 *   2. **syncEntity** — published bundle entity id in goal (e.g. pipelineActivity)
 *   3. **drift + crossEnv** — "out of sync between uat and dev"
 *   4. **drift + metadata** — "pipeline activities drifted"
 *   5. **crossEnv + metadata** — "compare pipelines uat vs dev"
 *
 * Any one path sets `syncIntent: true` → inject `abi-sync.md` and keep sync tools.
 *
 * ## DB intent (score ≥ 2)
 *
 *   +2 operational SQL / platform tokens
 *   +2 tenant domainKeywords (warehouse-specific business words)
 *   +2 goal-class data-query shape — see memory/README.md (`DB_INTENT_GOAL_CLASSES`)
 *   +1 table-in-database phrasing
 *   +3 syncIntent
 *   +2 prior DB/sync tool calls in session context
 *   −3 non-DB simulation/mockup cues (goal only, cancelled by operational)
 */

import { defaultCatalogAccessor, getPublishedSyncEntityIds, getTenantConfig, listSchemas } from "@mia/agent"
import {
  DB_INTENT_GOAL_CLASSES,
  extractGoalClasses
} from "../../infra/persistence/memory/goal-class.js"

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

/** Sync capability tools — kept iff `syncIntent` or `isDbLike`. */
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

const DB_OPERATIONAL_CORE_RE =
  /\b(sql|t-sql|tsql|mssql|sqlserver|select|from\s+\w|where\s+\w|group\s+by|order\s+by|join(s|ed|ing)?|query|queries|schema|columns?|rows?|view(s)?|stored?\s+proc|catalog|lineage|search_catalog|explore_mssql|inspect_definition|discover_relationships|query_mssql|profile_data|export_query|dwh|warehouse|etl|dataset(s)?|pipeline\s+(run|status)|recipe|database)\b/i

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
    syncEntityRe
  }
  _gateCache = { key, re }
  return re
}

/** Test-only — reset memoised catalog/tenant regex cache. */
export function _resetGoalClassificationCache(): void {
  _gateCache = null
}

export interface SyncIntentSignals {
  explicit: boolean
  drift: boolean
  crossEnv: boolean
  metadata: boolean
  syncEntity: boolean
}

export interface GoalClassification {
  dbScore: number
  syncIntent: boolean
  isDbLike: boolean
  /** True when DB or sync tools must remain in the tool list. */
  keepDataTools: boolean
  triggers: {
    operational: boolean
    domain: boolean
    tableHint: boolean
    nonDb: boolean
    sync: boolean
    bi: boolean
    dataQueryShape: boolean
    priorDataToolCall: boolean
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

/**
 * Classify a user goal (+ optional session context) for prompt and tool gating.
 *
 * `syncIntent` is derived from the **goal text only** so episodic memory or
 * prior-turn reconciliation context cannot arm sync tools on an unrelated ask
 * (e.g. "how many pipelines in UAT and DEV").
 */
export function classifyGoal(goal: string, context?: string): GoalClassification {
  const dyn = buildGateRegexes()
  const ctx = (context ?? "").slice(0, CONTEXT_SCAN_CAP)
  const probe = ctx ? `${goal}\n${ctx}` : goal

  const operational = DB_OPERATIONAL_CORE_RE.test(probe) || (dyn.operationalSchemaRe?.test(probe) ?? false)
  const domain = dyn.domainRe?.test(probe) ?? false
  const tableHint = (dyn.tableSchemaRe?.test(probe) ?? false) || (dyn.schemaTableRe?.test(probe) ?? false)
  const bi = BI_DOMAIN_RE.test(goal)
  const nonDb = NON_DB_RE.test(goal)
  const goalClasses = extractGoalClasses(goal)
  const dataQueryShape = goalClasses.some((tag) => DB_INTENT_GOAL_CLASSES.has(tag))
  const syncSignals = detectSyncIntent(goal, dyn)
  const syncIntent = syncIntentFromSignals(syncSignals)
  const priorDataToolCall = ctx ? DB_TOOL_TRACE_RE.test(ctx) : false

  let dbScore = 0
  if (operational) dbScore += 2
  if (domain) dbScore += 2
  if (tableHint) dbScore += 1
  if (bi) dbScore += 2
  if (dataQueryShape) dbScore += 2
  if (syncIntent) dbScore += 3
  if (priorDataToolCall) dbScore += 2
  if (nonDb && !operational) dbScore -= 3

  const isDbLike = dbScore >= 2
  const keepDataTools = isDbLike || syncIntent

  return {
    dbScore,
    syncIntent,
    isDbLike,
    keepDataTools,
    triggers: {
      operational,
      domain,
      tableHint,
      nonDb,
      sync: syncIntent,
      bi,
      dataQueryShape,
      priorDataToolCall
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

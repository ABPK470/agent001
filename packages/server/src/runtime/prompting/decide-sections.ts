/**
 * Goal-aware system-prompt section gating and tool filtering.
 *
 * Classification logic lives in {@link ./goal-classification.ts}.
 * This module maps `GoalClassification` → prompt sections and tool lists.
 */
import {
  classifyGoal,
  DB_DISCOVERY_TOOL_NAMES,
  SYNC_CAPABILITY_TOOL_NAMES,
  _resetGoalClassificationCache
} from "./goal-classification.js"
import type { GoalClassification } from "./goal-classification.js"

export {
  classifyGoal,
  DATA_CAPABILITY_TOOL_NAMES,
  DB_DISCOVERY_TOOL_NAMES,
  scoreDbLikelihood,
  SYNC_CAPABILITY_TOOL_NAMES,
  type DbScoreResult,
  type GoalClassification,
  type SyncIntentSignals
} from "./goal-classification.js"

/** @deprecated Use `_resetGoalClassificationCache`. */
export const _resetDecideSectionsCache = _resetGoalClassificationCache

const CHART_RE =
  /\b(chart|charts|graph|graphs|graphed|plot|plots|plotted|visuali[sz]e|visuali[sz]ation|dashboard|kpi|kpis|trend(s)?|distribution|breakdown|histogram|heatmap|relationship\s+map|diagram|figure|render)\b/i

export interface SectionDecision {
  includeAbiSync: boolean
  includeMssqlGuidance: boolean
  includeBigTableEtl: boolean
  includeMssqlKnowledge: boolean
  mssqlKnowledgeMode: "full" | "header"
  includeMssqlCatalog: boolean
  includeChartCatalogue: boolean
  includeMemoryGuidance: boolean
  includeDataPersona: boolean
  dbScore?: number
  /** Mirrors `classifyGoal().syncIntent` — when true, sync tools must be kept. */
  syncIntent?: boolean
  triggers?: GoalClassification["triggers"]
}

export function decideSections(opts: {
  goal: string
  memory?: { working?: string; episodic?: string; semantic?: string }
  context?: string
}): SectionDecision {
  const goal = opts.goal ?? ""
  const derived = opts.context ?? [opts.memory?.working, opts.memory?.episodic].filter(Boolean).join("\n")
  const c = classifyGoal(goal, derived || undefined)
  const isVisual = CHART_RE.test(goal)
  const hasMemory = !!(opts.memory && (opts.memory.working || opts.memory.episodic || opts.memory.semantic))

  return {
    includeAbiSync: c.syncIntent,
    includeMssqlGuidance: c.isDbLike,
    includeMssqlKnowledge: c.isDbLike,
    mssqlKnowledgeMode: c.dbScore >= 4 || c.syncIntent ? "full" : "header",
    includeMssqlCatalog: c.isDbLike,
    includeBigTableEtl: c.isDbLike,
    includeChartCatalogue: isVisual,
    includeMemoryGuidance: hasMemory,
    includeDataPersona: c.isDbLike || isVisual || c.syncIntent,
    dbScore: c.dbScore,
    syncIntent: c.syncIntent,
    triggers: c.triggers
  }
}

export interface ToolFilterResult<T extends { name: string }> {
  tools: T[]
  dropped: string[]
  passThrough: boolean
}

/**
 * Drop MSSQL + sync tools when the goal is clearly neither data nor sync shaped.
 * Invariant: `decision.includeAbiSync` ⇒ every registered sync tool is kept.
 */
export function filterToolsByGoal<T extends { name: string }>(
  tools: T[],
  decision: SectionDecision
): ToolFilterResult<T> {
  const keepDbTools = decision.syncIntent || (decision.dbScore ?? 0) >= 2
  if (!keepDbTools) {
    const dropped: string[] = []
    const kept = tools.filter((t) => {
      if (DB_DISCOVERY_TOOL_NAMES.has(t.name) || SYNC_CAPABILITY_TOOL_NAMES.has(t.name)) {
        dropped.push(t.name)
        return false
      }
      return true
    })
    return { tools: kept, dropped, passThrough: false }
  }

  if (decision.syncIntent) {
    return { tools, dropped: [], passThrough: true }
  }

  const dropped: string[] = []
  const kept = tools.filter((t) => {
    if (SYNC_CAPABILITY_TOOL_NAMES.has(t.name)) {
      dropped.push(t.name)
      return false
    }
    return true
  })
  return { tools: kept, dropped, passThrough: dropped.length === 0 }
}

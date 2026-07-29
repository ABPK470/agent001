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
import type { GoalClassification, RunFrame } from "./goal-classification.js"
import type { KnowledgePackSelection } from "../../infra/mssql/knowledge-packs.js"

export {
  classifyGoal,
  DATA_CAPABILITY_TOOL_NAMES,
  DB_DISCOVERY_TOOL_NAMES,
  SCHEMA_AGGREGATE_RE,
  scoreDbLikelihood,
  SYNC_CAPABILITY_TOOL_NAMES,
  type DbScoreResult,
  type GoalClassification,
  type RunFrame,
  type SyncIntentSignals
} from "./goal-classification.js"

export type { KnowledgePackSelection }

/** @deprecated Use `_resetGoalClassificationCache`. */
export const _resetDecideSectionsCache = _resetGoalClassificationCache

const CHART_RE =
  /\b(chart|charts|graph|graphs|graphed|plot|plots|plotted|visuali[sz]e|visuali[sz]ation|dashboard|kpi|kpis|trend(s)?|distribution|breakdown|histogram|heatmap|relationship\s+map|diagram|figure|render)\b/i

export interface SectionDecision {
  /** Explicit run frame — clarifiers and tools follow this. */
  frame: RunFrame
  /** Schema-level table/view ask — suppress object schema-match clarify. */
  schemaAggregate: boolean
  /** Which curated knowledge pack(s) to inject. Sole knowledge-selection knob. */
  knowledgePack: KnowledgePackSelection
  includeAbiSync: boolean
  includeMssqlGuidance: boolean
  /**
   * When true with big-table ETL already injected, builder omits the duplicate
   * SCALE CONTEXT bullets (ETL section owns that).
   */
  omitMssqlScaleGuidance: boolean
  includeBigTableEtl: boolean
  includeMssqlKnowledge: boolean
  includeMssqlCatalog: boolean
  includeChartCatalogue: boolean
  includeMemoryGuidance: boolean
  includeDataPersona: boolean
  dbScore?: number
  /** Mirrors `classifyGoal().syncIntent` — when true, sync tools must be kept. */
  syncIntent?: boolean
  triggers?: GoalClassification["triggers"]
  evidence?: string[]
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
  const dataFrame = c.frame === "data_query" || c.frame === "sync"
  const knowledgePack = c.knowledgePack
  const includeKnowledge = knowledgePack !== "none"
  // Micro-ETL playbook is mart/scale work — skip on pure metadata / sync-meta.
  const includeBigTableEtl =
    knowledgePack === "mart" || knowledgePack === "both" || knowledgePack === "header"

  return {
    frame: c.frame,
    schemaAggregate: c.schemaAggregate,
    knowledgePack,
    includeAbiSync: c.syncIntent,
    includeMssqlGuidance: dataFrame,
    omitMssqlScaleGuidance: includeBigTableEtl,
    includeMssqlKnowledge: includeKnowledge,
    includeMssqlCatalog: dataFrame,
    includeBigTableEtl,
    includeChartCatalogue: isVisual,
    includeMemoryGuidance: hasMemory,
    includeDataPersona: dataFrame,
    dbScore: c.dbScore,
    syncIntent: c.syncIntent,
    triggers: c.triggers,
    evidence: c.evidence
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
  // Frame is authoritative: general / ops_config never keep data tools.
  if (decision.frame === "general" || decision.frame === "ops_config") {
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

  if (decision.syncIntent || decision.frame === "sync") {
    return { tools, dropped: [], passThrough: true }
  }

  // data_query: keep MSSQL discovery, drop sync capability tools.
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

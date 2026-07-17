import * as db from "../../../platform/persistence/sqlite.js"

type LooseRecord = Record<string, unknown>

export interface SyncDecisionSummary {
  id: string
  recordedAt: string | null
  stage: string | null
  category: string | null
  severity: string | null
  title: string
  summary: string
  details?: Record<string, unknown>
}

export interface SyncPlanSummary {
  planId: string | null
  entityType: string | null
  entityId: string | number | null
  entityName: string | null
  source: string | null
  target: string | null
  definitionId: string | null
  definitionPublishedVersion: string | null
  governanceDecision: LooseRecord | null
  decisionLog: SyncDecisionSummary[]
  warnings: string[]
}

export function summarizeSyncPlan(plan: unknown): SyncPlanSummary | null {
  const record = asRecord(plan)
  if (!record) return null

  const entity = asRecord(record["entity"])
  const executionContract = asRecord(record["executionContract"])
  const governanceDecision = asRecord(record["governanceDecision"])
  const decisionLog = asDecisionLog(record["decisionLog"])

  return {
    planId: asString(record["planId"]),
    entityType:
      asString(executionContract?.["definitionId"]) ??
      asString(entity?.["type"]),
    entityId: asStringOrNumber(entity?.["id"]),
    entityName: asString(entity?.["displayName"]),
    source: asString(record["source"]),
    target: asString(record["target"]),
    definitionId: asString(executionContract?.["definitionId"]),
    definitionPublishedVersion: asString(executionContract?.["definitionPublishedVersion"]),
    governanceDecision,
    decisionLog,
    warnings: asStringArray(record["warnings"])
  }
}

export function loadPersistedSyncPlanSummary(planId: string): SyncPlanSummary | null {
  const json = db.getSyncRunPlanJson(planId)
  if (!json) return null
  try {
    return summarizeSyncPlan(JSON.parse(json))
  } catch {
    return null
  }
}

export function buildSyncAuditDetail(
  summary: SyncPlanSummary,
  totals: unknown,
  error?: string | null
): Record<string, unknown> {
  return {
    entityType: summary.entityType,
    entityId: summary.entityId,
    entityName: summary.entityName,
    source: summary.source,
    target: summary.target,
    definitionId: summary.definitionId,
    definitionPublishedVersion: summary.definitionPublishedVersion,
    totals,
    governanceDecision: summary.governanceDecision,
    decisionLog: summary.decisionLog,
    warnings: summary.warnings,
    error: error ?? null
  }
}

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asStringOrNumber(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function asDecisionLog(value: unknown): SyncDecisionSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record) return []
    const title = asString(record["title"])
    const summary = asString(record["summary"])
    if (!title || !summary) return []
    const details = asRecord(record["details"])
    return [
      {
        id: asString(record["id"]) ?? title,
        recordedAt: asString(record["recordedAt"]),
        stage: asString(record["stage"]),
        category: asString(record["category"]),
        severity: asString(record["severity"]),
        title,
        summary,
        ...(details ? { details } : {})
      }
    ]
  })
}

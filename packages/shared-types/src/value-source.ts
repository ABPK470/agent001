/**
 * ValueSource — where a handler input value comes from at execute time.
 *
 * Catalog-backed resolvers use `{ type: "catalog", id }` (canonical).
 * Legacy shorthand types (planEntityId, stepField, …) normalize to catalog ids at load/resolve.
 */

import { validateCatalogId } from "./catalog-id.js"
import type { CustomValueSourceCatalog, CustomValueSourceDefinition } from "./custom-value-source.js"
import { formatCustomValueSourcePreview } from "./custom-value-source.js"

/** Step-instance text fields — property name on AuthoredSyncFlowStep. */
export type SyncStepFieldKey = "objectName" | "auditObjectType" | "pipelineName"

export const SYNC_STEP_FIELD_KEYS: readonly SyncStepFieldKey[] = [
  "objectName",
  "auditObjectType",
  "pipelineName",
]

export type BuiltinValueSource =
  | { type: "planEntityId" }
  | { type: "planActor" }
  | { type: "currentStepId" }
  | { type: "contractName" }
  | { type: "ruleInputDatasetId" }
  | { type: "contractPipelineId" }

export type ValueSource =
  | BuiltinValueSource
  | { type: "stepField"; field: SyncStepFieldKey }
  | { type: "priorOutput"; stepId: string; output: string }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "catalog"; id: string }

export const BUILTIN_TARGET_SQL = {
  contractName: {
    query: "SELECT [name] AS name FROM core.Contract WHERE contractId = @entityId",
    resultColumn: "name",
    resultType: "string" as const,
  },
  ruleInputDatasetId: {
    query: "SELECT inputDatasetId FROM core.[Rule] WHERE ruleId = @entityId",
    resultColumn: "inputDatasetId",
    resultType: "number" as const,
  },
  contractPipelineId: {
    query: "SELECT pipelineId FROM core.Pipeline WHERE contractId = @entityId",
    resultColumn: "pipelineId",
    resultType: "number" as const,
  },
} as const

const VALUE_SOURCE_TYPE_SET = new Set<string>([
  "planEntityId",
  "planActor",
  "currentStepId",
  "contractName",
  "ruleInputDatasetId",
  "contractPipelineId",
  "stepField",
  "priorOutput",
  "literal",
  "catalog",
])

export const BUILTIN_VALUE_SOURCE_TYPES: readonly BuiltinValueSource["type"][] = [
  "planEntityId",
  "planActor",
  "currentStepId",
  "contractName",
  "ruleInputDatasetId",
  "contractPipelineId",
]

export function isSyncStepFieldKey(value: string): value is SyncStepFieldKey {
  return (SYNC_STEP_FIELD_KEYS as readonly string[]).includes(value)
}

export function isValueSource(raw: unknown): raw is ValueSource {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return false
  const type = (raw as { type: unknown }).type
  if (typeof type !== "string" || !VALUE_SOURCE_TYPE_SET.has(type)) return false
  switch (type) {
    case "stepField":
      return isSyncStepFieldKey(String((raw as { field?: unknown }).field ?? ""))
    case "priorOutput": {
      const p = raw as { stepId?: unknown; output?: unknown }
      return Boolean(String(p.stepId ?? "").trim() && String(p.output ?? "").trim())
    }
    case "literal":
      return "value" in raw
    case "catalog":
      return Boolean(String((raw as { id?: unknown }).id ?? "").trim())
    default:
      return true
  }
}

export function validateValueSource(source: ValueSource, label = "Value source"): string | null {
  switch (source.type) {
    case "stepField":
      if (!isSyncStepFieldKey(source.field)) {
        return `${label}: unknown step field "${String(source.field)}".`
      }
      return null
    case "priorOutput": {
      if (!source.stepId.trim()) return `${label}: priorOutput requires stepId.`
      if (!source.output.trim()) return `${label}: priorOutput requires output.`
      return null
    }
    case "catalog": {
      const idError = validateCatalogId(source.id, "Custom value source id")
      return idError ? `${label}: ${idError}` : null
    }
    default:
      return null
  }
}

export function isLiteralValueSource(source: ValueSource | undefined): source is Extract<ValueSource, { type: "literal" }> {
  return source?.type === "literal"
}

export function valueSourceCatalogId(source: ValueSource | undefined): string | null {
  if (!source) return null
  if (source.type === "catalog") return source.id.trim() || null
  if (source.type === "stepField") return source.field
  if ((BUILTIN_VALUE_SOURCE_TYPES as readonly string[]).includes(source.type)) return source.type
  return null
}

/** Canonical form for catalog-backed value sources. */
export function normalizeValueSourceToCatalog(source: ValueSource): ValueSource {
  if (source.type === "catalog" || source.type === "literal" || source.type === "priorOutput") {
    return source
  }
  const id = valueSourceCatalogId(source)
  if (!id) return source
  return { type: "catalog", id }
}

export function collectCatalogIdsFromValueSource(source: ValueSource | undefined): string[] {
  const id = valueSourceCatalogId(source)
  return id ? [id] : []
}

export function collectCatalogIdsFromValueSources(sources: Iterable<ValueSource | undefined>): string[] {
  const ids = new Set<string>()
  for (const source of sources) {
    for (const id of collectCatalogIdsFromValueSource(source)) ids.add(id)
  }
  return [...ids].sort()
}

const BUILTIN_PREVIEW: Record<BuiltinValueSource["type"], string> = {
  planEntityId: "Auto: Plan entity id",
  planActor: "Auto: Run user (UPN)",
  currentStepId: "Auto: Current step id",
  contractName: "Query: Contract name",
  ruleInputDatasetId: "Query: Rule input dataset id",
  contractPipelineId: "Query: Contract pipeline id",
}

/** Operator-facing descriptions for built-in value sources (Configuration → Wiring). */
export const BUILTIN_VALUE_SOURCE_DESCRIPTIONS: Record<BuiltinValueSource["type"], string> = {
  planEntityId:
    "Numeric id of the entity being synced (contractId, datasetId, ruleId, …). Same for every step in the run.",
  planActor: "UPN of the user who started the sync run.",
  currentStepId: "Flow step id (step.id) of the step currently executing.",
  contractName:
    "Contract name on target after metadata sync (core.Contract.name for plan entity id).",
  ruleInputDatasetId: "Target SQL: inputDatasetId from core.Rule for the synced rule.",
  contractPipelineId: "Target SQL: pipelineId from core.Pipeline for the synced contract.",
}

const STEP_FIELD_LABELS: Record<SyncStepFieldKey, string> = {
  objectName: "Text: Object name",
  auditObjectType: "Text: Audit object type",
  pipelineName: "Text: Pipeline name",
}

/** Operator-facing descriptions for built-in step text fields (Configuration → Wiring). */
export const STEP_FIELD_DESCRIPTIONS: Record<SyncStepFieldKey, string> = {
  objectName: "Dependency object name string (e.g. content, rule). Typed on each flow step.",
  auditObjectType:
    "Contract / Dataset / Rule label for audit gate procedures (@objType). Typed on each flow step.",
  pipelineName: "Agent pipeline display name (not pipeline id). Typed on each flow step.",
}

export function formatValueSourcePreview(
  source: ValueSource | undefined,
  options?: {
    customCatalog?: CustomValueSourceCatalog
    customLabels?: Record<string, string>
  },
): string {
  if (!source) return ""
  switch (source.type) {
    case "literal":
      return source.value == null ? "" : String(source.value)
    case "stepField":
      return STEP_FIELD_LABELS[source.field] ?? source.field
    case "priorOutput": {
      const step = source.stepId.trim() || "?"
      const key = source.output.trim() || "?"
      return `step “${step}” → ${key}`
    }
    case "catalog": {
      const def = options?.customCatalog?.[source.id]
      if (!def) return source.id
      const label = options?.customLabels?.[source.id]?.trim() || source.id
      return formatCustomValueSourcePreview(def, label, source.id)
    }
    default: {
      const catalogId = valueSourceCatalogId(source)
      const def = catalogId ? options?.customCatalog?.[catalogId] : undefined
      if (def && catalogId) {
        const label = options?.customLabels?.[catalogId]?.trim() || catalogId
        return formatCustomValueSourcePreview(def, label, catalogId)
      }
      return BUILTIN_PREVIEW[source.type]
    }
  }
}

export function readStepFieldValue(
  step: Record<string, unknown>,
  field: SyncStepFieldKey,
): string {
  const raw = step[field]
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  throw new Error(`Flow step is missing required field "${field}".`)
}

export function stepFieldKeysFromValueSource(source: ValueSource | undefined): SyncStepFieldKey[] {
  if (source?.type === "stepField") return [source.field]
  return []
}

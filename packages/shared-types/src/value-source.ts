/**
 * ValueSource — where a handler input value comes from at execute time.
 *
 * One discriminated union replaces legacy prefixed string refs on handler bindings.
 * Builtins are enum variants; only operator-defined target-sql lookups live in the custom catalog.
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

const BUILTIN_VALUE_SOURCE_TYPES = new Set<string>([
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

export function isSyncStepFieldKey(value: string): value is SyncStepFieldKey {
  return (SYNC_STEP_FIELD_KEYS as readonly string[]).includes(value)
}

export function isValueSource(raw: unknown): raw is ValueSource {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return false
  const type = (raw as { type: unknown }).type
  if (typeof type !== "string" || !BUILTIN_VALUE_SOURCE_TYPES.has(type)) return false
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

export function collectCatalogIdsFromValueSource(source: ValueSource | undefined): string[] {
  if (!source) return []
  if (source.type === "catalog") return [source.id.trim()]
  return []
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

const STEP_FIELD_LABELS: Record<SyncStepFieldKey, string> = {
  objectName: "Text: Object name",
  auditObjectType: "Text: Audit object type",
  pipelineName: "Text: Pipeline name",
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
    default:
      return BUILTIN_PREVIEW[source.type]
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

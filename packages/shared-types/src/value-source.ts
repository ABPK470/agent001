/**
 * ValueSource — where a handler input value comes from at execute time.
 *
 * Catalog-backed resolvers use `{ type: "catalog", id }` (canonical).
 * Literals and prior-step outputs stay inline on handler slots.
 */

import { validateCatalogId } from "./catalog-id.js"
import type { CustomValueSourceCatalog } from "./custom-value-source.js"
import { formatCustomValueSourcePreview } from "./custom-value-source.js"

/** Step-instance text fields — property name on AuthoredSyncFlowStep. */
export type SyncStepFieldKey = "objectName" | "auditObjectType" | "pipelineName"

export const SYNC_STEP_FIELD_KEYS: readonly SyncStepFieldKey[] = [
  "objectName",
  "auditObjectType",
  "pipelineName",
]

export type ValueSource =
  | { type: "priorOutput"; stepId: string; output: string }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "catalog"; id: string }

const VALUE_SOURCE_TYPE_SET = new Set<string>(["priorOutput", "literal", "catalog"])

export function isSyncStepFieldKey(value: string): value is SyncStepFieldKey {
  return (SYNC_STEP_FIELD_KEYS as readonly string[]).includes(value)
}

export function isValueSource(raw: unknown): raw is ValueSource {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return false
  const type = (raw as { type: unknown }).type
  if (typeof type !== "string" || !VALUE_SOURCE_TYPE_SET.has(type)) return false
  switch (type) {
    case "priorOutput": {
      const p = raw as { stepId?: unknown; output?: unknown }
      return Boolean(String(p.stepId ?? "").trim() && String(p.output ?? "").trim())
    }
    case "literal":
      return "value" in raw
    case "catalog":
      return Boolean(String((raw as { id?: unknown }).id ?? "").trim())
    default:
      return false
  }
}

export function validateValueSource(source: ValueSource, label = "Value source"): string | null {
  switch (source.type) {
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
  if (!source || source.type !== "catalog") return null
  return source.id.trim() || null
}

/** Canonical form for catalog-backed value sources. */
export function normalizeValueSourceToCatalog(source: ValueSource): ValueSource {
  return source
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
      return ""
  }
}

export function readStepFieldValue(
  step: Partial<Record<SyncStepFieldKey, unknown>>,
  field: SyncStepFieldKey,
): string {
  const raw = step[field]
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  throw new Error(`Flow step is missing required field "${field}".`)
}

/** Step text fields required by a catalog-backed value source on a handler slot. */
export function stepFieldKeysFromValueSource(source: ValueSource | undefined): SyncStepFieldKey[] {
  const catalogId = valueSourceCatalogId(source)
  if (catalogId && isSyncStepFieldKey(catalogId)) return [catalogId]
  return []
}

/**
 * Value source catalog — every resolver (built-in and operator-defined) lives in sync metadata.
 *
 * Authority: deploy/sync/artifacts/sync-metadata.json → SQLite → published bundle snapshot.
 * Handler slots reference catalog ids via `{ type: "catalog", id }`.
 */

import { validateCatalogId } from "./catalog-id.js"
import type { SyncStepFieldKey } from "./value-source.js"
import { isSyncStepFieldKey, SYNC_STEP_FIELD_KEYS } from "./value-source.js"

export type CatalogResolver =
  | { kind: "planEntityId" }
  | { kind: "planActor" }
  | { kind: "currentStepId" }
  | { kind: "targetSql"; query: string; resultColumn: string; resultType?: "string" | "number" }
  | { kind: "stepField"; field: SyncStepFieldKey }

export interface CustomValueSourceDefinition {
  description: string
  resolver: CatalogResolver
}

/** @deprecated Legacy SQL-only shape — parsed into resolver.targetSql */
export interface LegacySqlCustomValueSourceDefinition {
  description: string
  query: string
  resultColumn: string
  resultType?: "string" | "number"
}

export type CustomValueSourceCatalog = Record<string, CustomValueSourceDefinition>

export const CATALOG_RESOLVER_KIND_OPTIONS: ReadonlyArray<{
  kind: CatalogResolver["kind"]
  label: string
  description: string
}> = [
  {
    kind: "planEntityId",
    label: "Plan entity id",
    description: "Numeric id of the entity being synced (contractId, datasetId, ruleId, …).",
  },
  {
    kind: "planActor",
    label: "Plan actor (UPN)",
    description: "UPN of the user who started the sync run.",
  },
  {
    kind: "currentStepId",
    label: "Current step id",
    description: "Flow step id (step.id) of the step currently executing.",
  },
  {
    kind: "targetSql",
    label: "Target SQL lookup",
    description: "SELECT on target using @entityId; reads one scalar from the first row.",
  },
  {
    kind: "stepField",
    label: "Step text field",
    description: "Operator-typed text on each flow step instance (objectName, auditObjectType, …).",
  },
]

export function validateTargetSqlQuery(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return "SQL query is required."
  if (!/^\s*SELECT\b/i.test(trimmed)) return "Query must be a SELECT statement."
  if (!/@entityId\b/.test(trimmed)) return "Query must reference @entityId (sync plan entity id)."
  if (/;/.test(trimmed.replace(/'[^']*'/g, ""))) return "Query must not contain statement separators."
  return null
}

export function inferTargetSqlResultType(resultColumn: string): "string" | "number" {
  const column = resultColumn.trim()
  if (!column) return "string"
  if (/Id$/i.test(column)) return "number"
  return "string"
}

export function effectiveTargetSqlResultType(resolver: {
  resultColumn: string
  resultType?: "string" | "number"
}): "string" | "number" {
  void resolver.resultType
  return inferTargetSqlResultType(resolver.resultColumn)
}

export function isCatalogResolver(raw: unknown): raw is CatalogResolver {
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return false
  const kind = (raw as { kind: unknown }).kind
  if (kind === "planEntityId" || kind === "planActor" || kind === "currentStepId") return true
  if (kind === "targetSql") {
    const r = raw as { query?: unknown; resultColumn?: unknown }
    return Boolean(String(r.query ?? "").trim() && String(r.resultColumn ?? "").trim())
  }
  if (kind === "stepField") {
    return isSyncStepFieldKey(String((raw as { field?: unknown }).field ?? ""))
  }
  return false
}

export function normalizeCustomValueSourceDefinition(
  def: CustomValueSourceDefinition,
): CustomValueSourceDefinition {
  if (def.resolver.kind !== "targetSql") return def
  return {
    ...def,
    resolver: {
      ...def.resolver,
      resultType: effectiveTargetSqlResultType(def.resolver),
    },
  }
}

function legacySqlToResolver(
  parsed: Partial<LegacySqlCustomValueSourceDefinition>,
): CatalogResolver {
  const query = String(parsed.query ?? "").trim()
  const resultColumn = String(parsed.resultColumn ?? "").trim()
  return {
    kind: "targetSql",
    query,
    resultColumn,
    resultType: parsed.resultType,
  }
}

export function parseCustomValueSourceDefinition(
  raw: unknown,
  id: string,
): CustomValueSourceDefinition {
  const parsed = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    CustomValueSourceDefinition & LegacySqlCustomValueSourceDefinition & { summary?: string }
  >

  const resolver =
    parsed.resolver && isCatalogResolver(parsed.resolver)
      ? parsed.resolver
      : parsed.query !== undefined || parsed.resultColumn !== undefined
        ? legacySqlToResolver(parsed)
        : null

  if (!resolver) {
    throw new Error(`Value source "${id}" requires a resolver definition.`)
  }

  if (resolver.kind === "targetSql") {
    const queryError = validateTargetSqlQuery(resolver.query)
    if (queryError) throw new Error(`Value source "${id}": ${queryError}`)
    if (!resolver.resultColumn.trim()) {
      throw new Error(`Value source "${id}" requires resultColumn.`)
    }
  }

  if (resolver.kind === "stepField" && !isSyncStepFieldKey(resolver.field)) {
    throw new Error(`Value source "${id}" has invalid step field "${String(resolver.field)}".`)
  }

  return normalizeCustomValueSourceDefinition({
    description: parsed.description?.trim() || "",
    resolver,
  })
}

export function customValueSourceCatalogFromRows(
  rows: ReadonlyArray<{ id: string; definition: CustomValueSourceDefinition }>,
): CustomValueSourceCatalog {
  return Object.fromEntries(rows.map((row) => [row.id, row.definition]))
}

export function lookupCustomValueSource(
  catalog: CustomValueSourceCatalog,
  id: string,
): CustomValueSourceDefinition {
  const def = catalog[id]
  if (!def) {
    throw new Error(
      `Unknown value source "${id}". Configure it under Configuration → Wiring.`,
    )
  }
  return def
}

export function catalogResolverFamilyLabel(resolver: CatalogResolver): string {
  switch (resolver.kind) {
    case "planEntityId":
    case "planActor":
    case "currentStepId":
      return "Auto · plan context"
    case "targetSql":
      return "Query · target SQL"
    case "stepField":
      return `Text · step.${resolver.field}`
  }
}

export function formatCustomValueSourcePreview(
  definition: CustomValueSourceDefinition,
  label: string,
  id: string,
): string {
  const trimmed = label.trim() || id
  switch (definition.resolver.kind) {
    case "planEntityId":
      return "Auto: Plan entity id"
    case "planActor":
      return "Auto: Run user (UPN)"
    case "currentStepId":
      return "Auto: Current step id"
    case "stepField": {
      const fieldLabels: Record<SyncStepFieldKey, string> = {
        objectName: "Text: Object name",
        auditObjectType: "Text: Audit object type",
        pipelineName: "Text: Pipeline name",
      }
      return fieldLabels[definition.resolver.field] ?? definition.resolver.field
    }
    case "targetSql": {
      const tagged = `Query: ${trimmed}`
      return trimmed.startsWith("Query:") ? trimmed : tagged
    }
  }
}

export function formatCatalogResolverRuntimePreview(
  definition: CustomValueSourceDefinition,
  id: string,
): string {
  switch (definition.resolver.kind) {
    case "planEntityId":
      return "Plan entity id from sync run context"
    case "planActor":
      return "UPN of the user who started the run"
    case "currentStepId":
      return "step.id of the executing step"
    case "stepField":
      return `Reads step.${definition.resolver.field} on the flow step instance`
    case "targetSql":
      return `Target SQL → ${definition.resolver.resultColumn.trim() || "?"} (@entityId)`
  }
  void id
}

export function validateCustomValueSourceId(id: string): string | null {
  return validateCatalogId(id, "Value source id")
}

export function defaultCatalogResolver(kind: CatalogResolver["kind"]): CatalogResolver {
  switch (kind) {
    case "planEntityId":
    case "planActor":
    case "currentStepId":
      return { kind }
    case "targetSql":
      return { kind, query: "", resultColumn: "" }
    case "stepField":
      return { kind, field: SYNC_STEP_FIELD_KEYS[0] }
  }
}

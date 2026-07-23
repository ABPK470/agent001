import { parseBoundaryJson } from "../../../internal/parse-json.js"

/**
 * Bidirectional YAML/JSON for Catalog entity documents (`EntityDefinition` + `flowId`).
 *
 * Same document as git seeds (`deploy/sync/artifacts/entities/{id}.json`) and
 * SQLite `entity_versions.body_json`. Export/import use this shape 1:1.
 *
 * Legacy: `run.template` → `flowId`; `__meta` stamps ignored on import.
 * Server stamps (`version`, `createdAt`, …) are emitted for review but
 * overwritten on save.
 */

import { parseAllDocuments, parseDocument, stringify } from "yaml"

import type { EntityDefinition, EntityFkHop, EntityTable, EntityTableScope, Scd2Override } from "@mia/sync"
import { asFlowId, asStrategyId, asTenantId, normalizeEntityDefinition as normalizeEntityScopes } from "@mia/sync"

// ── Export ──────────────────────────────────────────────────────────

export function formatEntityYaml(def: EntityDefinition): string {
  return stringify(orderEntity(def), { lineWidth: 0, sortMapEntries: false })
}

export function formatEntityJson(def: EntityDefinition): string {
  return `${JSON.stringify(orderEntity(def), null, 2)}\n`
}

export function formatEntitiesYaml(defs: EntityDefinition[]): string {
  return defs.map((d) => "---\n" + formatEntityYaml(d)).join("")
}

export interface EntityRegistryExportDocument {
  version: 1
  _comment: string
  entities: Record<string, unknown>[]
}

export function buildEntityRegistryExportDocument(defs: EntityDefinition[]): EntityRegistryExportDocument {
  return {
    version: 1,
    _comment: "SQLite snapshot — Catalog entity documents (EntityDefinition + flowId).",
    entities: defs.map((def) => orderEntity(def)),
  }
}

function orderEntity(def: EntityDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: def.id,
    tenantId: def.tenantId,
    displayName: def.displayName,
    description: def.description ?? "",
    rootTable: def.rootTable,
    idColumn: def.idColumn,
  }
  if (def.labelColumn) out["labelColumn"] = def.labelColumn
  if (def.selfJoinColumn) out["selfJoinColumn"] = def.selfJoinColumn

  out["scd2"] = {
    strategyId: def.scd2.strategyId,
    strategyVersion: def.scd2.strategyVersion,
    ...(def.scd2.entityOverride ? { entityOverride: cleanOverride(def.scd2.entityOverride) } : {}),
  }

  out["tables"] = def.tables.map((t) => orderTable(t))

  out["policies"] = {
    freezeWindowIds: def.policies.freezeWindowIds,
  }

  if (def.lineageRefs.length > 0) out["lineageRefs"] = def.lineageRefs
  out["provenance"] = def.provenance

  if (def.legacyEntrySproc) out["legacyEntrySproc"] = def.legacyEntrySproc
  if (def.reverseOrder.length > 0) out["reverseOrder"] = def.reverseOrder
  if (def.discrepancies.length > 0) out["discrepancies"] = def.discrepancies

  // Same field placement as shipped seeds / SQLite body_json (informational on import).
  out["version"] = def.version
  out["versionLabel"] = def.versionLabel
  out["createdBy"] = def.createdBy
  out["reason"] = def.reason
  out["createdAt"] = def.createdAt
  out["retiredAt"] = def.retiredAt
  out["flowId"] = def.flowId
  return out
}

function orderTable(t: EntityTable): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: t.name,
    scope: orderScope(t.scope),
    executionOrder: t.executionOrder,
    verified: t.verified,
  }
  if (t.scopeColumn) out["scopeColumn"] = t.scopeColumn
  if (t.source) out["source"] = t.source
  if (t.groundedByPipeline !== null) out["groundedByPipeline"] = t.groundedByPipeline
  if (t.enabledByDefault !== null) out["enabledByDefault"] = t.enabledByDefault
  if (t.userControllable !== null) out["userControllable"] = t.userControllable
  if (t.archiveTable) out["archiveTable"] = t.archiveTable
  if (t.note) out["note"] = t.note
  if (t.scd2Override) out["scd2Override"] = cleanOverride(t.scd2Override)
  out["provenance"] = t.provenance
  return out
}

function orderScope(s: EntityTableScope): Record<string, unknown> {
  switch (s.kind) {
    case "rootPk":
      return { kind: "rootPk", column: s.column }
    case "fkPath":
      return {
        kind: "fkPath",
        through: s.through.map((h) => ({
          table: h.table,
          fromColumn: h.fromColumn,
          toColumn: h.toColumn,
        })),
      }
    case "sql":
      return { kind: "sql", predicate: s.predicate }
  }
}

function cleanOverride(o: Scd2Override): Scd2Override {
  const out: Scd2Override = {}
  if (o.excludeFromDiff !== undefined) out.excludeFromDiff = o.excludeFromDiff
  if (o.identityHandling !== undefined) out.identityHandling = o.identityHandling
  if (o.onInsert) out.onInsert = o.onInsert
  if (o.onUpdate) out.onUpdate = o.onUpdate
  return out
}

// ── Import ──────────────────────────────────────────────────────────

export interface ParseEntityResult {
  ok: boolean
  def: EntityDefinition | null
  error: string | null
}

export function parseEntityYaml(text: string): ParseEntityResult {
  let raw: unknown
  try {
    raw = parseDocument(text, { strict: true }).toJSON()
  } catch (e) {
    return { ok: false, def: null, error: `yaml-parse-error: ${(e as Error).message}` }
  }
  return shapeAsEntity(raw)
}

export function parseEntitiesYaml(text: string): ParseEntityResult[] {
  let docs: unknown[]
  try {
    docs = parseAllDocuments(text, { strict: true })
      .filter((d) => d.contents !== null)
      .map((d) => d.toJSON())
  } catch (e) {
    return [{ ok: false, def: null, error: `yaml-parse-error: ${(e as Error).message}` }]
  }
  return docs.map((r) => shapeAsEntity(r))
}

export function parseEntitiesJson(text: string): ParseEntityResult[] {
  let raw: unknown
  try {
    raw = parseBoundaryJson(text)
  } catch (e) {
    return [{ ok: false, def: null, error: `json-parse-error: ${(e as Error).message}` }]
  }

  const docs = Array.isArray(raw) ? raw : [raw]
  if (docs.length === 0) {
    return [{ ok: false, def: null, error: "json document contains no entities" }]
  }
  return docs.map((entry) => shapeAsEntity(entry))
}

function legacyFlowIdFromRun(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (Array.isArray(r["steps"]) && r["steps"].length > 0) return null
  if (typeof r["template"] === "string" && r["template"].trim() !== "") return r["template"]
  return null
}

function shapeAsEntity(raw: unknown): ParseEntityResult {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, def: null, error: "document is not a mapping" }
  }
  const source = raw as Record<string, unknown>
  if (source["run"] != null && typeof source["run"] === "object") {
    const run = source["run"] as Record<string, unknown>
    if (Array.isArray(run["steps"]) && run["steps"].length > 0) {
      return {
        ok: false,
        def: null,
        error:
          "run.steps is not supported — define steps on the flow in Sync metadata → Flows (use flowId)",
      }
    }
  }

  const r = { ...source }
  const legacyFlow = legacyFlowIdFromRun(r["run"])
  delete r["run"]
  delete r["__meta"]

  const required = [
    "id",
    "tenantId",
    "displayName",
    "rootTable",
    "idColumn",
    "scd2",
    "tables",
    "policies",
    "provenance",
  ]
  for (const key of required) {
    if (!(key in r)) return { ok: false, def: null, error: `missing required field "${key}"` }
  }

  const flowIdRaw =
    typeof r["flowId"] === "string" && r["flowId"].trim() !== ""
      ? String(r["flowId"]).trim()
      : legacyFlow
  if (!flowIdRaw) {
    return { ok: false, def: null, error: 'missing required field "flowId"' }
  }

  let tables: EntityTable[]
  try {
    tables = (r["tables"] as unknown[]).map((t, i) => shapeTable(t, i))
  } catch (e) {
    return { ok: false, def: null, error: (e as Error).message }
  }

  const scd2Raw = r["scd2"] as Record<string, unknown>
  const policiesRaw = r["policies"] as Record<string, unknown>

  const def: EntityDefinition = {
    id: String(r["id"]),
    tenantId: asTenantId(String(r["tenantId"])),
    displayName: String(r["displayName"]),
    description: typeof r["description"] === "string" ? r["description"] : "",
    rootTable: String(r["rootTable"]),
    idColumn: String(r["idColumn"]),
    labelColumn: typeof r["labelColumn"] === "string" ? r["labelColumn"] : null,
    selfJoinColumn: typeof r["selfJoinColumn"] === "string" ? r["selfJoinColumn"] : null,
    tables,
    policies: {
      freezeWindowIds: Array.isArray(policiesRaw["freezeWindowIds"])
        ? (policiesRaw["freezeWindowIds"] as unknown[]).map(String)
        : [],
    },
    scd2: {
      strategyId: asStrategyId(String(scd2Raw["strategyId"])),
      strategyVersion: (scd2Raw["strategyVersion"] === "latest"
        ? "latest"
        : Number(scd2Raw["strategyVersion"])) as number | "latest",
      entityOverride: scd2Raw["entityOverride"]
        ? cleanOverride(scd2Raw["entityOverride"] as Scd2Override)
        : null,
    },
    lineageRefs: Array.isArray(r["lineageRefs"]) ? (r["lineageRefs"] as EntityDefinition["lineageRefs"]) : [],
    provenance: r["provenance"] as EntityDefinition["provenance"],
    flowId: asFlowId(flowIdRaw),
    legacyEntrySproc: typeof r["legacyEntrySproc"] === "string" ? r["legacyEntrySproc"] : null,
    reverseOrder: Array.isArray(r["reverseOrder"]) ? (r["reverseOrder"] as unknown[]).map(String) : [],
    discrepancies: Array.isArray(r["discrepancies"]) ? (r["discrepancies"] as unknown[]).map(String) : [],
    version: 0,
    versionLabel: null,
    createdBy: "",
    reason: "",
    createdAt: "",
    retiredAt: null,
  }
  return { ok: true, def: normalizeEntityScopes(def), error: null }
}

function shapeTable(raw: unknown, idx: number): EntityTable {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`tables[${idx}] is not a mapping`)
  }
  const t = raw as Record<string, unknown>
  if (typeof t["name"] !== "string") throw new Error(`tables[${idx}].name is required`)
  if (!t["scope"]) throw new Error(`tables[${idx}].scope is required`)
  return {
    name: t["name"] as string,
    scope: shapeScope(t["scope"], idx),
    executionOrder: typeof t["executionOrder"] === "number" ? (t["executionOrder"] as number) : idx,
    scd2Override: t["scd2Override"] ? cleanOverride(t["scd2Override"] as Scd2Override) : null,
    verified: Boolean(t["verified"]),
    archiveTable: typeof t["archiveTable"] === "string" ? t["archiveTable"] : null,
    note: typeof t["note"] === "string" ? t["note"] : null,
    provenance: (t["provenance"] as EntityTable["provenance"]) ?? { kind: "manual" },
    scopeColumn: typeof t["scopeColumn"] === "string" ? t["scopeColumn"] : null,
    source: isTableSource(t["source"]) ? t["source"] : null,
    groundedByPipeline: typeof t["groundedByPipeline"] === "boolean" ? t["groundedByPipeline"] : null,
    enabledByDefault: typeof t["enabledByDefault"] === "boolean" ? t["enabledByDefault"] : null,
    userControllable: typeof t["userControllable"] === "boolean" ? t["userControllable"] : null,
  }
}

function isTableSource(v: unknown): v is EntityTable["source"] & string {
  return v === "fk+pipeline" || v === "fk-only" || v === "pipeline-only" || v === "manual"
}

function shapeScope(raw: unknown, idx: number): EntityTableScope {
  if (raw === null || typeof raw !== "object") throw new Error(`tables[${idx}].scope must be a mapping`)
  const s = raw as Record<string, unknown>
  switch (s["kind"]) {
    case "rootPk":
      if (typeof s["column"] !== "string") throw new Error(`tables[${idx}].scope.column required for rootPk`)
      return { kind: "rootPk", column: s["column"] as string }
    case "fkPath":
      if (!Array.isArray(s["through"])) throw new Error(`tables[${idx}].scope.through required for fkPath`)
      return {
        kind: "fkPath",
        through: (s["through"] as unknown[]).map((h, j) => shapeFkHop(h, idx, j)),
      }
    case "sql":
      if (typeof s["predicate"] !== "string")
        throw new Error(`tables[${idx}].scope.predicate required for sql`)
      return { kind: "sql", predicate: s["predicate"] as string }
    default:
      throw new Error(
        `tables[${idx}].scope.kind must be rootPk|sql (legacy fkPath is accepted on import and normalized)`,
      )
  }
}

function shapeFkHop(raw: unknown, idx: number, hopIdx: number): EntityFkHop {
  if (raw === null || typeof raw !== "object")
    throw new Error(`tables[${idx}].scope.through[${hopIdx}] not a mapping`)
  const h = raw as Record<string, unknown>
  if (
    typeof h["table"] !== "string" ||
    typeof h["fromColumn"] !== "string" ||
    typeof h["toColumn"] !== "string"
  ) {
    throw new Error(`tables[${idx}].scope.through[${hopIdx}] requires table+fromColumn+toColumn`)
  }
  return {
    table: h["table"] as string,
    fromColumn: h["fromColumn"] as string,
    toColumn: h["toColumn"] as string,
  }
}

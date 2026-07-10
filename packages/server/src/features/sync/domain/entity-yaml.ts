/**
 * Bidirectional YAML import/export for `EntityDefinition` records.
 *
 * Design constraints:
 *  - **Round-tripping is faithful** for all structured fields. Comments
 *    and field-ordering preferences in hand-edited files are preserved
 *    where possible by emitting a stable, opinionated ordering.
 *  - The YAML file format intentionally mirrors `EntityDefinition` 1:1
 *    so a human editor only needs to know one shape (no projection /
 *    no aliases). Optional fields are omitted when null/empty.
 *  - A YAML file MAY contain a single `EntityDefinition` document or
 *    a multi-document file (`---` separated) for bulk import. Both
 *    flow through {@link parseEntitiesYaml}.
 *  - Optional `run:` block (template, service, environment) references a flow;
 *    steps are resolved from that flow at save/publish — never inline in YAML.
 *  - `version`, `versionLabel`, `createdAt`, `createdBy`, `retiredAt`
 *    are NEVER read from the YAML — the server stamps those at save
 *    time. They ARE emitted when exporting (informational only).
 */

import { parseAllDocuments, parseDocument, stringify } from "yaml"

import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import type { EntityDefinition, EntityFkHop, EntityTable, EntityTableScope, Scd2Override } from "@mia/sync"
import { normalizeEntityDefinition as normalizeEntityScopes } from "@mia/sync"

/** EnvSync run bindings stored alongside the entity in YAML (`run:` block). */
export interface EntityRunYaml {
  template: string
  service: string
  environment: string
  /** @deprecated Rejected on import — steps belong on the flow definition. */
  steps?: AuthoredSyncFlowStep[]
}

// ── Export ──────────────────────────────────────────────────────────

/**
 * Serialise a single EntityDefinition to YAML. Stable key ordering so
 * `git diff` is meaningful across edits.
 */
export function formatEntityYaml(def: EntityDefinition, run?: EntityRunYaml | null): string {
  return stringify(orderEntity(def, run), { lineWidth: 0, sortMapEntries: false })
}

/**
 * Serialise many EntityDefinitions as a multi-doc YAML stream (one
 * `---` separator per entity). Order is preserved.
 */
export function formatEntitiesYaml(
  defs: EntityDefinition[],
  runs?: ReadonlyMap<string, EntityRunYaml>
): string {
  return defs.map((d) => "---\n" + formatEntityYaml(d, runs?.get(d.id) ?? null)).join("")
}

export function entityRunYamlFromConfig(config: {
  flow_preset: string
  service_profile_ref: string
  environment_policy_ref: string
}): EntityRunYaml {
  return {
    template: config.flow_preset,
    service: config.service_profile_ref,
    environment: config.environment_policy_ref
  }
}

function orderRun(run: EntityRunYaml): Record<string, unknown> {
  return {
    template: run.template,
    service: run.service,
    environment: run.environment,
  }
}

function orderEntity(def: EntityDefinition, run?: EntityRunYaml | null): Record<string, unknown> {
  // Explicit key ordering for stable diffs.
  const out: Record<string, unknown> = {
    id: def.id,
    tenantId: def.tenantId,
    displayName: def.displayName,
    description: def.description ?? "",
    rootTable: def.rootTable,
    idColumn: def.idColumn
  }
  if (def.labelColumn) out["labelColumn"] = def.labelColumn
  if (def.selfJoinColumn) out["selfJoinColumn"] = def.selfJoinColumn

  out["scd2"] = {
    strategyId: def.scd2.strategyId,
    strategyVersion: def.scd2.strategyVersion,
    ...(def.scd2.entityOverride ? { entityOverride: cleanOverride(def.scd2.entityOverride) } : {})
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
  if (run) out["run"] = orderRun(run)

  // Informational (NOT consumed by the importer):
  out["__meta"] = {
    version: def.version,
    versionLabel: def.versionLabel,
    createdBy: def.createdBy,
    createdAt: def.createdAt,
    reason: def.reason,
    retiredAt: def.retiredAt
  }
  return out
}

function orderTable(t: EntityTable): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: t.name,
    scope: orderScope(t.scope),
    executionOrder: t.executionOrder,
    verified: t.verified
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
          toColumn: h.toColumn
        }))
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
  run: EntityRunYaml | null
  error: string | null
}

/**
 * Parse a single YAML document into an `EntityDefinition`. Server-stamped
 * fields (`version`, `createdAt`, `createdBy`, `retiredAt`) are filled
 * with placeholders — the caller is expected to overwrite them via
 * `saveEntityDefinition`'s `actor` + `reason` args.
 */
export function parseEntityYaml(text: string): ParseEntityResult {
  let raw: unknown
  try {
    raw = parseDocument(text, { strict: true }).toJSON()
  } catch (e) {
    return { ok: false, def: null, run: null, error: `yaml-parse-error: ${(e as Error).message}` }
  }
  return shapeAsEntity(raw)
}

/**
 * Parse a multi-doc YAML stream. Each document is converted independently;
 * documents that fail return their error in the result array.
 */
export function parseEntitiesYaml(text: string): ParseEntityResult[] {
  let docs: unknown[]
  try {
    docs = parseAllDocuments(text, { strict: true })
      .filter((d) => d.contents !== null) // skip empty `---\n---` segments
      .map((d) => d.toJSON())
  } catch (e) {
    return [{ ok: false, def: null, run: null, error: `yaml-parse-error: ${(e as Error).message}` }]
  }
  return docs.map((r) => shapeAsEntity(r))
}

export function parseEntitiesJson(text: string): ParseEntityResult[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return [{ ok: false, def: null, run: null, error: `json-parse-error: ${(e as Error).message}` }]
  }

  const docs = Array.isArray(raw) ? raw : [raw]
  if (docs.length === 0) {
    return [{ ok: false, def: null, run: null, error: "json document contains no entities" }]
  }
  return docs.map((entry) => shapeAsEntity(entry))
}

function shapeAsEntity(raw: unknown): ParseEntityResult {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, def: null, run: null, error: "document is not a mapping" }
  }
  const source = raw as Record<string, unknown>
  const run = shapeRun(source["run"])
  if (run && "error" in run) {
    return { ok: false, def: null, run: null, error: run.error }
  }
  const r = { ...source }
  delete r["run"]

  const required = [
    "id",
    "tenantId",
    "displayName",
    "rootTable",
    "idColumn",
    "scd2",
    "tables",
    "policies",
    "provenance"
  ]
  for (const key of required) {
    if (!(key in r)) return { ok: false, def: null, run, error: `missing required field "${key}"` }
  }

  let tables: EntityTable[]
  try {
    tables = (r["tables"] as unknown[]).map((t, i) => shapeTable(t, i))
  } catch (e) {
    return { ok: false, def: null, run, error: (e as Error).message }
  }

  const scd2Raw = r["scd2"] as Record<string, unknown>
  const policiesRaw = r["policies"] as Record<string, unknown>

  const def: EntityDefinition = {
    id: String(r["id"]),
    tenantId: String(r["tenantId"]),
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
      strategyId: String(scd2Raw["strategyId"]),
      strategyVersion: (scd2Raw["strategyVersion"] === "latest"
        ? "latest"
        : Number(scd2Raw["strategyVersion"])) as number | "latest",
      entityOverride: scd2Raw["entityOverride"]
        ? cleanOverride(scd2Raw["entityOverride"] as Scd2Override)
        : null
    },
    lineageRefs: Array.isArray(r["lineageRefs"]) ? (r["lineageRefs"] as EntityDefinition["lineageRefs"]) : [],
    provenance: r["provenance"] as EntityDefinition["provenance"],
    legacyEntrySproc: typeof r["legacyEntrySproc"] === "string" ? r["legacyEntrySproc"] : null,
    reverseOrder: Array.isArray(r["reverseOrder"]) ? (r["reverseOrder"] as unknown[]).map(String) : [],
    discrepancies: Array.isArray(r["discrepancies"]) ? (r["discrepancies"] as unknown[]).map(String) : [],
    // Server-stamped (placeholders — overwritten on save):
    version: 0,
    versionLabel: null,
    createdBy: "",
    reason: "",
    createdAt: "",
    retiredAt: null
  }
  return { ok: true, def: normalizeEntityScopes(def), run, error: null }
}

function shapeRun(raw: unknown): EntityRunYaml | null | { error: string } {
  if (raw === null || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r["template"] !== "string" || r["template"].trim() === "") return null
  if (Array.isArray(r["steps"]) && r["steps"].length > 0) {
    return {
      error:
        'run.steps is not supported — define steps on the flow in Sync metadata → Flows (use run.template only)',
    }
  }
  return {
    template: r["template"] as string,
    service: typeof r["service"] === "string" ? r["service"] : "default",
    environment: typeof r["environment"] === "string" ? r["environment"] : "default",
  }
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
    userControllable: typeof t["userControllable"] === "boolean" ? t["userControllable"] : null
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
        through: (s["through"] as unknown[]).map((h, j) => shapeFkHop(h, idx, j))
      }
    case "sql":
      if (typeof s["predicate"] !== "string")
        throw new Error(`tables[${idx}].scope.predicate required for sql`)
      return { kind: "sql", predicate: s["predicate"] as string }
    default:
      throw new Error(`tables[${idx}].scope.kind must be rootPk|sql (legacy fkPath is accepted on import and normalized)`)
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
    toColumn: h["toColumn"] as string
  }
}

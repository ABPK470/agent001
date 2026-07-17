/**
 * Suggest entity registry draft fields from root table name + optional schema catalog.
 */

import { scopeFromAuthoredPredicate } from "./from-authored-sync.js"
import { orderEntityTablesDetailed } from "./order.js"
import type { EntityDefinition, EntityTable, EntityTableScope } from "./types.js"

const ALLOWED_SCHEMAS = new Set(["core", "coreArchive", "gate", "gateArchive", "master"])

export interface CatalogTableForSuggest {
  schema: string
  name: string
  qualifiedName: string
  columns: Array<{ name: string; isPK: boolean }>
  fkOutgoing: Array<{
    fromSchema: string
    fromTable: string
    fromColumn: string
    toSchema: string
    toTable: string
    toColumn: string
  }>
}

export interface CatalogSnapshotForSuggest {
  tables: CatalogTableForSuggest[]
}

export interface EntityDraftIdentitySuggestion {
  id: string
  displayName: string
  description: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  selfJoinColumn: string | null
}

export interface EntityDraftSuggestion {
  identity: EntityDraftIdentitySuggestion
  tables: EntityTable[]
  flowTemplateId: string | null
  source: "heuristic" | "catalog"
  notes: string[]
}

export interface EntityTableSuggestion {
  table: EntityTable
  source: "heuristic" | "catalog" | "unreachable"
  note: string | null
}

export function humanizeTableName(tableName: string): string {
  return tableName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
}

export function entityIdFromTableName(tableName: string): string {
  if (!tableName) return ""
  return tableName.charAt(0).toLowerCase() + tableName.slice(1)
}

export function defaultIdColumnFromTableName(tableName: string): string {
  const base = entityIdFromTableName(tableName)
  return base ? `${base}Id` : ""
}

export function normalizeQualifiedTableName(rootTable: string): string {
  const trimmed = rootTable.trim()
  if (!trimmed) return ""
  if (trimmed.includes(".")) return trimmed
  return `core.${trimmed}`
}

export function suggestIdentityHeuristic(rootTable: string): EntityDraftIdentitySuggestion {
  const qualified = normalizeQualifiedTableName(rootTable)
  const tableName = qualified.split(".").pop() ?? ""
  const id = entityIdFromTableName(tableName)
  const displayName = humanizeTableName(tableName)
  const idColumn = defaultIdColumnFromTableName(tableName)
  return {
    id,
    displayName,
    description: displayName ? `Sync definition for ${displayName}.` : "",
    rootTable: qualified,
    idColumn,
    labelColumn: "name",
    selfJoinColumn: null,
  }
}

export function suggestFlowTemplateId(entityId: string, available: readonly string[]): string | null {
  if (!entityId) return null
  if (available.includes(entityId)) return entityId
  if (entityId === "gateMetadata" && available.includes("gateMetadata")) return "gateMetadata"
  if (entityId === "pipelineActivity" && available.includes("pipelineActivity")) return "pipelineActivity"
  return available.includes("metadataOnly") ? "metadataOnly" : available[0] ?? null
}

function catalogIndex(snapshot: CatalogSnapshotForSuggest): Map<string, CatalogTableForSuggest> {
  return new Map(snapshot.tables.map((table) => [table.qualifiedName.toLowerCase(), table]))
}

function findTable(index: Map<string, CatalogTableForSuggest>, qualifiedName: string): CatalogTableForSuggest | null {
  return index.get(qualifiedName.toLowerCase()) ?? null
}

function findPrimaryKeyColumn(table: CatalogTableForSuggest): string | null {
  return table.columns.find((column) => column.isPK)?.name ?? null
}

function findLabelColumn(table: CatalogTableForSuggest, rootKey: string): string | null {
  const preferred = table.columns.find((column) => /^(name|title|displayName)$/i.test(column.name))
  return preferred?.name ?? (rootKey || null)
}

function findSelfJoinColumn(table: CatalogTableForSuggest, rootKey: string): string | null {
  const edge = table.fkOutgoing.find(
    (fk) =>
      fk.toSchema === table.schema &&
      fk.toTable === table.name &&
      fk.fromColumn !== rootKey &&
      fk.fromColumn.toLowerCase().includes("parent"),
  )
  return edge?.fromColumn ?? null
}

function buildFkEdges(snapshot: CatalogSnapshotForSuggest) {
  const edges: Array<{
    parentSchema: string
    parentTable: string
    parentColumn: string
    childSchema: string
    childTable: string
    childColumn: string
  }> = []
  for (const table of snapshot.tables) {
    for (const fk of table.fkOutgoing) {
      if (!ALLOWED_SCHEMAS.has(fk.fromSchema) || !ALLOWED_SCHEMAS.has(fk.toSchema)) continue
      edges.push({
        parentSchema: fk.toSchema,
        parentTable: fk.toTable,
        parentColumn: fk.toColumn,
        childSchema: fk.fromSchema,
        childTable: fk.fromTable,
        childColumn: fk.fromColumn,
      })
    }
  }
  return edges
}

function quoteTable(qualifiedName: string): string {
  const [schemaName, tableName] = qualifiedName.split(".")
  return `[${schemaName}].[${tableName}]`
}

function fkClosure(
  rootTable: string,
  rootKey: string,
  edges: ReturnType<typeof buildFkEdges>,
): Map<string, { scopeColumn: string | null; predicate: string; hasRootKey: boolean }> {
  const adjacency = new Map<string, Array<{ child: string; childColumn: string; parentColumn: string }>>()
  for (const edge of edges) {
    const parent = `${edge.parentSchema}.${edge.parentTable}`
    if (!adjacency.has(parent)) adjacency.set(parent, [])
    adjacency.get(parent)!.push({
      child: `${edge.childSchema}.${edge.childTable}`,
      childColumn: edge.childColumn,
      parentColumn: edge.parentColumn,
    })
  }

  const visited = new Map<string, { scopeColumn: string | null; predicate: string; hasRootKey: boolean }>()
  visited.set(rootTable, { scopeColumn: rootKey, predicate: `${rootKey} = {id}`, hasRootKey: true })
  const queue = [rootTable]

  while (queue.length > 0) {
    const current = queue.shift()!
    const currentInfo = visited.get(current)!
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.child)) continue
      const [schemaName] = edge.child.split(".")
      if (!ALLOWED_SCHEMAS.has(schemaName)) continue

      let predicate: string
      let scopeColumn: string | null
      let hasRootKey: boolean
      if (edge.parentColumn === rootKey) {
        predicate = `${edge.childColumn} = {id}`
        scopeColumn = edge.childColumn
        hasRootKey = true
      } else if (currentInfo.hasRootKey) {
        predicate = `EXISTS (SELECT 1 FROM ${quoteTable(current)} p WHERE p.${edge.parentColumn} = ${quoteTable(edge.child)}.${edge.childColumn} AND p.${rootKey} = {id})`
        scopeColumn = null
        hasRootKey = false
      } else {
        predicate = `EXISTS (SELECT 1 FROM ${quoteTable(current)} p WHERE p.${edge.parentColumn} = ${quoteTable(edge.child)}.${edge.childColumn})`
        scopeColumn = null
        hasRootKey = false
      }
      visited.set(edge.child, { scopeColumn, predicate, hasRootKey })
      queue.push(edge.child)
    }
  }
  return visited
}

function predicateToScope(predicate: string, root: { rootTable: string; idColumn: string }): EntityTableScope {
  return scopeFromAuthoredPredicate(predicate, root)
}

function tableFromClosure(
  name: string,
  info: { scopeColumn: string | null; predicate: string; hasRootKey: boolean },
  root: { rootTable: string; idColumn: string },
  executionOrder: number,
): EntityTable {
  const isRoot = name.toLowerCase() === root.rootTable.toLowerCase()
  return {
    name,
    scope: predicateToScope(info.predicate, root),
    executionOrder,
    scd2Override: null,
    verified: false,
    archiveTable: null,
    note: isRoot
      ? null
      : info.hasRootKey
        ? "Suggested: direct FK to entity root."
        : "Suggested from FK graph — review scope before publish.",
    provenance: { kind: "fkGraphSuggester", confidence: info.hasRootKey ? "high" : "medium" },
    scopeColumn: info.scopeColumn,
    source: isRoot ? "manual" : "fk-only",
    groundedByPipeline: false,
    enabledByDefault: isRoot || info.hasRootKey,
    userControllable: !isRoot && !info.hasRootKey,
  }
}

export function suggestEntityTable(
  tableNameInput: string,
  root: { rootTable: string; idColumn: string },
  options?: {
    catalog?: CatalogSnapshotForSuggest | null
    executionOrder?: number
  },
): EntityTableSuggestion | null {
  const tableName = normalizeQualifiedTableName(tableNameInput)
  const rootTable = normalizeQualifiedTableName(root.rootTable)
  const idColumn = root.idColumn.trim()
  if (!tableName || !tableName.includes(".") || !rootTable || !idColumn) return null

  const executionOrder = options?.executionOrder ?? 1
  const rootCtx = { rootTable, idColumn }
  const isRoot = tableName.toLowerCase() === rootTable.toLowerCase()

  if (isRoot) {
    return {
      table: tableFromClosure(
        tableName,
        { scopeColumn: idColumn, predicate: `${idColumn} = {id}`, hasRootKey: true },
        rootCtx,
        executionOrder,
      ),
      source: "heuristic",
      note: "Entity root table.",
    }
  }

  const catalog = options?.catalog ?? null
  if (!catalog) {
    return {
      table: {
        name: tableName,
        scope: { kind: "rootPk", column: "" },
        executionOrder,
        scd2Override: null,
        verified: false,
        archiveTable: null,
        note: null,
        provenance: { kind: "manual" },
        scopeColumn: null,
        source: "manual",
        groundedByPipeline: false,
        enabledByDefault: true,
        userControllable: null,
      },
      source: "heuristic",
      note: "Load a schema catalog to suggest scope from the FK graph.",
    }
  }

  const index = catalogIndex(catalog)
  const rootMeta = findTable(index, rootTable)
  const tableMeta = findTable(index, tableName)
  if (!tableMeta) {
    return {
      table: {
        name: tableName,
        scope: { kind: "rootPk", column: "" },
        executionOrder,
        scd2Override: null,
        verified: false,
        archiveTable: null,
        note: null,
        provenance: { kind: "manual" },
        scopeColumn: null,
        source: "manual",
        groundedByPipeline: false,
        enabledByDefault: true,
        userControllable: null,
      },
      source: "heuristic",
      note: `${tableName} was not found in the schema catalog.`,
    }
  }

  if (rootMeta) {
    const closure = fkClosure(rootTable, idColumn, buildFkEdges(catalog))
    const fromGraph = closure.get(tableName)
    if (fromGraph) {
      return {
        table: tableFromClosure(tableName, fromGraph, rootCtx, executionOrder),
        source: "catalog",
        note: null,
      }
    }

    const directFk = tableMeta.fkOutgoing.find(
      (fk) =>
        `${fk.toSchema}.${fk.toTable}`.toLowerCase() === rootTable.toLowerCase() &&
        fk.toColumn.toLowerCase() === idColumn.toLowerCase(),
    )
    if (directFk) {
      return {
        table: tableFromClosure(
          tableName,
          {
            scopeColumn: directFk.fromColumn,
            predicate: `${directFk.fromColumn} = {id}`,
            hasRootKey: true,
          },
          rootCtx,
          executionOrder,
        ),
        source: "catalog",
        note: "Direct FK to entity root.",
      }
    }
  }

  return {
    table: {
      name: tableName,
      scope: { kind: "sql", predicate: "" },
      executionOrder,
      scd2Override: null,
      verified: false,
      archiveTable: null,
      note: "No FK path to entity root — set scope manually.",
      provenance: { kind: "manual" },
      scopeColumn: null,
      source: "manual",
      groundedByPipeline: false,
      enabledByDefault: false,
      userControllable: true,
    },
    source: "unreachable",
    note: "No FK path to entity root was found in the catalog.",
  }
}

export function suggestEntityDraft(
  rootTableInput: string,
  options?: {
    catalog?: CatalogSnapshotForSuggest | null
    flowTemplateIds?: readonly string[]
  },
): EntityDraftSuggestion | null {
  const rootTable = normalizeQualifiedTableName(rootTableInput)
  if (!rootTable || !rootTable.includes(".")) return null

  const notes: string[] = []
  const catalog = options?.catalog ?? null
  const index = catalog ? catalogIndex(catalog) : null
  const rootMeta = index ? findTable(index, rootTable) : null

  if (catalog && !rootMeta) {
    notes.push(`Table ${rootTable} was not found in the schema catalog — using name heuristics only.`)
  }

  const heuristic = suggestIdentityHeuristic(rootTable)
  const idColumn = rootMeta ? findPrimaryKeyColumn(rootMeta) ?? heuristic.idColumn : heuristic.idColumn
  if (!idColumn) return null

  const identity: EntityDraftIdentitySuggestion = {
    ...heuristic,
    idColumn,
    labelColumn: rootMeta ? findLabelColumn(rootMeta, idColumn) : heuristic.labelColumn,
    selfJoinColumn: rootMeta ? findSelfJoinColumn(rootMeta, idColumn) : null,
  }

  let tables: EntityTable[] = []
  if (catalog && rootMeta) {
    const closure = fkClosure(rootTable, idColumn, buildFkEdges(catalog))
    const draftTables = [...closure.keys()].map((name, index) =>
      tableFromClosure(name, closure.get(name)!, { rootTable, idColumn }, index + 1),
    )
    tables = orderEntityTablesDetailed({ rootTable, tables: draftTables }).tables.map((table, index) => ({
      ...table,
      executionOrder: index + 1,
    }))
    notes.push(`Suggested ${tables.length} table(s) from FK graph starting at ${rootTable}.`)
  } else if (rootTable) {
    tables = [
      tableFromClosure(
        rootTable,
        { scopeColumn: idColumn, predicate: `${idColumn} = {id}`, hasRootKey: true },
        { rootTable, idColumn },
        1,
      ),
    ]
    notes.push("Added root table only — load a schema catalog to suggest related tables.")
  }

  return {
    identity,
    tables,
    flowTemplateId: suggestFlowTemplateId(identity.id, options?.flowTemplateIds ?? []),
    source: catalog && rootMeta ? "catalog" : "heuristic",
    notes,
  }
}

/** Type guard for partial entity defs in tests. */
export function suggestionToEntityShell(suggestion: EntityDraftSuggestion): Pick<EntityDefinition, "id" | "rootTable" | "tables"> {
  return {
    id: suggestion.identity.id,
    rootTable: suggestion.identity.rootTable,
    tables: suggestion.tables,
  }
}

/** Map agent / server catalog-cache JSON into the suggester input shape. */
export function catalogSnapshotFromAgentJson(raw: unknown): CatalogSnapshotForSuggest | null {
  if (!raw || typeof raw !== "object") return null
  const tables = (raw as { tables?: unknown }).tables
  if (!Array.isArray(tables)) return null

  const mapped: CatalogTableForSuggest[] = []
  for (const entry of tables) {
    if (!entry || typeof entry !== "object") continue
    const table = entry as Record<string, unknown>
    const schema = String(table.schema ?? "")
    const name = String(table.name ?? "")
    if (!schema || !name) continue
    const qualifiedName =
      typeof table.qualifiedName === "string" && table.qualifiedName.includes(".")
        ? table.qualifiedName
        : `${schema}.${name}`
    const columns = Array.isArray(table.columns)
      ? table.columns
          .map((column) => {
            const col = column as Record<string, unknown>
            const columnName = String(col.name ?? "")
            if (!columnName) return null
            return { name: columnName, isPK: Boolean(col.isPK) }
          })
          .filter((column): column is { name: string; isPK: boolean } => column !== null)
      : []
    const fkOutgoing = Array.isArray(table.fkOutgoing)
      ? table.fkOutgoing
          .map((fk) => {
            const edge = fk as Record<string, unknown>
            return {
              fromSchema: String(edge.fromSchema ?? ""),
              fromTable: String(edge.fromTable ?? ""),
              fromColumn: String(edge.fromColumn ?? ""),
              toSchema: String(edge.toSchema ?? ""),
              toTable: String(edge.toTable ?? ""),
              toColumn: String(edge.toColumn ?? ""),
            }
          })
          .filter(
            (edge) =>
              edge.fromSchema &&
              edge.fromTable &&
              edge.fromColumn &&
              edge.toSchema &&
              edge.toTable &&
              edge.toColumn,
          )
      : []
    mapped.push({ schema, name, qualifiedName, columns, fkOutgoing })
  }

  return mapped.length > 0 ? { tables: mapped } : null
}

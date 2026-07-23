/**
 * Import path: authored sync definition → entity registry row.
 *
 * Deploy-owned `deploy/sync/artifacts/entities/*.json` files are authored
 * sync definitions. On a fresh database the server seeds `entity_active` from
 * these artifacts so the Entity Registry widget is populated before any
 * operator import.
 */
import { asFlowId, asStrategyId, asTenantId, type FlowId } from "../../domain/types/branded-ids.js"


import type { AuthoredSyncDefinition, AuthoredSyncDefinitionTable } from "@mia/shared-types"

import {
  looksIncompleteScopePredicate,
  resolveReviewPlaceholderPredicate,
} from "./resolve-scope-predicate.js"

import type { EntityDefinition, EntityTable, EntityTableScope } from "../../domain/entity-registry/types.js"
import { renumberEntityTablesExecutionOrder } from "./order.js"

const BOOTSTRAP_ACTOR = "system"

/**
 * Legacy authored artifacts may contain review placeholders in SQL comments.
 * Strip them at the bootstrap import boundary only.
 */
export function normalizeAuthoredPredicate(predicate: string): string {
  return predicate
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function quoteSqlIdentifier(identifier: string): string {
  return `[${identifier.replace(/]/g, "]]")}]`
}

function quoteSqlTable(name: string): string {
  const parts = name.split(".")
  if (parts.length === 2) {
    return `${quoteSqlIdentifier(parts[0]!)}.${quoteSqlIdentifier(parts[1]!)}`
  }
  return quoteSqlIdentifier(name)
}

/**
 * Entity registry SQL scopes must reference {id}/{ids}. Intermediate-hop
 * authored predicates that only correlate through FK chains get a root
 * correlation suffix so bootstrap imports pass structural validation.
 */
export function ensureEntityScopePlaceholder(
  predicate: string,
  rootTable: string,
  idColumn: string,
): string {
  if (predicate.includes("{id}") || predicate.includes("{ids}")) return predicate
  const root = quoteSqlTable(rootTable)
  const idCol = quoteSqlIdentifier(idColumn)
  return `(${predicate}) AND EXISTS (SELECT 1 FROM ${root} AS __mia_root WHERE __mia_root.${idCol} = {id})`
}

export function scopeFromAuthoredPredicate(
  predicate: string,
  root?: {
    rootTable: string
    idColumn: string
    selfJoinColumn?: string | null
    tableName?: string
    scopeColumn?: string | null
  },
): EntityTableScope {
  const resolved =
    root?.tableName
      ? resolveReviewPlaceholderPredicate(predicate, {
          rootTable: root.rootTable,
          idColumn: root.idColumn,
          selfJoinColumn: root.selfJoinColumn ?? null,
          tableName: root.tableName,
          scopeColumn: root.scopeColumn ?? null,
        })
      : predicate
  const input = resolved ?? predicate
  const trimmed = normalizeAuthoredPredicate(input)
  const simpleEq = trimmed.match(/^\[?([A-Za-z_][A-Za-z0-9_]*)\]?\s*=\s*\{id\}$/)
  if (simpleEq) {
    return { kind: "rootPk", column: simpleEq[1]! }
  }
  const inIds = trimmed.match(/^\[?([A-Za-z_][A-Za-z0-9_]*)\]?\s+IN\s+\(\{ids\}\)$/i)
  if (inIds) {
    return { kind: "rootPk", column: inIds[1]! }
  }
  const sqlPredicate =
    root === undefined ? trimmed : ensureEntityScopePlaceholder(trimmed, root.rootTable, root.idColumn)
  return { kind: "sql", predicate: sqlPredicate }
}

function tableProvenance(
  table: AuthoredSyncDefinitionTable,
  pipelineId: number | null,
): EntityTable["provenance"] {
  if (table.source === "fk-only") {
    return { kind: "fkGraphSuggester", confidence: table.verified ? "high" : "medium" }
  }
  if (pipelineId !== null) {
    return { kind: "sproc", sprocName: `legacy-pipeline:${pipelineId}` }
  }
  return { kind: "manual" }
}

function entityTableFromAuthored(
  table: AuthoredSyncDefinitionTable,
  executionOrder: number,
  pipelineId: number | null,
  root: Pick<AuthoredSyncDefinition, "rootTable" | "idColumn" | "selfJoinColumn">,
): EntityTable {
  const scope = scopeFromAuthoredPredicate(table.predicate, {
    rootTable: root.rootTable,
    idColumn: root.idColumn,
    selfJoinColumn: root.selfJoinColumn,
    tableName: table.name,
    scopeColumn: table.scopeColumn,
  })
  const wasReviewPlaceholder = looksIncompleteScopePredicate(table.predicate)
  const incomplete = scope.kind === "sql" && looksIncompleteScopePredicate(scope.predicate)
  const autoResolved = wasReviewPlaceholder && !incomplete

  return {
    name: table.name,
    scope,
    executionOrder,
    scd2Override: null,
    verified: autoResolved ? true : table.verified && !incomplete,
    archiveTable: null,
    note: table.note ?? null,
    provenance: tableProvenance(table, pipelineId),
    scopeColumn: table.scopeColumn,
    source: table.source,
    groundedByPipeline: table.groundedByPipeline,
    enabledByDefault: incomplete ? false : table.enabledByDefault,
    userControllable: table.userControllable,
  }
}

export type EntityDefinitionFromAuthoredOptions = {
  /** Stable stamp for seeds/goldens — defaults to wall clock. */
  createdAt?: string
  /** Flow association — defaults to authored.id (caller may resolve via catalog). */
  flowId?: FlowId
}

export function entityDefinitionFromAuthoredSync(
  authored: AuthoredSyncDefinition,
  tenantId = "_default",
  options?: EntityDefinitionFromAuthoredOptions,
): EntityDefinition {
  const orderIndex = new Map(
    authored.metadata.executionOrder.map((name, index) => [name.toLowerCase(), index + 1] as const),
  )
  const pipelineId = authored.legacy.pipelineId
  const tables = authored.metadata.tables.map((table, fallbackIndex) =>
    entityTableFromAuthored(
      table,
      orderIndex.get(table.name.toLowerCase()) ?? fallbackIndex + 1,
      pipelineId,
      authored,
    ),
  )

  const provenance =
    authored.provenance.kind === "legacy-migration" || pipelineId !== null
      ? ({ kind: "legacy-migration" as const, legacyPipelineId: pipelineId })
      : ({ kind: "manual" as const })

  return {
    id: authored.id,
    tenantId: asTenantId(tenantId),
    displayName: authored.displayName,
    description: authored.description,
    rootTable: authored.rootTable,
    idColumn: authored.idColumn,
    labelColumn: authored.labelColumn,
    selfJoinColumn: authored.selfJoinColumn,
    tables: renumberEntityTablesExecutionOrder(tables),
    policies: {
      freezeWindowIds: [...authored.governance.freezeWindowIds],
    },
    scd2: {
      strategyId: asStrategyId(authored.strategy.strategyId),
      strategyVersion: authored.strategy.strategyVersion,
      entityOverride: null,
    },
    lineageRefs: [],
    provenance,
    flowId: asFlowId(options?.flowId ?? authored.id),
    legacyEntrySproc: authored.legacy.entrySproc,
    reverseOrder: [...authored.metadata.reverseOrder],
    discrepancies: authored.metadata.discrepancies.map(
      (d) => `[${d.kind}] ${d.table}: ${d.note}`,
    ),
    version: 1,
    versionLabel: "bundled-seed",
    createdBy: BOOTSTRAP_ACTOR,
    reason: "bundled-seed",
    createdAt: options?.createdAt ?? new Date().toISOString(),
    retiredAt: null,
  }
}

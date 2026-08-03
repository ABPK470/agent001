/**
 * Entity-search and related helpers for the sync orchestrator.
 */

import sqlMod from "mssql"
import { randomUUID } from "node:crypto"
import type { PublishedSyncDefinition } from "@mia/shared-types"

import { parseEntityInstanceRef, coerceSyncEntityId, isUnresolvedEntityName, pickUniqueEntitySearchHit } from "../../core/scope/entity-instance-ref.js"
import type { SyncEntityId } from "../../core/scope/definition-selection.js"
import { SyncOperationType } from "../../domain/enums.js"
import { asEntityId } from "../../domain/types/branded-ids.js"
import { getPublishedSyncDefinition } from "../../runtime/published-definitions.js"
import type { SyncTelemetryContext } from "../../ports/events.js"
import { getPool } from "../../adapters/mssql/connection.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { resolveWarehouseDialect } from "../warehouse-dialect.js"
import { projectRoot, trackedLoggedQuery, trackedQuery } from "./db/db-helpers.js"

export interface EntitySearchResult {
  id: string | number
  name: string | null
}

export type EntitySearchMode = "name" | "id"

export function resolveSyncEntitySearch(
  rawQuery: string,
  explicitMode?: EntitySearchMode | "auto"
): { q: string; mode: EntitySearchMode } {
  const parsed = parseEntityInstanceRef(rawQuery)
  if (parsed.entityId) return { q: parsed.entityId, mode: "id" }
  if (explicitMode === "id") {
    return { q: parsed.entityQuery ?? rawQuery.trim(), mode: "id" }
  }
  return { q: parsed.entityQuery ?? rawQuery.trim(), mode: "name" }
}

function discoveryContext(telemetryContext?: SyncTelemetryContext): SyncTelemetryContext {
  if (telemetryContext) {
    return { ...telemetryContext, scope: telemetryContext.scope ?? "discovery" }
  }
  return {
    kind: SyncOperationType.Preview,
    opId: randomUUID(),
    scope: "discovery"
  }
}

function invalidRootNameColumnError(definition: PublishedSyncDefinition, columns: string[]): Error {
  const detail =
    columns.length > 0
      ? ` Available columns on ${definition.rootTable}: ${columns.join(", ")}.`
      : ` No readable columns were returned for ${definition.rootTable}.`
  return new Error(
    `Sync definition configuration error for ${definition.id}: ` +
      `labelColumn "${definition.labelColumn ?? "<null>"}" does not exist on ${definition.rootTable}.` +
      detail
  )
}

async function resolveDisplayColumn(
  host: SyncRuntimeHost,
  source: string,
  definition: PublishedSyncDefinition,
  telemetryContext?: SyncTelemetryContext
): Promise<string> {
  if (!definition.labelColumn) {
    throw new Error(
      `Sync definition configuration error for ${definition.id}: labelColumn is required for ${definition.rootTable}.`
    )
  }
  const [schema, table] = definition.rootTable.split(".")
  if (!schema || !table) {
    throw new Error(
      `Sync definition configuration error for ${definition.id}: rootTable "${definition.rootTable}" must be schema-qualified.`
    )
  }
  const ctx = discoveryContext(telemetryContext)
  const dialect = resolveWarehouseDialect(host, source)
  const sqlText = dialect.rootTableColumnsSql(schema, table)
  const result = await trackedLoggedQuery(
    host,
    source,
    `discovery.columns(${definition.rootTable})`,
    sqlText,
    async () => {
      const { pool } = await getPool(host, source)
      return pool.request().query(sqlText)
    },
    ctx
  )

  const columns = result.recordset
    .map((row: Record<string, unknown>) => String(row.name ?? ""))
    .filter((name) => name.length > 0)
  const lowerToActual = new Map(columns.map((name) => [name.toLowerCase(), name]))
  const requested = lowerToActual.get(definition.labelColumn.toLowerCase())
  if (requested) return requested
  throw invalidRootNameColumnError(definition, columns)
}

export async function searchEntities(
  host: SyncRuntimeHost,
  entityType: SyncEntityId,
  source: string,
  query: string,
  limit = 200,
  mode: EntitySearchMode = "name"
): Promise<EntitySearchResult[]> {
  const definition = getPublishedSyncDefinition(host, projectRoot(host), asEntityId(entityType))
  const ctx = discoveryContext()
  const displayColumn = await resolveDisplayColumn(host, source, definition, ctx)
  const safeLike = query.replace(/[%_[\]^]/g, "[$&]")
  const capped = Math.min(limit, 500)

  const dialect = resolveWarehouseDialect(host, source)
  const fromTable = `${dialect.quoteTable(definition.rootTable)}${dialect.readFromHintSql()}`

  if (mode === "id") {
    const sqlForLog = `
        SELECT TOP (${capped})
          [${definition.idColumn}] AS id,
          [${displayColumn}] AS name
        FROM ${fromTable}
        WHERE CAST([${definition.idColumn}] AS NVARCHAR(100)) LIKE N'${safeLike.replace(/'/g, "''")}%'
        ORDER BY [${definition.idColumn}]
      `
    const r = await trackedLoggedQuery(
      host,
      source,
      `discovery.searchById(${entityType})`,
      sqlForLog,
      async () => {
        const { pool } = await getPool(host, source)
        return pool
          .request()
          .input("q", sqlMod.NVarChar(100), `${safeLike}%`)
          .input("limit", sqlMod.Int, capped).query(`
            SELECT TOP (@limit)
              [${definition.idColumn}] AS id,
              [${displayColumn}] AS name
            FROM ${fromTable}
            WHERE CAST([${definition.idColumn}] AS NVARCHAR(100)) LIKE @q
            ORDER BY [${definition.idColumn}]
          `)
      },
      ctx
    )
    return r.recordset.map((row: Record<string, unknown>) => ({
      id: row.id as string | number,
      name: (row.name as string | null) ?? null
    }))
  }

  const sqlForLog = `
      SELECT TOP (${capped})
        [${definition.idColumn}] AS id,
        [${displayColumn}] AS name
      FROM ${fromTable}
      WHERE [${displayColumn}] LIKE N'%${safeLike.replace(/'/g, "''")}%'
      ORDER BY [${displayColumn}]
    `
  const r = await trackedLoggedQuery(
    host,
    source,
    `discovery.searchByName(${entityType})`,
    sqlForLog,
    async () => {
      const { pool } = await getPool(host, source)
      return pool
        .request()
        .input("q", sqlMod.NVarChar(400), `%${safeLike}%`)
        .input("limit", sqlMod.Int, capped).query(`
          SELECT TOP (@limit)
            [${definition.idColumn}] AS id,
            [${displayColumn}] AS name
          FROM ${fromTable}
          WHERE [${displayColumn}] LIKE @q
          ORDER BY [${displayColumn}]
        `)
    },
    ctx
  )
  return r.recordset.map((row: Record<string, unknown>) => ({
    id: row.id as string | number,
    name: (row.name as string | null) ?? null
  }))
}

export interface ResolvedSyncEntityInstance {
  id: string | number
  displayName: string | null
  resolvedFrom: "id" | "name"
}

/**
 * One seam for preview / tools / HTTP: accept numeric id **or** display name,
 * always return the root-table primary key before any int-scoped SQL.
 *
 * Matches Env Sync UI: search → commit id → preview. Agents may skip search
 * and pass the name straight into sync_preview; this closes that gap.
 */
export async function resolveSyncEntityInstanceId(args: {
  host: SyncRuntimeHost
  entityType: SyncEntityId
  source: string
  entityId: string | number
}): Promise<ResolvedSyncEntityInstance> {
  const coerced = coerceSyncEntityId(args.entityId)

  if (!isUnresolvedEntityName(coerced)) {
    const id =
      typeof coerced === "number"
        ? coerced
        : /^\d+$/.test(String(coerced).trim())
          ? Number(String(coerced).trim())
          : coerced
    return { id, displayName: null, resolvedFrom: "id" }
  }

  const query = String(coerced).trim()
  const hits = await searchEntities(args.host, args.entityType, args.source, query, 25, "name")
  const picked = pickUniqueEntitySearchHit(query, hits)

  if (!picked.ok && picked.reason === "none") {
    throw new Error(
      `No ${args.entityType} named "${query}" found on ${args.source}. ` +
        `Use a numeric id, or search_sync_entities to find the instance.`,
    )
  }
  if (!picked.ok) {
    const sample = picked.hits
      .slice(0, 5)
      .map((h) => `${h.name ?? "?"} (#${h.id})`)
      .join(", ")
    throw new Error(
      `Ambiguous ${args.entityType} name "${query}" on ${args.source} — ` +
        `${picked.hits.length} matches (e.g. ${sample}). Pass the numeric id.`,
    )
  }

  const rawId = picked.hit.id
  const id =
    typeof rawId === "number"
      ? rawId
      : /^\d+$/.test(String(rawId).trim())
        ? Number(String(rawId).trim())
        : rawId

  return {
    id,
    displayName: picked.hit.name,
    resolvedFrom: "name",
  }
}

export async function fetchEntityDisplayName(
  host: SyncRuntimeHost,
  definition: PublishedSyncDefinition,
  entityId: string | number,
  source: string,
  telemetryContext?: SyncTelemetryContext
): Promise<string | null> {
  const id = coerceSyncEntityId(entityId)
  const ctx = discoveryContext(telemetryContext)
  const displayColumn = await resolveDisplayColumn(host, source, definition, ctx)
  const dialect = resolveWarehouseDialect(host, source)
  const idLiteral = typeof id === "number" ? String(id) : `N'${String(id).replace(/'/g, "''")}'`
  const sqlText = `
    SELECT TOP 1 [${displayColumn}] AS displayName
    FROM ${dialect.quoteTable(definition.rootTable)}${dialect.readFromHintSql()}
    WHERE [${definition.idColumn}] = ${idLiteral}
  `
  const r = await trackedQuery<{ displayName: string | null }>(
    host,
    source,
    sqlText,
    `discovery.displayName(${definition.rootTable})`,
    ctx,
  )
  return (r.recordset[0]?.displayName as string | undefined) ?? null
}

export async function expandTreeIds(
  host: SyncRuntimeHost,
  definition: PublishedSyncDefinition,
  entityId: string | number,
  source: string,
  telemetryContext?: SyncTelemetryContext
): Promise<Array<string | number>> {
  const id = coerceSyncEntityId(entityId)
  if (!definition.selfJoinColumn) return [id]
  const ctx = discoveryContext(telemetryContext)
  const dialect = resolveWarehouseDialect(host, source)
  const pk = definition.idColumn
  const fk = definition.selfJoinColumn
  const table = dialect.quoteTable(definition.rootTable)
  const idLiteral = typeof id === "number" ? String(id) : `N'${String(id).replace(/'/g, "''")}'`
  const sqlForLog = `
      ;WITH tree AS (
        SELECT [${pk}] FROM ${table} WHERE [${pk}] = ${idLiteral}
        UNION ALL
        SELECT child.[${pk}] FROM ${table} child
        INNER JOIN tree parent ON child.[${fk}] = parent.[${pk}]
      )
      SELECT [${pk}] AS id FROM tree
      OPTION (MAXRECURSION 100)
    `
  const idParam = typeof id === "number" ? sqlMod.Int : sqlMod.NVarChar(400)
  const r = await trackedLoggedQuery(
    host,
    source,
    `discovery.expandTree(${definition.rootTable})`,
    sqlForLog,
    async () => {
      const { pool } = await getPool(host, source)
      return pool.request().input("rootId", idParam, id).query(`
          ;WITH tree AS (
            SELECT [${pk}] FROM ${table} WHERE [${pk}] = @rootId
            UNION ALL
            SELECT child.[${pk}] FROM ${table} child
            INNER JOIN tree parent ON child.[${fk}] = parent.[${pk}]
          )
          SELECT [${pk}] AS id FROM tree
          OPTION (MAXRECURSION 100)
        `)
    },
    ctx
  )
  return r.recordset.map((row: Record<string, unknown>) => row.id as string | number)
}

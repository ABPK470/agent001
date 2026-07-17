/**
 * Entity-search and related helpers for the sync orchestrator.
 */

import sqlMod from "mssql"
import { randomUUID } from "node:crypto"
import type { PublishedSyncDefinition } from "@mia/shared-types"

import { parseEntityInstanceRef, coerceSyncEntityId } from "../../../domain/entity-instance-ref.js"
import type { SyncEntityId } from "../../../domain/definition-selection.js"
import { SyncOperationType } from "../../../domain/enums.js"
import { getPublishedSyncDefinition } from "../../../domain/published-definitions.js"
import type { SyncTelemetryContext } from "../../../ports/events.js"
import { getPool, type SyncRuntimeHost } from "../../../ports/index.js"
import { projectRoot, qtable, trackedLoggedQuery, trackedQuery } from "./db-helpers.js"

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
  const sqlForLog = `
      SELECT c.name
      FROM sys.columns c
      INNER JOIN sys.objects o ON o.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = N'${schema.replace(/'/g, "''")}'
        AND o.name = N'${table.replace(/'/g, "''")}'
        AND o.type IN ('U', 'V')
      ORDER BY c.column_id
    `
  const result = await trackedLoggedQuery(
    host,
    source,
    `discovery.columns(${definition.rootTable})`,
    sqlForLog,
    async () => {
      const { pool } = await getPool(host, source)
      return pool
        .request()
        .input("schema", sqlMod.NVarChar(128), schema)
        .input("table", sqlMod.NVarChar(128), table).query(`
          SELECT c.name
          FROM sys.columns c
          INNER JOIN sys.objects o ON o.object_id = c.object_id
          INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @schema
            AND o.name = @table
            AND o.type IN ('U', 'V')
          ORDER BY c.column_id
        `)
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
  const definition = getPublishedSyncDefinition(host, projectRoot(host), entityType)
  const ctx = discoveryContext()
  const displayColumn = await resolveDisplayColumn(host, source, definition, ctx)
  const safeLike = query.replace(/[%_[\]^]/g, "[$&]")
  const capped = Math.min(limit, 500)

  if (mode === "id") {
    const sqlForLog = `
        SELECT TOP (${capped})
          [${definition.idColumn}] AS id,
          [${displayColumn}] AS name
        FROM ${qtable(definition.rootTable)} WITH (NOLOCK)
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
            FROM ${qtable(definition.rootTable)} WITH (NOLOCK)
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
      FROM ${qtable(definition.rootTable)} WITH (NOLOCK)
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
          FROM ${qtable(definition.rootTable)} WITH (NOLOCK)
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
  const idLiteral = typeof id === "number" ? String(id) : `N'${String(id).replace(/'/g, "''")}'`
  const sqlText = `
    SELECT TOP 1 [${displayColumn}] AS displayName
    FROM ${qtable(definition.rootTable)} WITH (NOLOCK)
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
  const pk = definition.idColumn
  const fk = definition.selfJoinColumn
  const table = qtable(definition.rootTable)
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

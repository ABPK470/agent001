/**
 * Entity-search and related helpers for the sync orchestrator.
 */

import sqlMod from "mssql"
import type { PublishedSyncDefinition } from "@mia/shared-types"

import { parseEntityInstanceRef, coerceSyncEntityId } from "../../../domain/entity-instance-ref.js"
import type { SyncEntityId } from "../../../domain/definition-selection.js"
import { getPublishedSyncDefinition } from "../../../domain/published-definitions.js"
import { getPool, type SyncRuntimeHost } from "../../../ports/index.js"
import { projectRoot, qtable } from "./db-helpers.js"

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
  definition: PublishedSyncDefinition
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
  const { pool } = await getPool(host, source)
  const result = await pool
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
  const displayColumn = await resolveDisplayColumn(host, source, definition)
  const { pool } = await getPool(host, source)
  const safeLike = query.replace(/[%_[\]^]/g, "[$&]")
  const capped = Math.min(limit, 500)

  if (mode === "id") {
    const r = await pool
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
    return r.recordset.map((row: Record<string, unknown>) => ({
      id: row.id as string | number,
      name: (row.name as string | null) ?? null
    }))
  }

  const r = await pool
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
  return r.recordset.map((row: Record<string, unknown>) => ({
    id: row.id as string | number,
    name: (row.name as string | null) ?? null
  }))
}

export async function fetchEntityDisplayName(
  host: SyncRuntimeHost,
  definition: PublishedSyncDefinition,
  entityId: string | number,
  source: string
): Promise<string | null> {
  const id = coerceSyncEntityId(entityId)
  const displayColumn = await resolveDisplayColumn(host, source, definition)
  const { pool } = await getPool(host, source)
  const r = await pool.request().query(`
    SELECT TOP 1 [${displayColumn}] AS displayName
    FROM ${qtable(definition.rootTable)} WITH (NOLOCK)
    WHERE [${definition.idColumn}] = ${typeof id === "number" ? id : `'${String(id).replace(/'/g, "''")}'`}
  `)
  return (r.recordset[0]?.displayName as string | undefined) ?? null
}

export async function expandTreeIds(
  host: SyncRuntimeHost,
  definition: PublishedSyncDefinition,
  entityId: string | number,
  source: string
): Promise<Array<string | number>> {
  const id = coerceSyncEntityId(entityId)
  if (!definition.selfJoinColumn) return [id]
  const { pool } = await getPool(host, source)
  const pk = definition.idColumn
  const fk = definition.selfJoinColumn
  const table = qtable(definition.rootTable)
  const idParam = typeof id === "number" ? sqlMod.Int : sqlMod.NVarChar(400)
  const r = await pool.request().input("rootId", idParam, id).query(`
      ;WITH tree AS (
        SELECT [${pk}] FROM ${table} WHERE [${pk}] = @rootId
        UNION ALL
        SELECT child.[${pk}] FROM ${table} child
        INNER JOIN tree parent ON child.[${fk}] = parent.[${pk}]
      )
      SELECT [${pk}] AS id FROM tree
      OPTION (MAXRECURSION 100)
    `)
  return r.recordset.map((row: Record<string, unknown>) => row.id as string | number)
}

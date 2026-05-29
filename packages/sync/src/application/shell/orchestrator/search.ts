/**
 * Entity-search and related helpers for the sync orchestrator.
 *
 * Houses:
 *  - `searchEntities`: name-based lookup against a recipe's root table
 *  - `fetchEntityDisplayName`: resolves an entity ID to its display name
 *  - `expandTreeIds`: recursive CTE walk for self-referencing FK trees
 *
 * @module
 */

import sqlMod from "mssql"
import { definitionToSyncRecipe, getPublishedSyncDefinition } from "../../../domain/published-definitions.js"
import {
    type EntityType,
    type SyncRecipe,
} from "../../../domain/recipes.js"
import { getPool, type AgentHost } from "../../../ports/index.js"
import { projectRoot, qtable } from "./db-helpers.js"

export interface EntitySearchResult {
  id: string | number
  name: string | null
}

function invalidRootNameColumnError(recipe: SyncRecipe, columns: string[]): Error {
  const detail = columns.length > 0
    ? ` Available columns on ${recipe.rootTable}: ${columns.join(", ")}.`
    : ` No readable columns were returned for ${recipe.rootTable}.`
  return new Error(
    `Sync recipe configuration error for ${recipe.entityType}: ` +
    `rootNameColumn "${recipe.rootNameColumn ?? "<null>"}" does not exist on ${recipe.rootTable}.` +
    detail,
  )
}

async function resolveDisplayColumn(
  host: AgentHost,
  source: string,
  recipe: SyncRecipe,
): Promise<string> {
  if (!recipe.rootNameColumn) {
    throw new Error(
      `Sync recipe configuration error for ${recipe.entityType}: rootNameColumn is required for ${recipe.rootTable}.`,
    )
  }
  const [schema, table] = recipe.rootTable.split(".")
  if (!schema || !table) {
    throw new Error(
      `Sync recipe configuration error for ${recipe.entityType}: rootTable "${recipe.rootTable}" must be schema-qualified.`,
    )
  }
  const { pool } = await getPool(host, source)
  const result = await pool.request()
    .input("schema", sqlMod.NVarChar(128), schema)
    .input("table", sqlMod.NVarChar(128), table)
    .query(`
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
  const requested = lowerToActual.get(recipe.rootNameColumn.toLowerCase())
  if (requested) return requested
  throw invalidRootNameColumnError(recipe, columns)
}

/**
 * Search for entities by name in the root table of a recipe.
 * Returns up to `limit` matches from the source environment.
 */
export async function searchEntities(
  host: AgentHost,
  entityType: EntityType,
  source: string,
  query: string,
  limit = 200,
): Promise<EntitySearchResult[]> {
  const recipe = definitionToSyncRecipe(getPublishedSyncDefinition(host, projectRoot(host), entityType))
  const displayColumn = await resolveDisplayColumn(host, source, recipe)
  const { pool } = await getPool(host, source)
  const safeLike = query.replace(/[%_[\]^]/g, "[$&]")
  const r = await pool.request()
    .input("q", sqlMod.NVarChar(400), `%${safeLike}%`)
    .input("limit", sqlMod.Int, Math.min(limit, 500))
    .query(`
      SELECT TOP (@limit)
        [${recipe.rootKeyColumn}] AS id,
        [${displayColumn}] AS name
      FROM ${qtable(recipe.rootTable)} WITH (NOLOCK)
      WHERE [${displayColumn}] LIKE @q
      ORDER BY [${displayColumn}]
    `)
  return r.recordset.map((row: Record<string, unknown>) => ({
    id: row.id as string | number,
    name: (row.name as string | null) ?? null,
  }))
}

export async function fetchEntityDisplayName(
  host: AgentHost,
  recipe: SyncRecipe,
  entityId: string | number,
  source: string,
): Promise<string | null> {
  const displayColumn = await resolveDisplayColumn(host, source, recipe)
  const { pool } = await getPool(host, source)
  const r = await pool.request().query(`
    SELECT TOP 1 [${displayColumn}] AS displayName
    FROM ${qtable(recipe.rootTable)} WITH (NOLOCK)
    WHERE [${recipe.rootKeyColumn}] = ${typeof entityId === "number" ? entityId : `'${String(entityId).replace(/'/g, "''")}'`}
  `)
  return (r.recordset[0]?.displayName as string | undefined) ?? null
}

/**
 * Expand a single entity ID to the full descendant tree via recursive CTE.
 *
 * Used when `recipe.selfJoinColumn` is set (e.g. `parentRuleId` on `core.Rule`).
 * Returns all IDs in the tree (root + all descendants). The result is substituted
 * into `{ids}` placeholders in recipe predicates so the diff captures the full
 * hierarchy — matching the behavior of legacy stored procedures that walk the
 * self-referencing FK with a recursive CTE.
 *
 * Runs against the SOURCE environment (the tree structure we want to replicate).
 */
export async function expandTreeIds(
  host: AgentHost,
  recipe: SyncRecipe,
  entityId: string | number,
  source: string,
): Promise<Array<string | number>> {
  if (!recipe.selfJoinColumn) return [entityId]
  const { pool } = await getPool(host, source)
  const pk = recipe.rootKeyColumn
  const fk = recipe.selfJoinColumn
  const table = qtable(recipe.rootTable)
  const idParam = typeof entityId === "number" ? sqlMod.Int : sqlMod.NVarChar(400)
  const r = await pool.request()
    .input("rootId", idParam, entityId)
    .query(`
      ;WITH tree AS (
        SELECT [${pk}] FROM ${table} WHERE [${pk}] = @rootId
        UNION ALL
        SELECT child.[${pk}] FROM ${table} child
        INNER JOIN tree parent ON child.[${fk}] = parent.[${pk}]
      )
      SELECT [${pk}] AS id FROM tree
      OPTION (MAXRECURSION 100)
    `)
  const ids = r.recordset.map((row: Record<string, unknown>) => row.id as string | number)
  if (ids.length === 0) return [entityId] // root not found — fall back to single id
  return ids
}

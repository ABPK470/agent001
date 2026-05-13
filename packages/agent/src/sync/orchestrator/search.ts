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
import { getPool } from "../../tools/index.js"
import {
    getRecipe,
    loadSyncRecipes,
    type EntityType,
    type SyncRecipe,
} from "../recipes.js"
import { projectRoot, qtable } from "./db-helpers.js"

export interface EntitySearchResult {
  id: string | number
  name: string | null
}

/**
 * Search for entities by name in the root table of a recipe.
 * Returns up to `limit` matches from the source environment.
 */
export async function searchEntities(
  entityType: EntityType,
  source: string,
  query: string,
  limit = 200,
): Promise<EntitySearchResult[]> {
  const recipe = getRecipe(loadSyncRecipes(projectRoot()), entityType)
  if (!recipe.rootNameColumn) return []
  const { pool } = await getPool(source)
  const safeLike = query.replace(/[%_[\]^]/g, "[$&]")
  const r = await pool.request()
    .input("q", sqlMod.NVarChar(400), `%${safeLike}%`)
    .input("limit", sqlMod.Int, Math.min(limit, 500))
    .query(`
      SELECT TOP (@limit)
        [${recipe.rootKeyColumn}] AS id,
        [${recipe.rootNameColumn}] AS name
      FROM ${qtable(recipe.rootTable)} WITH (NOLOCK)
      WHERE [${recipe.rootNameColumn}] LIKE @q
      ORDER BY [${recipe.rootNameColumn}]
    `)
  return r.recordset.map((row: Record<string, unknown>) => ({
    id: row.id as string | number,
    name: (row.name as string | null) ?? null,
  }))
}

export async function fetchEntityDisplayName(
  recipe: ReturnType<typeof getRecipe>,
  entityId: string | number,
  source: string,
): Promise<string | null> {
  if (!recipe.rootNameColumn) return null
  try {
    const { pool } = await getPool(source)
    const r = await pool.request().query(`
      SELECT TOP 1 [${recipe.rootNameColumn}] AS displayName
      FROM ${qtable(recipe.rootTable)} WITH (NOLOCK)
      WHERE [${recipe.rootKeyColumn}] = ${typeof entityId === "number" ? entityId : `'${String(entityId).replace(/'/g, "''")}'`}
    `)
    return (r.recordset[0]?.displayName as string | undefined) ?? null
  } catch {
    return null
  }
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
  recipe: SyncRecipe,
  entityId: string | number,
  source: string,
): Promise<Array<string | number>> {
  if (!recipe.selfJoinColumn) return [entityId]
  const { pool } = await getPool(source)
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

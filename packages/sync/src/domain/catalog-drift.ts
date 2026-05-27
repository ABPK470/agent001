/**
 * Catalog drift detection — compare schemas between two MSSQL connections.
 *
 * Used by:
 *   - the `compare_catalogs` agent tool (full schema comparison)
 *   - the preview preflight gate (restricted to recipe tables)
 *   - the execute preflight gate (hard refusal on drift)
 *
 * Schema scope is supplied by the caller (typically derived from the
 * active entity registry). Callers that haven't migrated yet pass
 * {@link DEFAULT_MYMI_SCHEMA_ALLOWLIST} for the historical Mymi set.
 */

import { getPool, type AgentHost } from "../ports/index.js"

export interface CatalogDriftResult {
  catalogCompatible: boolean
  issues: string[]
}

/**
 * Historical Mymi schema allowlist — used by callers that pre-date the
 * entity registry. New callers should pass a set derived from
 * `recipe.tables[].name` (the schema prefix of each).
 */
export const DEFAULT_MYMI_SCHEMA_ALLOWLIST: readonly string[] = Object.freeze([
  "core",
  "coreArchive",
  "gate",
  "gateArchive",
  "master",
])

interface SchemaSnapshot {
  tables: Set<string>
  cols: Map<string, Map<string, string>>
}

function isTransientCatalogDriftError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  const code = (e as { code?: string }).code ?? ""
  if (code === "ETIMEOUT" || code === "ECONNRESET" || code === "ECONNCLOSED" || code === "ESOCKET") return true
  return (
    msg.includes("connection is closed") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout: request failed to complete") ||
    msg.includes("the connection is closed")
  )
}

async function queryWithRetry<T>(
  host: AgentHost,
  connection: string,
  query: string,
  maxRetries = 2,
): Promise<T[]> {
  const { pool } = await getPool(host, connection)
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await pool.request().query<T>(query)
      return result.recordset
    } catch (e) {
      lastErr = e
      if (attempt === maxRetries || !isTransientCatalogDriftError(e)) throw e
      const delay = 100 * Math.pow(4, attempt) + Math.floor(Math.random() * 50)
      console.warn(`[sync.catalog] transient schema fetch failure for ${connection} (attempt ${attempt + 1}/${maxRetries + 1}): ${e instanceof Error ? e.message : String(e)}; retrying in ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}

async function fetchSchema(host: AgentHost, connection: string, schemas: readonly string[]): Promise<SchemaSnapshot> {
  if (schemas.length === 0) {
    // Defensive: an empty allowlist would generate `IN ()` (a SQL syntax
    // error). Return an empty snapshot instead — the caller's restrict
    // set will then drive every comparison to a "missing on source" issue,
    // which is the correct behaviour.
    return { tables: new Set(), cols: new Map() }
  }
  const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")
  const rows = await queryWithRetry<{
    TABLE_SCHEMA: string
    TABLE_NAME: string
    COLUMN_NAME: string
    DATA_TYPE: string
    CHARACTER_MAXIMUM_LENGTH: number | null
  }>(host, connection, `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA IN (${list})
  `)
  const tables = new Set<string>()
  const cols = new Map<string, Map<string, string>>()
  for (const row of rows) {
    const qn = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`
    tables.add(qn)
    if (!cols.has(qn)) cols.set(qn, new Map())
    const type = row.CHARACTER_MAXIMUM_LENGTH
      ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH})`
      : row.DATA_TYPE
    cols.get(qn)!.set(row.COLUMN_NAME, type)
  }
  return { tables, cols }
}

/**
 * Compare schemas. When `restrictTables` is provided (typically the recipe's
 * `tables[]` list), only those tables are checked — surfaces only issues
 * relevant to the upcoming sync.
 *
 * `allowedSchemas` bounds the INFORMATION_SCHEMA query so we don't pull
 * the entire DB. The set is derived by the caller from the active entity
 * registry (or {@link DEFAULT_MYMI_SCHEMA_ALLOWLIST} for legacy callers).
 * When `restrictTables` is set, the allowed-schemas set is automatically
 * augmented with the schema prefix of each restricted table.
 */
export async function detectCatalogDrift(
  host: AgentHost,
  source: string,
  target: string,
  restrictTables?: Iterable<string>,
  allowedSchemas: readonly string[] = DEFAULT_MYMI_SCHEMA_ALLOWLIST,
): Promise<CatalogDriftResult> {
  const restrict = restrictTables ? new Set(restrictTables) : null
  const schemaSet = new Set<string>(allowedSchemas)
  if (restrict) {
    for (const qn of restrict) {
      const ix = qn.indexOf(".")
      if (ix > 0) schemaSet.add(qn.slice(0, ix))
    }
  }
  const schemaList = [...schemaSet]
  const [src, tgt] = await Promise.all([fetchSchema(host, source, schemaList), fetchSchema(host, target, schemaList)])
  const issues: string[] = []
  const tablesToCheck = restrict ?? src.tables
  for (const t of tablesToCheck) {
    if (restrict && !restrict.has(t)) continue
    if (!src.tables.has(t)) {
      issues.push(`Missing on source: ${t}`)
      continue
    }
    if (!tgt.tables.has(t)) {
      issues.push(`Missing on target: ${t}`)
      continue
    }
    const sc = src.cols.get(t) ?? new Map<string, string>()
    const tc = tgt.cols.get(t) ?? new Map<string, string>()
    for (const [c, ty] of sc) {
      const tt = tc.get(c)
      if (!tt) issues.push(`${t}.${c}: missing on target`)
      else if (tt !== ty) issues.push(`${t}.${c}: type mismatch (source=${ty}, target=${tt})`)
    }
  }
  return { catalogCompatible: issues.length === 0, issues }
}

/**
 * Probe whether a target table has any AFTER triggers — used by the execute
 * preflight to decide whether the engine should write archive rows itself or
 * rely on existing target-side triggers (the ABI convention is the latter).
 */
export async function tableHasTriggers(host: AgentHost, connection: string, qualifiedName: string): Promise<boolean> {
  const [schema, name] = qualifiedName.split(".")
  if (!schema || !name) return false
  try {
    const rows = await queryWithRetry<{ cnt: number }>(host, connection, `
      SELECT COUNT(*) AS cnt
      FROM sys.triggers t
      JOIN sys.objects o ON o.object_id = t.parent_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = '${schema}' AND o.name = '${name}' AND t.is_disabled = 0
    `)
    return (rows[0]?.cnt ?? 0) > 0
  } catch {
    return false
  }
}

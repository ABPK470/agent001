/**
 * Catalog drift detection — compare schemas between two MSSQL connections.
 *
 * Used by:
 *   - the `compare_catalogs` agent tool (full schema comparison)
 *   - the preview preflight gate (restricted to recipe tables)
 *   - the execute preflight gate (hard refusal on drift)
 */

import { withPoolSlot } from "../adapters/mssql/pool-gate.js"
import { runQueryWithRetry } from "../domain/diff-engine/sql-helpers.js"
import { emitSyncEvent } from "../application/shell/events.js"
import { EventType } from "./enums.js"
import type { SyncTelemetryContext } from "../ports/events.js"
import { getPool, type MssqlAccessHost, type SyncEnvironmentRegistryHost, type SyncEventHost } from "../ports/index.js"

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
  "master"
])

interface SchemaSnapshot {
  tables: Set<string>
  cols: Map<string, Map<string, string>>
}

function normalizeCatalogName(name: string): string {
  return name.trim().toLowerCase()
}

function isTransientCatalogDriftError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  const code = (e as { code?: string }).code ?? ""
  if (code === "ETIMEOUT" || code === "ECONNRESET" || code === "ECONNCLOSED" || code === "ESOCKET")
    return true
  return (
    msg.includes("connection is closed") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout: request failed to complete") ||
    msg.includes("the connection is closed")
  )
}

function catalogContext(
  telemetryContext: SyncTelemetryContext | undefined,
): SyncTelemetryContext | undefined {
  if (!telemetryContext) return undefined
  return { ...telemetryContext, scope: telemetryContext.scope ?? "catalog" }
}

function eventHostFromAccess(host: MssqlAccessHost): SyncEventHost | undefined {
  const candidate = host as unknown as Partial<SyncEventHost>
  if (candidate.sync?.events) return host as unknown as SyncEventHost
  return undefined
}

async function queryWithRetry<T>(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  connection: string,
  query: string,
  label: string,
  maxRetries = 2,
  telemetryContext?: SyncTelemetryContext
): Promise<T[]> {
  const eventHost = eventHostFromAccess(host)
  const ctx = catalogContext(telemetryContext)
  if (eventHost && ctx) {
    const result = await runQueryWithRetry<T>(
      host as unknown as SyncEventHost & MssqlAccessHost & SyncEnvironmentRegistryHost,
      connection,
      query,
      label,
      maxRetries,
      ctx
    )
    return result.recordset
  }

  return withPoolSlot(host, connection, async () => {
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
        const errMsg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[sync.catalog] transient schema fetch failure for ${connection} (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg}; retrying in ${delay}ms`
        )
        if (eventHost) {
          emitSyncEvent(eventHost, EventType.SyncRetry, {
            phase: "catalog",
            connection,
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            error: errMsg,
            delayMs: delay
          })
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw lastErr
  })
}

async function fetchSchema(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  connection: string,
  schemas: readonly string[],
  telemetryContext?: SyncTelemetryContext
): Promise<SchemaSnapshot> {
  if (schemas.length === 0) {
    return { tables: new Set(), cols: new Map() }
  }
  const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")
  const rows = await queryWithRetry<{
    TABLE_SCHEMA: string
    TABLE_NAME: string
    COLUMN_NAME: string
    DATA_TYPE: string
    CHARACTER_MAXIMUM_LENGTH: number | null
  }>(
    host,
    connection,
    `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA IN (${list})
  `,
    "catalog.schema.columns",
    2,
    telemetryContext
  )
  return rowsToSnapshot(rows)
}

async function fetchSchemaForTables(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  connection: string,
  tables: readonly string[],
  telemetryContext?: SyncTelemetryContext
): Promise<SchemaSnapshot> {
  if (tables.length === 0) return { tables: new Set(), cols: new Map() }
  const literals = tables
    .map((qn) => {
      const normalized = normalizeCatalogName(qn)
      return `N'${normalized.replace(/'/g, "''")}'`
    })
    .join(", ")
  const rows = await queryWithRetry<{
    TABLE_SCHEMA: string
    TABLE_NAME: string
    COLUMN_NAME: string
    DATA_TYPE: string
    CHARACTER_MAXIMUM_LENGTH: number | null
  }>(
    host,
    connection,
    `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE LOWER(TABLE_SCHEMA + '.' + TABLE_NAME) IN (${literals})
  `,
    "catalog.tables.columns",
    2,
    telemetryContext
  )
  return rowsToSnapshot(rows)
}

function rowsToSnapshot(
  rows: Array<{
    TABLE_SCHEMA: string
    TABLE_NAME: string
    COLUMN_NAME: string
    DATA_TYPE: string
    CHARACTER_MAXIMUM_LENGTH: number | null
  }>
): SchemaSnapshot {
  const tables = new Set<string>()
  const cols = new Map<string, Map<string, string>>()
  for (const row of rows) {
    const qn = normalizeCatalogName(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`)
    tables.add(qn)
    if (!cols.has(qn)) cols.set(qn, new Map())
    const type = row.CHARACTER_MAXIMUM_LENGTH
      ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH})`
      : row.DATA_TYPE
    cols.get(qn)!.set(normalizeCatalogName(row.COLUMN_NAME), type)
  }
  return { tables, cols }
}

/** Live column names per qualified table (preserves catalog casing from sys.columns). */
export async function fetchTableColumnNamesMap(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  connection: string,
  tables: readonly string[],
  telemetryContext?: SyncTelemetryContext
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (tables.length === 0) return out
  for (const qn of tables) {
    const [schema, name] = qn.split(".")
    if (!schema || !name) {
      out.set(qn, [])
      continue
    }
    const rows = await queryWithRetry<{ name: string }>(
      host,
      connection,
      `
      SELECT c.name
      FROM sys.columns c
      WHERE c.object_id = OBJECT_ID('${schema.replace(/'/g, "''")}.${name.replace(/'/g, "''")}')
      ORDER BY c.column_id
    `,
      `catalog.columns(${qn})`,
      2,
      telemetryContext
    )
    out.set(qn, rows.map((row) => row.name))
  }
  return out
}

/**
 * Compare schemas. When `restrictTables` is provided (typically the recipe's
 * `tables[]` list), only those tables are checked — surfaces only issues
 * relevant to the upcoming sync.
 */
export async function detectCatalogDrift(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  source: string,
  target: string,
  restrictTables?: Iterable<string>,
  allowedSchemas: readonly string[] = DEFAULT_MYMI_SCHEMA_ALLOWLIST,
  telemetryContext?: SyncTelemetryContext
): Promise<CatalogDriftResult> {
  const restrict = restrictTables
    ? new Set(Array.from(restrictTables, (name) => normalizeCatalogName(name)))
    : null
  const schemaSet = new Set<string>(allowedSchemas)
  if (restrict) {
    for (const qn of restrict) {
      const ix = qn.indexOf(".")
      if (ix > 0) schemaSet.add(qn.slice(0, ix))
    }
  }
  const schemaList = [...schemaSet]
  const restrictList = restrict ? [...restrict] : null
  const ctx = catalogContext(telemetryContext)
  const loadSnapshot = (connection: string) =>
    restrictList && restrictList.length > 0
      ? fetchSchemaForTables(host, connection, restrictList, ctx)
      : fetchSchema(host, connection, schemaList, ctx)
  const [src, tgt] = await Promise.all([loadSnapshot(source), loadSnapshot(target)])
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
      const tt = tc.get(normalizeCatalogName(c))
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
export async function tableHasTriggers(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  connection: string,
  qualifiedName: string,
  telemetryContext?: SyncTelemetryContext
): Promise<boolean> {
  const [schema, name] = qualifiedName.split(".")
  if (!schema || !name) return false
  try {
    const rows = await queryWithRetry<{ cnt: number }>(
      host,
      connection,
      `
      SELECT COUNT(*) AS cnt
      FROM sys.triggers t
      JOIN sys.objects o ON o.object_id = t.parent_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = '${schema}' AND o.name = '${name}' AND t.is_disabled = 0
    `,
      `catalog.triggers(${qualifiedName})`,
      2,
      telemetryContext
    )
    return (rows[0]?.cnt ?? 0) > 0
  } catch {
    return false
  }
}

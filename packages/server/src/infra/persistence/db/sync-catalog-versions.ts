import { getDb } from "../connection.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncCatalogVersion {
  tenant_id: string
  version: number
  snapshot_json: string
  reason: string
  created_by: string
  created_at: string
}

export interface SyncCatalogVersionSummary {
  tenantId: string
  version: number
  reason: string
  createdBy: string
  createdAt: string
  isActive: boolean
}

export function getActiveSyncCatalogVersion(tenantId = DEFAULT_TENANT): number | null {
  const row = getDb()
    .prepare("SELECT version FROM sync_catalog_active WHERE tenant_id = ?")
    .get(tenantId) as { version: number } | undefined
  return row?.version ?? null
}

export function getSyncCatalogVersionRow(
  tenantId: string,
  version: number,
): DbSyncCatalogVersion | undefined {
  return getDb()
    .prepare(
      "SELECT tenant_id, version, snapshot_json, reason, created_by, created_at FROM sync_catalog_versions WHERE tenant_id = ? AND version = ?",
    )
    .get(tenantId, version) as DbSyncCatalogVersion | undefined
}

export function listSyncCatalogVersionSummaries(
  tenantId = DEFAULT_TENANT,
  limit = 50,
): SyncCatalogVersionSummary[] {
  const active = getActiveSyncCatalogVersion(tenantId)
  const rows = getDb()
    .prepare(
      `SELECT tenant_id, version, reason, created_by, created_at
       FROM sync_catalog_versions
       WHERE tenant_id = ?
       ORDER BY version DESC
       LIMIT ?`,
    )
    .all(tenantId, limit) as Array<
    Pick<DbSyncCatalogVersion, "tenant_id" | "version" | "reason" | "created_by" | "created_at">
  >

  return rows.map((row) => ({
    tenantId: row.tenant_id,
    version: row.version,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    isActive: row.version === active,
  }))
}

export function appendSyncCatalogVersion(args: {
  tenantId?: string
  snapshotJson: string
  reason: string
  actor: string
}): number {
  const tenantId = args.tenantId ?? DEFAULT_TENANT
  const createdAt = new Date().toISOString()

  return getDb().transaction(() => {
    const maxRow = getDb()
      .prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM sync_catalog_versions WHERE tenant_id = ?")
      .get(tenantId) as { max_version: number }
    const nextVersion = maxRow.max_version + 1

    getDb()
      .prepare(
        `INSERT INTO sync_catalog_versions (tenant_id, version, snapshot_json, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tenantId, nextVersion, args.snapshotJson, args.reason, args.actor, createdAt)

    getDb()
      .prepare(
        `INSERT INTO sync_catalog_active (tenant_id, version, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(tenantId, nextVersion, createdAt)

    return nextVersion
  })()
}

export function countSyncCatalogVersions(tenantId = DEFAULT_TENANT): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM sync_catalog_versions WHERE tenant_id = ?")
    .get(tenantId) as { count: number }
  return row.count
}

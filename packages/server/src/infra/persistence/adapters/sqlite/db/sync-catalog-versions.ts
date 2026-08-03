import { sql } from "kysely"
import { getPlatformStore } from "../platform-store.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"
import { upsertRow } from "../../../schema/upsert.js"

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
  const compiled = getPlatformDb()
    .selectFrom("sync_catalog_active")
    .select("version")
    .where("tenant_id", "=", tenantId)
    .compile()
  const row = runGet<{ version: number }>(compiled)
  return row?.version ?? null
}

export function getSyncCatalogVersionRow(
  tenantId: string,
  version: number,
): DbSyncCatalogVersion | undefined {
  const compiled = getPlatformDb()
    .selectFrom("sync_catalog_versions")
    .select(["tenant_id", "version", "snapshot_json", "reason", "created_by", "created_at"])
    .where("tenant_id", "=", tenantId)
    .where("version", "=", version)
    .compile()
  return runGet<DbSyncCatalogVersion>(compiled)
}

export function listSyncCatalogVersionSummaries(
  tenantId = DEFAULT_TENANT,
  limit = 50,
): SyncCatalogVersionSummary[] {
  const active = getActiveSyncCatalogVersion(tenantId)
  const compiled = getPlatformDb()
    .selectFrom("sync_catalog_versions")
    .select(["tenant_id", "version", "reason", "created_by", "created_at"])
    .where("tenant_id", "=", tenantId)
    .orderBy("version", "desc")
    .limit(limit)
    .compile()
  const rows = runAll<
    Pick<DbSyncCatalogVersion, "tenant_id" | "version" | "reason" | "created_by" | "created_at">
  >(compiled)

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

  return getPlatformStore().transaction(() => {
    const maxCompiled = getPlatformDb()
      .selectFrom("sync_catalog_versions")
      .select(sql<number>`coalesce(max(version), 0)`.as("max_version"))
      .where("tenant_id", "=", tenantId)
      .compile()
    const maxRow = runGet<{ max_version: number | bigint }>(maxCompiled)
    const nextVersion = Number(maxRow?.max_version ?? 0) + 1

    const insertVersion = getPlatformDb()
      .insertInto("sync_catalog_versions")
      .values({
        tenant_id: tenantId,
        version: nextVersion,
        snapshot_json: args.snapshotJson,
        reason: args.reason,
        created_by: args.actor,
        created_at: createdAt,
      })
      .compile()
    runExec(insertVersion)

    upsertRow({
      table: "sync_catalog_active",
      keys: { tenant_id: tenantId },
      insert: {
        tenant_id: tenantId,
        version: nextVersion,
        updated_at: createdAt,
      },
      update: {
        version: nextVersion,
        updated_at: createdAt,
      },
    })

    return nextVersion
  })
}

export function countSyncCatalogVersions(tenantId = DEFAULT_TENANT): number {
  const compiled = getPlatformDb()
    .selectFrom("sync_catalog_versions")
    .select(sql<number>`count(*)`.as("count"))
    .where("tenant_id", "=", tenantId)
    .compile()
  const row = runGet<{ count: number | bigint }>(compiled)
  return Number(row?.count ?? 0)
}

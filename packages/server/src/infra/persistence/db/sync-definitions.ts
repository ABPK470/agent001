import { getDb } from "../connection.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncPublishMeta {
  tenant_id: string
  published_at: string
  published_version: string
  catalog_version: number | null
}

export interface DbSyncDefinitionRow {
  tenant_id: string
  entity_id: string
  definition_json: string
  published_at: string | null
  published_version: string | null
}

export interface PublishedBundleFromDb {
  version: 1
  publishedAt: string
  publishedVersion: string
  catalogVersion: number | null
  definitions: Record<string, object>
}

export function getSyncPublishMeta(tenantId = DEFAULT_TENANT): DbSyncPublishMeta | null {
  return (
    (getDb()
      .prepare(
        `SELECT tenant_id, published_at, published_version, catalog_version
         FROM sync_publish_meta WHERE tenant_id = ?`,
      )
      .get(tenantId) as DbSyncPublishMeta | undefined) ?? null
  )
}

export function saveSyncPublishMeta(row: {
  tenant_id: string
  published_at: string
  published_version: string
  catalog_version: number | null
}): void {
  getDb()
    .prepare(
      `INSERT INTO sync_publish_meta (tenant_id, published_at, published_version, catalog_version)
       VALUES (@tenant_id, @published_at, @published_version, @catalog_version)
       ON CONFLICT(tenant_id) DO UPDATE SET
         published_at = excluded.published_at,
         published_version = excluded.published_version,
         catalog_version = excluded.catalog_version`,
    )
    .run(row)
}

export function listSyncDefinitions(tenantId = DEFAULT_TENANT): DbSyncDefinitionRow[] {
  return getDb()
    .prepare(
      `SELECT tenant_id, entity_id, definition_json, published_at, published_version
       FROM sync_definitions WHERE tenant_id = ? ORDER BY entity_id`,
    )
    .all(tenantId) as DbSyncDefinitionRow[]
}

export function getSyncDefinition(
  tenantId: string,
  entityId: string,
): DbSyncDefinitionRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT tenant_id, entity_id, definition_json, published_at, published_version
         FROM sync_definitions WHERE tenant_id = ? AND entity_id = ?`,
      )
      .get(tenantId, entityId) as DbSyncDefinitionRow | undefined) ?? null
  )
}

/**
 * Replace live published SyncDefinitions for a tenant.
 * Clears existing rows, upserts non-null definitions, and retains the previous
 * row when a compile failure yields null (so prior published defs stay live).
 */
export function replaceSyncDefinitions(
  tenantId: string,
  input: {
    publishedAt: string
    publishedVersion: string
    catalogVersion: number | null
    definitions: Record<string, object | null>
  },
): void {
  const db = getDb()
  db.transaction(() => {
    const previous = new Map(
      listSyncDefinitions(tenantId).map((row) => [row.entity_id, row] as const),
    )

    db.prepare(`DELETE FROM sync_definitions WHERE tenant_id = ?`).run(tenantId)

    const insert = db.prepare(
      `INSERT INTO sync_definitions
         (tenant_id, entity_id, definition_json, published_at, published_version)
       VALUES (?, ?, ?, ?, ?)`,
    )

    for (const [entityId, definition] of Object.entries(input.definitions)) {
      if (definition != null) {
        insert.run(
          tenantId,
          entityId,
          JSON.stringify(definition),
          input.publishedAt,
          input.publishedVersion,
        )
        continue
      }
      const kept = previous.get(entityId)
      if (!kept) continue
      insert.run(
        tenantId,
        entityId,
        kept.definition_json,
        kept.published_at,
        kept.published_version,
      )
    }

    saveSyncPublishMeta({
      tenant_id: tenantId,
      published_at: input.publishedAt,
      published_version: input.publishedVersion,
      catalog_version: input.catalogVersion,
    })
  })()
}

/** Load the published SyncDefinition bundle shape from SQLite (replaces file bundle). */
export function loadPublishedBundleFromDb(
  tenantId = DEFAULT_TENANT,
): PublishedBundleFromDb | null {
  const meta = getSyncPublishMeta(tenantId)
  if (!meta) return null

  const definitions: Record<string, object> = {}
  for (const row of listSyncDefinitions(tenantId)) {
    definitions[row.entity_id] = JSON.parse(row.definition_json) as object
  }

  return {
    version: 1,
    publishedAt: meta.published_at,
    publishedVersion: meta.published_version,
    catalogVersion: meta.catalog_version,
    definitions,
  }
}

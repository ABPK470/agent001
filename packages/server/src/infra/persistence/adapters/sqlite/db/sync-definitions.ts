import { getPlatformStore } from "../platform-store.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"
import { upsertRow } from "../../../schema/upsert.js"

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
  const compiled = getPlatformDb()
    .selectFrom("sync_publish_meta")
    .select(["tenant_id", "published_at", "published_version", "catalog_version"])
    .where("tenant_id", "=", tenantId)
    .compile()
  return runGet<DbSyncPublishMeta>(compiled) ?? null
}

export function saveSyncPublishMeta(row: {
  tenant_id: string
  published_at: string
  published_version: string
  catalog_version: number | null
}): void {
  upsertRow({
    table: "sync_publish_meta",
    keys: { tenant_id: row.tenant_id },
    insert: row,
    update: {
      published_at: row.published_at,
      published_version: row.published_version,
      catalog_version: row.catalog_version,
    },
  })
}

export function listSyncDefinitions(tenantId = DEFAULT_TENANT): DbSyncDefinitionRow[] {
  const compiled = getPlatformDb()
    .selectFrom("sync_definitions")
    .select(["tenant_id", "entity_id", "definition_json", "published_at", "published_version"])
    .where("tenant_id", "=", tenantId)
    .orderBy("entity_id")
    .compile()
  return runAll<DbSyncDefinitionRow>(compiled)
}

export function getSyncDefinition(
  tenantId: string,
  entityId: string,
): DbSyncDefinitionRow | null {
  const compiled = getPlatformDb()
    .selectFrom("sync_definitions")
    .select(["tenant_id", "entity_id", "definition_json", "published_at", "published_version"])
    .where("tenant_id", "=", tenantId)
    .where("entity_id", "=", entityId)
    .compile()
  return runGet<DbSyncDefinitionRow>(compiled) ?? null
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
  getPlatformStore().transaction(() => {
    const previous = new Map(
      listSyncDefinitions(tenantId).map((row) => [row.entity_id, row] as const),
    )

    const del = getPlatformDb()
      .deleteFrom("sync_definitions")
      .where("tenant_id", "=", tenantId)
      .compile()
    runExec(del)

    for (const [entityId, definition] of Object.entries(input.definitions)) {
      if (definition != null) {
        const ins = getPlatformDb()
          .insertInto("sync_definitions")
          .values({
            tenant_id: tenantId,
            entity_id: entityId,
            definition_json: JSON.stringify(definition),
            published_at: input.publishedAt,
            published_version: input.publishedVersion,
          })
          .compile()
        runExec(ins)
        continue
      }
      const kept = previous.get(entityId)
      if (!kept) continue
      const ins = getPlatformDb()
        .insertInto("sync_definitions")
        .values({
          tenant_id: tenantId,
          entity_id: entityId,
          definition_json: kept.definition_json,
          published_at: kept.published_at,
          published_version: kept.published_version,
        })
        .compile()
      runExec(ins)
    }

    saveSyncPublishMeta({
      tenant_id: tenantId,
      published_at: input.publishedAt,
      published_version: input.publishedVersion,
      catalog_version: input.catalogVersion,
    })
  })
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

export function clearSyncDefinitionsAndPublishMeta(): void {
  getPlatformStore().transaction(() => {
    runExec(getPlatformDb().deleteFrom("sync_definitions").where("tenant_id", "is not", null).compile())
    runExec(getPlatformDb().deleteFrom("sync_publish_meta").where("tenant_id", "is not", null).compile())
  })
}

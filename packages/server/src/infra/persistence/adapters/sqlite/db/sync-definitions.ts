import { getPlatformStore } from "../platform-store.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { upsertRowAsync } from "../../../schema/upsert.js"

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

export async function getSyncPublishMeta(tenantId = DEFAULT_TENANT): Promise<DbSyncPublishMeta | null> {
  const compiled = getPlatformDb()
    .selectFrom("sync_publish_meta")
    .select(["tenant_id", "published_at", "published_version", "catalog_version"])
    .where("tenant_id", "=", tenantId)
    .compile()
  return await runGetAsync<DbSyncPublishMeta>(compiled) ?? null
}

export async function saveSyncPublishMeta(row: {
  tenant_id: string
  published_at: string
  published_version: string
  catalog_version: number | null
}): Promise<void> {
  await upsertRowAsync({
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

export async function listSyncDefinitions(tenantId = DEFAULT_TENANT): Promise<DbSyncDefinitionRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_definitions")
    .select(["tenant_id", "entity_id", "definition_json", "published_at", "published_version"])
    .where("tenant_id", "=", tenantId)
    .orderBy("entity_id")
    .compile()
  return await runAllAsync<DbSyncDefinitionRow>(compiled)
}

export async function getSyncDefinition(
  tenantId: string,
  entityId: string,
): Promise<DbSyncDefinitionRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("sync_definitions")
    .select(["tenant_id", "entity_id", "definition_json", "published_at", "published_version"])
    .where("tenant_id", "=", tenantId)
    .where("entity_id", "=", entityId)
    .compile()
  return await runGetAsync<DbSyncDefinitionRow>(compiled) ?? null
}

/**
 * Replace live published SyncDefinitions for a tenant.
 * Clears existing rows, upserts non-null definitions, and retains the previous
 * row when a compile failure yields null (so prior published defs stay live).
 */
export async function replaceSyncDefinitions(
  tenantId: string,
  input: {
    publishedAt: string
    publishedVersion: string
    catalogVersion: number | null
    definitions: Record<string, object | null>
  },
): Promise<void> {
  await getPlatformStore().transactionAsync(async () => {
    const previous = new Map(
      (await listSyncDefinitions(tenantId)).map((row) => [row.entity_id, row] as const),
    )

    const del = getPlatformDb()
      .deleteFrom("sync_definitions")
      .where("tenant_id", "=", tenantId)
      .compile()
    await runExecAsync(del)

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
        await runExecAsync(ins)
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
      await runExecAsync(ins)
    }

    await saveSyncPublishMeta({
      tenant_id: tenantId,
      published_at: input.publishedAt,
      published_version: input.publishedVersion,
      catalog_version: input.catalogVersion,
    })
  })
}

/** Load the published SyncDefinition bundle shape from SQLite (replaces file bundle). */
export async function loadPublishedBundleFromDb(
  tenantId = DEFAULT_TENANT,
): Promise<PublishedBundleFromDb | null> {
  const meta = await getSyncPublishMeta(tenantId)
  if (!meta) return null

  const definitions: Record<string, object> = {}
  for (const row of await listSyncDefinitions(tenantId)) {
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

export async function clearSyncDefinitionsAndPublishMeta(): Promise<void> {
  await getPlatformStore().transactionAsync(async () => {
    await runExecAsync(getPlatformDb().deleteFrom("sync_definitions").where("tenant_id", "is not", null).compile())
    await runExecAsync(getPlatformDb().deleteFrom("sync_publish_meta").where("tenant_id", "is not", null).compile())
  })
}

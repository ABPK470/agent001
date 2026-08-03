import {
  parseCustomValueSourceDefinition,
  type CustomValueSourceDefinition,
} from "@mia/shared-types"

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync } from "../../../schema/execute-async.js"
import { upsertRowAsync } from "../../../schema/upsert.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncValueSource {
  tenant_id: string
  id: string
  label: string
  built_in: number
  definition_json: string
}

export async function listSyncValueSources(tenantId = DEFAULT_TENANT): Promise<DbSyncValueSource[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_value_sources")
    .select(["tenant_id", "id", "label", "built_in", "definition_json"])
    .where("tenant_id", "=", tenantId)
    .orderBy("id")
    .compile()
  return await runAllAsync<DbSyncValueSource>(compiled)
}

export async function saveSyncValueSource(
  row: Omit<DbSyncValueSource, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): Promise<void> {
  const definition =
    row.definition_json ??
    JSON.stringify(parseCustomValueSourceDefinition("{}", row.id))
  const builtIn = row.built_in ?? 0
  await upsertRowAsync({
    table: "sync_value_sources",
    keys: { tenant_id: row.tenant_id, id: row.id },
    insert: {
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: builtIn,
      definition_json: definition,
    },
    update: {
      label: row.label,
      definition_json: definition,
    },
  })
}

export async function deleteSyncValueSource(tenantId: string, id: string): Promise<boolean> {
  const compiled = getPlatformDb()
    .deleteFrom("sync_value_sources")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return await runChangesAsync(compiled) > 0
}

export function mapValueSourceDefinition(
  row: Pick<DbSyncValueSource, "id" | "definition_json">,
): CustomValueSourceDefinition {
  return parseCustomValueSourceDefinition(JSON.parse(row.definition_json), row.id)
}

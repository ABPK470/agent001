import {
  parseCustomValueSourceDefinition,
  type CustomValueSourceDefinition,
} from "@mia/shared-types"

import { getDb } from "../connection.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncValueSource {
  tenant_id: string
  id: string
  label: string
  built_in: number
  definition_json: string
}

export function listSyncValueSources(tenantId = DEFAULT_TENANT): DbSyncValueSource[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, built_in, definition_json FROM sync_value_sources WHERE tenant_id = ? ORDER BY id",
    )
    .all(tenantId) as DbSyncValueSource[]
}

export function saveSyncValueSource(
  row: Omit<DbSyncValueSource, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ??
    JSON.stringify(parseCustomValueSourceDefinition("{}", row.id))
  getDb()
    .prepare(
      `INSERT INTO sync_value_sources (tenant_id, id, label, built_in, definition_json)
       VALUES (@tenant_id, @id, @label, @built_in, @definition_json)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         definition_json = excluded.definition_json`,
    )
    .run({ ...row, built_in: row.built_in ?? 0, definition_json: definition })
}

export function deleteSyncValueSource(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_value_sources WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function mapValueSourceDefinition(
  row: Pick<DbSyncValueSource, "id" | "definition_json">,
): CustomValueSourceDefinition {
  return parseCustomValueSourceDefinition(JSON.parse(row.definition_json), row.id)
}

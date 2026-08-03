import {
  parseCustomValueSourceDefinition,
  type CustomValueSourceDefinition,
} from "@mia/shared-types"

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runChanges, runExec } from "../../../schema/execute.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncValueSource {
  tenant_id: string
  id: string
  label: string
  built_in: number
  definition_json: string
}

export function listSyncValueSources(tenantId = DEFAULT_TENANT): DbSyncValueSource[] {
  const compiled = getPlatformDb()
    .selectFrom("sync_value_sources")
    .select(["tenant_id", "id", "label", "built_in", "definition_json"])
    .where("tenant_id", "=", tenantId)
    .orderBy("id")
    .compile()
  return runAll<DbSyncValueSource>(compiled)
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
  const builtIn = row.built_in ?? 0
  const compiled = getPlatformDb()
    .insertInto("sync_value_sources")
    .values({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: builtIn,
      definition_json: definition,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "id"]).doUpdateSet({
        label: row.label,
        definition_json: definition,
      }),
    )
    .compile()
  runExec(compiled)
}

export function deleteSyncValueSource(tenantId: string, id: string): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("sync_value_sources")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return runChanges(compiled) > 0
}

export function mapValueSourceDefinition(
  row: Pick<DbSyncValueSource, "id" | "definition_json">,
): CustomValueSourceDefinition {
  return parseCustomValueSourceDefinition(JSON.parse(row.definition_json), row.id)
}

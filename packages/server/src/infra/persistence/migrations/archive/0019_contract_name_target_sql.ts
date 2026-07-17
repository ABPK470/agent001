import type Database from "better-sqlite3"

import { CONTRACT_NAME_TARGET_SQL } from "@mia/shared-types"

function migrateContractNameResolver(definitionJson: string): string | null {
  let parsed: { description?: string; resolver?: { kind?: string } }
  try {
    parsed = JSON.parse(definitionJson) as { description?: string; resolver?: { kind?: string } }
  } catch {
    return null
  }
  if (parsed.resolver?.kind !== "contract-name") return null
  return JSON.stringify({
    description:
      parsed.description?.trim() ||
      "Contract name on target after metadata sync (core.Contract.name for plan entity id).",
    resolver: { kind: "target-sql", ...CONTRACT_NAME_TARGET_SQL },
  })
}

export function runContractNameTargetSqlMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT tenant_id, id, definition_json FROM sync_run_binding_sources WHERE definition_json LIKE '%"kind":"contract-name"%'`,
    )
    .all() as Array<{ tenant_id: string; id: string; definition_json: string }>

  const update = db.prepare(
    `UPDATE sync_run_binding_sources SET definition_json = ? WHERE tenant_id = ? AND id = ?`,
  )

  for (const row of rows) {
    const migrated = migrateContractNameResolver(row.definition_json)
    if (migrated) update.run(migrated, row.tenant_id, row.id)
  }
}

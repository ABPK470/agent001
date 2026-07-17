import type Database from "better-sqlite3"

import { normalizeTargetSqlResolver } from "@mia/shared-types"

type TargetSqlResolver = {
  kind: "target-sql"
  query: string
  resultColumn: string
  resultType?: "string" | "number"
}

export function runNormalizeTargetSqlBindingSourcesMigration(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT tenant_id, id, definition_json FROM sync_run_binding_sources`)
    .all() as Array<{ tenant_id: string; id: string; definition_json: string }>

  const update = db.prepare(
    `UPDATE sync_run_binding_sources SET definition_json = ? WHERE tenant_id = ? AND id = ?`,
  )

  for (const row of rows) {
    let parsed: { description?: string; resolver?: { kind?: string } }
    try {
      parsed = JSON.parse(row.definition_json) as { description?: string; resolver?: { kind?: string } }
    } catch {
      continue
    }
    if (parsed.resolver?.kind !== "target-sql") continue
    const normalized = normalizeTargetSqlResolver(parsed.resolver as TargetSqlResolver)
    update.run(
      JSON.stringify({ description: parsed.description ?? "", resolver: normalized }),
      row.tenant_id,
      row.id,
    )
  }
}

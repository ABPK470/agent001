/**
 * Normalize SCD2 excludeFromDiff column names to match live MSSQL schema
 * (syncDate, deployDate — not kebab-case catalog ids).
 */

import type Database from "better-sqlite3"

const KEBAB_TO_CAMEL: Readonly<Record<string, string>> = {
  "sync-date": "syncDate",
  "deploy-date": "deployDate",
}

function fixExcludeFromDiff(columns: unknown): string[] | undefined {
  if (!Array.isArray(columns)) return undefined
  let changed = false
  const out = columns.map((col) => {
    if (typeof col !== "string") return col
    const fixed = KEBAB_TO_CAMEL[col] ?? col
    if (fixed !== col) changed = true
    return fixed
  })
  return changed ? out : undefined
}

function fixStrategyBody(bodyJson: string): string | null {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(bodyJson) as Record<string, unknown>
  } catch {
    return null
  }

  const fixedExclude = fixExcludeFromDiff(body.excludeFromDiff)
  if (!fixedExclude) return null

  return JSON.stringify({ ...body, excludeFromDiff: fixedExclude })
}

export function runScd2ColumnCamelcaseMigration(db: Database.Database): void {
  const pointers = db
    .prepare(
      `SELECT tenant_id, id, current_version
       FROM scd2_strategies
       WHERE current_version IS NOT NULL`,
    )
    .all() as Array<{ tenant_id: string; id: string; current_version: number }>

  const loadVersion = db.prepare(
    `SELECT body_json FROM scd2_strategy_versions
     WHERE tenant_id = ? AND id = ? AND version = ?`,
  )
  const insertVersion = db.prepare(
    `INSERT INTO scd2_strategy_versions
       (tenant_id, id, version, body_json, created_by, created_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const bumpPointer = db.prepare(
    `UPDATE scd2_strategies SET current_version = ? WHERE tenant_id = ? AND id = ?`,
  )

  const now = new Date().toISOString()

  for (const pointer of pointers) {
    const row = loadVersion.get(pointer.tenant_id, pointer.id, pointer.current_version) as
      | { body_json: string }
      | undefined
    if (!row) continue

    const fixedJson = fixStrategyBody(row.body_json)
    if (!fixedJson) continue

    const nextVersion = pointer.current_version + 1
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(fixedJson) as Record<string, unknown>
    } catch {
      continue
    }

    insertVersion.run(
      pointer.tenant_id,
      pointer.id,
      nextVersion,
      fixedJson,
      typeof parsed.createdBy === "string" ? parsed.createdBy : "system",
      typeof parsed.createdAt === "string" ? parsed.createdAt : now,
      "scd2 column names: syncDate/deployDate",
    )
    bumpPointer.run(nextVersion, pointer.tenant_id, pointer.id)
  }
}

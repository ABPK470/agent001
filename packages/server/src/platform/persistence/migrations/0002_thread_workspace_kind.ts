/**
 * Upgrade pre-kind threads schema: add `kind`, migrate legacy "Platform"
 * title rows, ensure one workspace thread per user, replace title-based index.
 */

import type Database from "better-sqlite3"
import { randomUUID } from "node:crypto"
import { ThreadKind } from "../../../shared/enums/thread.js"

export function runThreadWorkspaceKindMigration(db: Database.Database): void {
  const columns = db.pragma("table_info(threads)") as Array<{ name: string }>
  if (!columns.some((c) => c.name === "kind")) {
    db.exec(
      `ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT '${ThreadKind.Conversation}'`
    )
  }

  const legacyUsers = db
    .prepare(
      `
      SELECT DISTINCT upn FROM threads
      WHERE title = 'Platform' AND archived_at IS NULL
    `
    )
    .all() as Array<{ upn: string }>

  const promote = db.prepare(`UPDATE threads SET kind = ? WHERE id = ?`)
  const archive = db.prepare(`UPDATE threads SET archived_at = datetime('now') WHERE id = ?`)

  for (const { upn } of legacyUsers) {
    const rows = db
      .prepare(
        `
        SELECT id FROM threads
        WHERE upn = ? AND title = 'Platform' AND archived_at IS NULL
        ORDER BY updated_at DESC
      `
      )
      .all(upn) as Array<{ id: string }>
    if (rows.length === 0) continue
    promote.run(ThreadKind.Workspace, rows[0]!.id)
    for (let i = 1; i < rows.length; i++) {
      archive.run(rows[i]!.id)
    }
  }

  const users = db.prepare("SELECT upn FROM users").all() as Array<{ upn: string }>
  const hasWorkspace = db.prepare(
    `
    SELECT id FROM threads
    WHERE upn = ? AND kind = ? AND archived_at IS NULL
    LIMIT 1
  `
  )
  const insertWorkspace = db.prepare(
    `
    INSERT INTO threads (id, upn, title, kind, created_at, updated_at, archived_at, pinned)
    VALUES (@id, @upn, @title, @kind, @created_at, @updated_at, NULL, 0)
  `
  )

  const now = new Date().toISOString()
  for (const { upn } of users) {
    if (hasWorkspace.get(upn, ThreadKind.Workspace)) continue
    insertWorkspace.run({
      id: randomUUID(),
      upn,
      title: "New thread",
      kind: ThreadKind.Workspace,
      created_at: now,
      updated_at: now
    })
  }

  db.exec("DROP INDEX IF EXISTS idx_threads_platform_per_user")
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_workspace_per_user
      ON threads(upn) WHERE kind = 'workspace' AND archived_at IS NULL
  `)
}

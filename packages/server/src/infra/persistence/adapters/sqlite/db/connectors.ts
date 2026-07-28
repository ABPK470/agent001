/**
 * Connector persistence — CRUD over the `connectors` SQLite table.
 *
 * `body_json` holds the full `Connector` record (kind, name, displayName,
 * config, enabled). Secret config fields are stored in plaintext (admin-only
 * API; see `shared-types/connectors.ts` for the threat-model note). Reads
 * return the raw row; masking happens in the transport layer.
 */

import { getDb } from "../connection.js"

export interface DbConnector {
  id: string
  kind: string
  body_json: string
  enabled: number
  created_at: string
  updated_at: string
  updated_by: string | null
}

export function listConnectors(): DbConnector[] {
  return getDb().prepare("SELECT * FROM connectors ORDER BY id").all() as DbConnector[]
}

export function getConnector(id: string): DbConnector | undefined {
  return getDb().prepare("SELECT * FROM connectors WHERE id = ?").get(id) as
    | DbConnector
    | undefined
}

export function saveConnector(row: DbConnector): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO connectors (id, kind, body_json, enabled, created_at, updated_at, updated_by)
    VALUES (@id, @kind, @body_json, @enabled, COALESCE((SELECT created_at FROM connectors WHERE id = @id), @created_at), @updated_at, @updated_by)
  `,
    )
    .run(row)
}

export function deleteConnector(id: string): void {
  getDb().prepare("DELETE FROM connectors WHERE id = ?").run(id)
}

export function countConnectors(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM connectors").get() as { count: number }
  return row.count
}

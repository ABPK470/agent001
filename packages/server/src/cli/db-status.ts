/**
 * Print applied / pending database migrations.
 * Usage: npm run db:status
 */

import { getDb, getDbPath } from "../platform/persistence/db/connection.js"
import { listMigrations } from "../platform/persistence/migrations/index.js"

const db = getDb()
const rows = listMigrations(db)

console.log(`Database: ${getDbPath()}\n`)
for (const row of rows) {
  const status = row.applied_at ? `applied ${row.applied_at}` : "pending"
  console.log(`  ${String(row.version).padStart(4, "0")}  ${row.name.padEnd(24)}  ${status}`)
}

const pending = rows.filter((r) => !r.applied_at).length
if (pending > 0) {
  console.log(`\n${pending} pending migration(s) — start the server to apply.`)
} else {
  console.log("\nSchema is up to date.")
}

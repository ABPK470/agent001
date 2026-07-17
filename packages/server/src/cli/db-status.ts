/**
 * Print applied / pending database migrations.
 * Usage: npm run db:status
 */

import "../boot/load-env.js"
import { getDbPath, openDatabase } from "../infra/persistence/connection.js"
import { listMigrations } from "../infra/persistence/migrations/index.js"

const db = openDatabase()
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

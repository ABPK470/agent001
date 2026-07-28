/**
 * Durable-state adapter door for the server package.
 *
 * Open the DB at boot via `adapters/sqlite` (`openDatabase`). Product code uses
 * repository functions from `./sqlite.js` — never `getDb` / better-sqlite3.
 */

export { runDatabaseMaintenance } from "./startup.js"
export * from "./attachments.js"
export * from "./evidence.js"
export * from "./memory.js"
export * from "./sqlite.js"
export * from "./tool-cache.js"

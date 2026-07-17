/**
 * Durable-state adapter door for the server package.
 *
 * Connection lifecycle: {@link openDatabase} at boot → domain code uses {@link getDb}.
 */

export { getDb, getDbPath, openDatabase, _migrate, _setDb } from "./connection.js"
export { runDatabaseMaintenance } from "./startup.js"
export * from "./attachments.js"
export * from "./evidence.js"
export * from "./memory.js"
export * from "./sqlite.js"
export * from "./tool-cache.js"

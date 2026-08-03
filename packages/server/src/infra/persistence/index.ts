/**
 * Durable-state adapter door for the server package.
 *
 * Open the store at boot via {@link openConfiguredPlatformStore}. Product code
 * uses repository functions from `./sqlite.js` — never `getDb` / better-sqlite3.
 */

export { runDatabaseMaintenance } from "./startup.js"
export {
  assertPlatformStoreReady,
  getPlatformStore,
} from "./platform-store.js"
export { openConfiguredPlatformStore, closeOpenedPlatformStore } from "./open-platform-store.js"
export { resolvePlatformStoreKind } from "./platform-store-config.js"
export * from "./attachments.js"
export * from "./evidence.js"
export * from "./memory.js"
export * from "./sqlite.js"
export * from "./tool-cache.js"

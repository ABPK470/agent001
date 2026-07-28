/**
 * SQLite platform-store adapter — connection + repositories.
 * Public product code imports repo functions via `infra/persistence/sqlite.js` (no getDb).
 * Tests / boot may import getDb / _setDb / openDatabase from here.
 */

export {
  _migrate,
  _setDb,
  getDb,
  getDbPath,
  openDatabase,
} from "./connection.js"

export * from "./db/index.js"
export { getPlatformStore } from "./platform-store.js"

/**
 * PlatformStore — thin SQLite facade for transactional multi-statement work.
 * Event durability is {@link getEventStore}; domain data uses repository functions.
 */

import type { PlatformStore } from "../../../../ports/platform-store.js"
import { getDb } from "./connection.js"

const store: PlatformStore = {
  transaction<T>(fn: () => T): T {
    return getDb().transaction(fn)()
  },
}

export function getPlatformStore(): PlatformStore {
  return store
}

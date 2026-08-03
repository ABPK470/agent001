/**
 * PlatformStore — thin SQLite facade for transactional multi-statement work.
 * Event durability is {@link getEventStore}; domain data uses repository functions.
 */

import type { PlatformStore } from "../../../../ports/platform-store.js"
import { getDb } from "./connection.js"

const store: PlatformStore = {
  kind: "sqlite",

  transaction<T>(fn: () => T): T {
    return getDb().transaction(fn)()
  },

  async transactionAsync<T>(fn: () => Promise<T> | T): Promise<T> {
    const out = fn()
    if (out instanceof Promise) {
      // better-sqlite3 has no async transactions. Async bodies run without an
      // atomic TX until a server-RDBMS adapter lands — sync callbacks preferred.
      return out
    }
    return store.transaction(() => out)
  },
}

export function getPlatformStore(): PlatformStore {
  return store
}

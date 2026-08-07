/**
 * PlatformStore — thin SQLite facade for transactional multi-statement work.
 * Event durability is {@link getEventStore}; domain data uses repository functions.
 *
 * Async transactions use BEGIN IMMEDIATE + a process mutex so awaited
 * repo calls inside transactionAsync stay atomic on the single connection.
 */

import type { PlatformStore } from "../../../../ports/platform-store.js"
import { getDb } from "./connection.js"

let txChain: Promise<unknown> = Promise.resolve()
/** Nesting depth for the active async transaction (same connection / mutex turn). */
let txDepth = 0

const store: PlatformStore = {
  kind: "sqlite",

  transaction<T>(fn: () => T): T {
    return getDb().transaction(fn)()
  },

  async transactionAsync<T>(fn: () => Promise<T> | T): Promise<T> {
    // Nested callers (e.g. applyDeploy → saveEntityDefinition) must join the
    // open transaction. Queuing on txChain again deadlocks the mutex.
    if (txDepth > 0) {
      txDepth++
      try {
        return await fn()
      } finally {
        txDepth--
      }
    }

    const run = async (): Promise<T> => {
      const db = getDb()
      db.exec("BEGIN IMMEDIATE")
      txDepth = 1
      try {
        const out = await fn()
        db.exec("COMMIT")
        return out
      } catch (err) {
        try {
          db.exec("ROLLBACK")
        } catch {
          // Connection may already be closed during teardown.
        }
        throw err
      } finally {
        txDepth = 0
      }
    }
    const next = txChain.then(run, run)
    txChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  },
}

export function getPlatformStore(): PlatformStore {
  return store
}

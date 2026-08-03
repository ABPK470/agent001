/**
 * PlatformStore — transactional access to Mia’s product durability store.
 *
 * Repositories remain the dialect for reads/writes; this port covers
 * multi-statement transactions. Events go through {@link EventStore}.
 *
 * RDBMS is pluggable (`sqlite | mssql | postgres`). Target contract is async;
 * the SQLite adapter keeps a sync {@link PlatformStore.transaction} bridge
 * during cutover so existing call sites stay green.
 */

import type { RelationalDialectKind } from "@mia/sql-kit"

export type PlatformStoreKind = RelationalDialectKind

export interface PlatformStore {
  readonly kind: PlatformStoreKind

  /**
   * Sync transaction bridge (SQLite today).
   * Prefer {@link transactionAsync} for new multi-dialect code.
   */
  transaction<T>(fn: () => T): T

  /**
   * Target multi-dialect contract — Promise-based multi-statement work.
   * SQLite adapter runs sync callbacks inside the same SQLite transaction.
   */
  transactionAsync<T>(fn: () => Promise<T> | T): Promise<T>
}

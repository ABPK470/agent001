/**
 * PlatformStore — transactional access to the platform SQLite store.
 *
 * Repositories remain the dialect for reads/writes; this port covers
 * multi-statement transactions. Events go through {@link EventStore}.
 */

export interface PlatformStore {
  transaction<T>(fn: () => T): T
}

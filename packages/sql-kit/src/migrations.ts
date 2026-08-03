/**
 * Migration runner *contract* — platform store owns implementations.
 *
 * Sync does not migrate customer warehouse schemas. Platform adapters
 * (sqlite today; mssql/postgres next) implement {@link MigrationRunner}.
 */

import type { RelationalDialectKind } from "./pool.js"

export type MigrationId = {
  readonly version: number
  readonly name: string
}

export type AppliedMigration = MigrationId & {
  readonly appliedAt: string | null
}

/**
 * Dialect-agnostic migration surface. Concrete runners bind a connection
 * and execute DDL for one {@link RelationalDialectKind}.
 */
export interface MigrationRunner {
  readonly dialect: RelationalDialectKind
  /** Apply every pending migration in version order (idempotent). */
  applyPending(): Promise<void> | void
  /** Catalog of known migrations with applied timestamps. */
  list(): Promise<readonly AppliedMigration[]> | readonly AppliedMigration[]
}

/**
 * One versioned step. `up` receives an opaque executor owned by the adapter
 * (better-sqlite3 Database, mssql pool request, pg client, …).
 */
export type MigrationStep<TExecutor = unknown> = MigrationId & {
  up: (executor: TExecutor) => Promise<void> | void
}

/**
 * Multi-dialect migration body (plan milestone 4).
 *
 * One logical version; each dialect supplies its own DDL/`up`. Adapters
 * pick {@link upForDialect} at apply time. Missing dialect = not portable yet.
 */
export type MultiDialectMigrationStep = MigrationId & {
  up: Partial<
    Record<RelationalDialectKind, (executor: unknown) => Promise<void> | void>
  >
}

/** Resolve the dialect-specific `up`, or null when that dialect is not ready. */
export function upForDialect(
  step: MultiDialectMigrationStep,
  dialect: RelationalDialectKind,
): ((executor: unknown) => Promise<void> | void) | null {
  return step.up[dialect] ?? null
}

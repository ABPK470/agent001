/**
 * adapters/postgres.ts — PostgreSQL adapter.
 *
 * Streams rows via `pg-query-stream` and writes in batched, transactional
 * INSERTs. As with mssql, driver calls go through a {@link PostgresDriver}
 * port so the adapter is testable without a live Postgres.
 */

import type {
  AdapterCapabilities,
  Connector,
  ConnectorAdapter,
  MoveSummary,
  ReadSpec,
  Row,
  SqlReadSpec,
  SqlWriteSpec,
  WriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"

type RowBatch = Row[]

export type PostgresInsertOptions = {
  /** Emit `INSERT … OVERRIDING SYSTEM VALUE` so explicit identity values stick. */
  readonly overridingSystemValue?: boolean
}

export interface PostgresDriver {
  streamQuery(sql: string, batchSize: number): AsyncGenerator<RowBatch>
  beginTransaction(): Promise<PostgresTransaction>
  insertBatches(
    table: string,
    rows: AsyncGenerator<RowBatch>,
    options?: PostgresInsertOptions,
  ): Promise<MoveSummary>
  close(): Promise<void>
}

export interface PostgresTransaction {
  truncate(table: string): Promise<void>
  /** `SET LOCAL session_replication_role = replica` (true) or DEFAULT (false). */
  setReplicationRole(replica: boolean): Promise<void>
  insertBatches(
    table: string,
    rows: AsyncGenerator<RowBatch>,
    options?: PostgresInsertOptions,
  ): Promise<MoveSummary>
  commit(): Promise<void>
  rollback(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: true, query: true }
const DEFAULT_BATCH = 1000

function isSqlRead(spec: ReadSpec): spec is SqlReadSpec {
  return spec.kind === "sql"
}

function isSqlWrite(spec: WriteSpec): spec is SqlWriteSpec {
  return spec.kind === "sql"
}

export interface PostgresAdapterOptions {
  /** Resolved lazily on `open()` so connection pools stay lazy until a move runs. */
  readonly driverProvider: () => Promise<PostgresDriver>
  readonly writeEnabled: boolean
  readonly batchSize?: number
}

export function createPostgresAdapter(
  _connector: Connector,
  options: PostgresAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: PostgresDriver | null = null

  return {
    kind: "postgres",
    capabilities: CAPABILITIES,
    async open() {
      driver = await options.driverProvider()
    },
    async close() {
      const d = driver
      driver = null
      if (d) await d.close()
    },
    async* read(spec: ReadSpec) {
      if (!driver) throw new Error("postgres adapter read before open")
      if (!isSqlRead(spec)) throw new Error(`postgres adapter cannot read spec kind '${spec.kind}'`)
      for await (const batch of driver.streamQuery(spec.sql, batchSize)) {
        yield batch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("postgres adapter write before open")
      if (!isSqlWrite(spec)) throw new Error(`postgres adapter cannot write spec kind '${spec.kind}'`)
      if (!options.writeEnabled) {
        return makeSummary("failed", 0, 0, [{ row: 0, message: "connector is read-only (writeEnabled=false)" }], 0)
      }
      const insertOpts: PostgresInsertOptions | undefined = spec.allowIdentityInsert
        ? { overridingSystemValue: true }
        : undefined
      // Constraint relaxation and replace need a held session/transaction.
      if (spec.mode === "replace" || spec.relaxConstraints) {
        return writePowered(driver, spec, rows, insertOpts)
      }
      return driver.insertBatches(spec.table, rows, insertOpts)
    },
  }
}

async function writePowered(
  driver: PostgresDriver,
  spec: SqlWriteSpec,
  rows: AsyncGenerator<RowBatch>,
  insertOpts: PostgresInsertOptions | undefined,
): Promise<MoveSummary> {
  const tx = await driver.beginTransaction()
  let rowsWritten = 0
  try {
    if (spec.relaxConstraints) {
      await tx.setReplicationRole(true)
    }
    if (spec.mode === "replace") {
      await tx.truncate(spec.table)
    }
    const insertSummary = await tx.insertBatches(spec.table, rows, insertOpts)
    rowsWritten = insertSummary.rowsWritten
    if (insertSummary.status !== "completed") {
      await tx.rollback()
      return makeSummary(
        "failed",
        insertSummary.rowsRead,
        rowsWritten,
        insertSummary.errors,
        insertSummary.failedAtRow,
      )
    }
    await tx.commit()
    return makeSummary("completed", insertSummary.rowsRead, rowsWritten, [], null)
  } catch (e) {
    try {
      await tx.rollback()
    } catch {
      // Connection may already be broken; SET LOCAL ends with the session.
    }
    return makeSummary("failed", rowsWritten, rowsWritten, [{ row: rowsWritten, message: messageOf(e) }], rowsWritten)
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

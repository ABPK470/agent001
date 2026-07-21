/**
 * adapters/mssql.ts — SQL Server adapter.
 *
 * Reuses the boot-time connection pools (built from persisted mssql connectors
 * in @mia/server). To keep @mia/connectors free of the agent host and
 * testable without a live SQL Server, all mssql driver calls go through a
 * small {@link MssqlDriver} port. The server supplies a default driver that
 * wraps the real `mssql` pool (see defaultMssqlDriver); tests supply a mock.
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

/** A row batch yielded by the streaming read. */
export type RowBatch = Row[]

/** Options for a powered insert batch (same SQL batch as the INSERT). */
export type MssqlInsertOptions = {
  /**
   * Prefix each INSERT with `SET IDENTITY_INSERT … ON` in the *same* query
   * string. Separate SET + INSERT requests are not reliable with node-mssql.
   */
  readonly identityInsert?: boolean
}

/** Streaming read + transactional batch write, abstracted over `mssql`. */
export interface MssqlDriver {
  /** Stream rows from a SQL query in fixed-size batches. */
  streamQuery(sql: string, batchSize: number): AsyncGenerator<RowBatch>
  /** Open a transaction (also used when identity/constraint power-ups need one session). */
  beginTransaction(): Promise<MssqlTransaction>
  /** Batch-insert rows into a table (plain append — no session power-ups). */
  insertBatches(
    table: string,
    rows: AsyncGenerator<RowBatch>,
    options?: MssqlInsertOptions,
  ): Promise<MoveSummary>
  close(): Promise<void>
}

export interface MssqlTransaction {
  truncate(table: string): Promise<void>
  /** `NOCHECK` (false) or `CHECK CONSTRAINT ALL` (true) on the target table. */
  setConstraintsChecked(table: string, checked: boolean): Promise<void>
  insertBatches(
    table: string,
    rows: AsyncGenerator<RowBatch>,
    options?: MssqlInsertOptions,
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

function needsPoweredWrite(spec: SqlWriteSpec): boolean {
  return (
    spec.mode === "replace" ||
    Boolean(spec.allowIdentityInsert) ||
    Boolean(spec.relaxConstraints)
  )
}

export interface MssqlAdapterOptions {
  /** Resolved lazily on `open()` so connection pools stay lazy until a move runs. */
  readonly driverProvider: () => Promise<MssqlDriver>
  readonly writeEnabled: boolean
  readonly batchSize?: number
}

export function createMssqlAdapter(
  _connector: Connector,
  options: MssqlAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: MssqlDriver | null = null

  return {
    kind: "mssql",
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
      if (!driver) throw new Error("mssql adapter read before open")
      if (!isSqlRead(spec)) throw new Error(`mssql adapter cannot read spec kind '${spec.kind}'`)
      for await (const batch of driver.streamQuery(spec.sql, batchSize)) {
        yield batch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("mssql adapter write before open")
      if (!isSqlWrite(spec)) throw new Error(`mssql adapter cannot write spec kind '${spec.kind}'`)
      if (!options.writeEnabled) {
        return makeSummary("failed", 0, 0, [{
          row: 0,
          message: "Connector is read-only (writeEnabled=false). Enable Write on the connector before mutating data.",
        }], 0)
      }
      if (needsPoweredWrite(spec)) {
        return writePowered(driver, spec, rows)
      }
      return driver.insertBatches(spec.table, rows)
    },
  }
}

/**
 * One connection for replace and/or constraint overrides.
 * IDENTITY_INSERT is applied in the same SQL batch as each INSERT (node-mssql
 * does not reliably keep a prior SET across requests). NOCHECK is metadata —
 * always restore after the write.
 */
async function writePowered(
  driver: MssqlDriver,
  spec: SqlWriteSpec,
  rows: AsyncGenerator<RowBatch>,
): Promise<MoveSummary> {
  const tx = await driver.beginTransaction()
  let nocheck = false
  let rowsWritten = 0
  const insertOpts: MssqlInsertOptions | undefined = spec.allowIdentityInsert
    ? { identityInsert: true }
    : undefined
  try {
    if (spec.relaxConstraints) {
      await tx.setConstraintsChecked(spec.table, false)
      nocheck = true
    }
    if (spec.mode === "replace") {
      await tx.truncate(spec.table)
    }
    const insertSummary = await tx.insertBatches(spec.table, rows, insertOpts)
    rowsWritten = insertSummary.rowsWritten

    if (nocheck) {
      await tx.setConstraintsChecked(spec.table, true)
      nocheck = false
    }

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
      if (nocheck) await tx.setConstraintsChecked(spec.table, true)
    } catch {
      // Best-effort restore before rollback / pool return.
    }
    try {
      await tx.rollback()
    } catch {
      // Connection may already be broken.
    }
    return makeSummary("failed", rowsWritten, rowsWritten, [{ row: rowsWritten, message: messageOf(e) }], rowsWritten)
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

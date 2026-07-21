/**
 * adapters/oracle.ts — Oracle Database adapter.
 *
 * Streaming SELECT + batched INSERT via a {@link OracleDriver} port. The
 * server supplies {@link defaultOracleDriver} (node-oracledb pool); unit
 * tests supply a mock. Same control shape as postgres/mssql so Bridge stays
 * one dialect of thought.
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

export type OracleInsertOptions = {
  /** Emit `INSERT … OVERRIDING SYSTEM VALUE` for identity / generated columns. */
  readonly overridingSystemValue?: boolean
}

export interface OracleDriver {
  streamQuery(sql: string, batchSize: number): AsyncGenerator<RowBatch>
  beginTransaction(): Promise<OracleTransaction>
  insertBatches(
    table: string,
    rows: AsyncGenerator<RowBatch>,
    options?: OracleInsertOptions,
  ): Promise<MoveSummary>
  close(): Promise<void>
}

export interface OracleTransaction {
  truncate(table: string): Promise<void>
  /** Disable (false) or enable (true) CHECK / FK / UNIQUE constraints on the table. */
  setConstraintsChecked(table: string, checked: boolean): Promise<void>
  insertBatches(
    table: string,
    rows: AsyncGenerator<RowBatch>,
    options?: OracleInsertOptions,
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

export interface OracleAdapterOptions {
  readonly driverProvider: () => Promise<OracleDriver>
  readonly batchSize?: number
}

export function createOracleAdapter(
  _connector: Connector,
  options: OracleAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: OracleDriver | null = null

  return {
    kind: "oracle",
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
      if (!driver) throw new Error("oracle adapter read before open")
      if (!isSqlRead(spec)) throw new Error(`oracle adapter cannot read spec kind '${spec.kind}'`)
      for await (const batch of driver.streamQuery(spec.sql, batchSize)) {
        yield batch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("oracle adapter write before open")
      if (!isSqlWrite(spec)) throw new Error(`oracle adapter cannot write spec kind '${spec.kind}'`)
      const insertOpts: OracleInsertOptions | undefined = spec.allowIdentityInsert
        ? { overridingSystemValue: true }
        : undefined
      if (needsPoweredWrite(spec)) {
        return writePowered(driver, spec, rows, insertOpts)
      }
      return driver.insertBatches(spec.table, rows, insertOpts)
    },
  }
}

/**
 * Held connection for replace and/or constraint / identity overrides.
 * Note: Oracle TRUNCATE is DDL (implicit commit); constraints are restored
 * after inserts regardless.
 */
async function writePowered(
  driver: OracleDriver,
  spec: SqlWriteSpec,
  rows: AsyncGenerator<RowBatch>,
  insertOpts: OracleInsertOptions | undefined,
): Promise<MoveSummary> {
  const tx = await driver.beginTransaction()
  let nocheck = false
  let rowsWritten = 0
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
      // Best-effort restore.
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

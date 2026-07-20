/**
 * adapters/hive.ts — Hive (HiveServer2) SQL adapter.
 *
 * Hive speaks SQL, so this adapter reuses the SQL read/write specs and mirrors
 * the mssql/postgres shape: streaming `SELECT` reads and transactional
 * `replace` (TRUNCATE + INSERT) / `append` (batch INSERT) writes.
 *
 * The real HiveServer2 wire protocol is Thrift (TCLIService). To keep
 * @mia/connectors free of a heavy thrift dependency and testable without a
 * live Hive server, all wire calls go through a {@link HiveClient} port. The
 * default driver {@link defaultHiveDriver} wraps a caller-supplied thrift
 * client; the server registers hive only when such a client is available, so
 * the kind stays greyed-out in the UI until a binding is wired.
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
import { quoteSqlLiteral } from "../sql-literals.js"

type RowBatch = Row[]

/**
 * Minimal HiveServer2 client surface the adapter needs. A real thrift binding
 * implements this; tests supply a mock.
 */
export interface HiveClient {
  /** Run a SQL statement that has no result set (DDL/DML/transaction control). */
  execute(sql: string): Promise<void>
  /** Run a query and fetch up to `maxRows` rows; empty array when exhausted. */
  query(sql: string, maxRows: number): Promise<Row[]>
  close(): Promise<void>
}

/** Streaming read + transactional batch write, abstracted over {@link HiveClient}. */
export interface HiveDriver {
  streamQuery(sql: string, batchSize: number): AsyncGenerator<RowBatch>
  beginTransaction(): Promise<HiveTransaction>
  insertBatches(table: string, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary>
  close(): Promise<void>
}

export interface HiveTransaction {
  truncate(table: string): Promise<void>
  insertBatches(table: string, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary>
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

export interface HiveAdapterOptions {
  readonly driverProvider: () => Promise<HiveDriver>
  readonly writeEnabled: boolean
  readonly batchSize?: number
}

export function createHiveAdapter(
  _connector: Connector,
  options: HiveAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: HiveDriver | null = null

  return {
    kind: "hive",
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
      if (!driver) throw new Error("hive adapter read before open")
      if (!isSqlRead(spec)) throw new Error(`hive adapter cannot read spec kind '${spec.kind}'`)
      for await (const batch of driver.streamQuery(spec.sql, batchSize)) {
        yield batch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("hive adapter write before open")
      if (!isSqlWrite(spec)) throw new Error(`hive adapter cannot write spec kind '${spec.kind}'`)
      if (!options.writeEnabled) {
        return makeSummary("failed", 0, 0, [{ row: 0, message: "connector is read-only (writeEnabled=false)" }], 0)
      }
      if (spec.mode === "replace") {
        return writeReplace(driver, spec, rows)
      }
      return driver.insertBatches(spec.table, rows)
    },
  }
}

/** `replace`: TRUNCATE + INSERT inside one transaction; ROLLBACK on any error. */
async function writeReplace(
  driver: HiveDriver,
  spec: SqlWriteSpec,
  rows: AsyncGenerator<RowBatch>,
): Promise<MoveSummary> {
  const tx = await driver.beginTransaction()
  let rowsWritten = 0
  try {
    await tx.truncate(spec.table)
    const insertSummary = await tx.insertBatches(spec.table, rows)
    rowsWritten = insertSummary.rowsWritten
    if (insertSummary.status !== "completed") {
      await tx.rollback()
      return makeSummary("failed", insertSummary.rowsRead, rowsWritten, insertSummary.errors, insertSummary.failedAtRow)
    }
    await tx.commit()
    return makeSummary("completed", insertSummary.rowsRead, rowsWritten, [], null)
  } catch (e) {
    await tx.rollback()
    return makeSummary("failed", rowsWritten, rowsWritten, [{ row: rowsWritten, message: messageOf(e) }], rowsWritten)
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Wrap a caller-supplied thrift {@link HiveClient} into a {@link HiveDriver}. */
export function defaultHiveDriver(client: HiveClient): HiveDriver {
  return {
    async* streamQuery(sql, batchSize) {
      while (true) {
        const rows = await client.query(sql, batchSize)
        if (rows.length === 0) return
        yield rows
        if (rows.length < batchSize) return
      }
    },
    async beginTransaction() {
      await client.execute("START TRANSACTION")
      let rolledBack = false
      return {
        async truncate(table) {
          await client.execute(`TRUNCATE TABLE ${quoteIdent(table)}`)
        },
        async insertBatches(table, rows) {
          return hiveInsertBatches(client, table, rows)
        },
        async commit() {
          await client.execute("COMMIT")
        },
        async rollback() {
          if (rolledBack) return
          rolledBack = true
          await client.execute("ROLLBACK")
        },
      }
    },
    async insertBatches(table, rows) {
      return hiveInsertBatches(client, table, rows)
    },
    async close() {
      await client.close()
    },
  }
}

async function hiveInsertBatches(
  client: HiveClient,
  table: string,
  rows: AsyncGenerator<RowBatch>,
): Promise<MoveSummary> {
  let rowsWritten = 0
  for await (const batch of rows) {
    if (batch.length === 0) continue
    const cols = Object.keys(batch[0]!)
    const values = batch.map((r) => `(${cols.map((c) => quoteSqlLiteral(r[c])).join(",")})`).join(",")
    await client.execute(`INSERT INTO TABLE ${quoteIdent(table)} (${cols.map(quoteIdent).join(",")}) VALUES ${values}`)
    rowsWritten += batch.length
  }
  return makeSummary("completed", rowsWritten, rowsWritten, [], null)
}

/** `db.tbl` → `` `db`.`tbl` `` (whole-string backticks would be one illegal name). */
function quoteIdent(name: string): string {
  return name
    .split(".")
    .map((part) => `\`${part.replace(/`/g, "``")}\``)
    .join(".")
}

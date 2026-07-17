/**
 * adapters/databricks.ts — Databricks SQL warehouse adapter.
 *
 * Reads and writes via the Databricks SQL Statements REST API. Uses the same
 * `sql` read/write specs as mssql/postgres. Results are fetched in one
 * statement response (moderate row counts); chunked external links are a
 * future enhancement.
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

export interface DatabricksDriver {
  streamQuery(sql: string, batchSize: number): AsyncGenerator<RowBatch>
  insertBatches(table: string, mode: "append" | "replace", rows: AsyncGenerator<RowBatch>): Promise<MoveSummary>
  close(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: true, query: true }
const DEFAULT_BATCH = 1000

function isSqlRead(spec: ReadSpec): spec is SqlReadSpec {
  return spec.kind === "sql"
}

function isSqlWrite(spec: WriteSpec): spec is SqlWriteSpec {
  return spec.kind === "sql"
}

export interface DatabricksAdapterOptions {
  readonly driverProvider: () => Promise<DatabricksDriver>
  readonly writeEnabled: boolean
  readonly batchSize?: number
}

export function createDatabricksAdapter(
  _connector: Connector,
  options: DatabricksAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: DatabricksDriver | null = null

  return {
    kind: "databricks",
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
      if (!driver) throw new Error("databricks adapter read before open")
      if (!isSqlRead(spec)) throw new Error(`databricks adapter cannot read spec kind '${spec.kind}'`)
      for await (const batch of driver.streamQuery(spec.sql, batchSize)) {
        yield batch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("databricks adapter write before open")
      if (!isSqlWrite(spec)) throw new Error(`databricks adapter cannot write spec kind '${spec.kind}'`)
      if (!options.writeEnabled) {
        return makeSummary("failed", 0, 0, [{ row: 0, message: "connector is read-only (writeEnabled=false)" }], 0)
      }
      return driver.insertBatches(spec.table, spec.mode, rows)
    },
  }
}

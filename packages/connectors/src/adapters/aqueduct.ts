/**
 * adapters/aqueduct.ts — Aqueduct pipeline preview adapter (read-only).
 *
 * Fetches preview rows for a configured pipeline via the Aqueduct REST API.
 * Writes are not supported — pipelines are authored in Aqueduct, not via
 * row-by-row ingest here.
 */

import type {
  AdapterCapabilities,
  AqueductReadSpec,
  Connector,
  ConnectorAdapter,
  MoveSummary,
  ReadSpec,
  Row,
  WriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"

type RowBatch = Row[]

export interface AqueductDriver {
  /** Return preview rows for the connector's pipeline (optionally with params). */
  fetchPreview(params?: Record<string, string>): Promise<Row[]>
  close(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: false, query: false }
const DEFAULT_BATCH = 1000

function isAqueductRead(spec: ReadSpec): spec is AqueductReadSpec {
  return spec.kind === "aqueduct"
}

export interface AqueductAdapterOptions {
  readonly driverProvider: () => Promise<AqueductDriver>
  readonly batchSize?: number
}

export function createAqueductAdapter(
  _connector: Connector,
  options: AqueductAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: AqueductDriver | null = null

  return {
    kind: "aqueduct",
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
      if (!driver) throw new Error("aqueduct adapter read before open")
      if (!isAqueductRead(spec)) throw new Error(`aqueduct adapter cannot read spec kind '${spec.kind}'`)
      const rows = await driver.fetchPreview(spec.params)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(_spec: WriteSpec, _rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      return makeSummary("failed", 0, 0, [{ row: 0, message: "aqueduct connector is read-only" }], 0)
    },
  }
}

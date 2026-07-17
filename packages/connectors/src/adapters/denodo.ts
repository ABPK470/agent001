/**
 * adapters/denodo.ts — Denodo REST adapter (read-only).
 *
 * Denodo exposes views over a REST API: `GET <base>/server/<db>/<view>?<params>`
 * returns a JSON array of objects. This adapter reads that array and re-batches
 * it. Denodo has no REST write path in our framework (writes go through JDBC,
 * which we don't ship here), so `write` always reports unsupported — the
 * `capabilities.write=false` flag is the source of truth the UI/engine gate on.
 *
 * Driver calls go through a {@link DenodoDriver} port so the adapter is
 * testable without a live Denodo server.
 */

import type {
  AdapterCapabilities,
  Connector,
  ConnectorAdapter,
  MoveSummary,
  ReadSpec,
  Row,
  WriteSpec,
  DenodoReadSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"

type RowBatch = Row[]

export interface DenodoDriver {
  /** GET a Denodo view with optional query params; returns the parsed JSON body. */
  get(view: string, params?: Record<string, string>): Promise<unknown>
  close(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: false, query: false }
const DEFAULT_BATCH = 1000

function isDenodoRead(spec: ReadSpec): spec is DenodoReadSpec {
  return spec.kind === "denodo"
}

export interface DenodoAdapterOptions {
  readonly driverProvider: () => Promise<DenodoDriver>
  readonly batchSize?: number
}

export function createDenodoAdapter(
  _connector: Connector,
  options: DenodoAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: DenodoDriver | null = null

  return {
    kind: "denodo",
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
      if (!driver) throw new Error("denodo adapter read before open")
      if (!isDenodoRead(spec)) throw new Error(`denodo adapter cannot read spec kind '${spec.kind}'`)
      const json = await driver.get(spec.view, spec.params)
      if (!Array.isArray(json)) {
        throw new Error(`denodo: expected a JSON array of rows from view '${spec.view}', got ${typeof json}`)
      }
      const rows = json as Row[]
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(_spec: WriteSpec, _rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      return makeSummary("failed", 0, 0, [{ row: 0, message: "denodo adapter is read-only (no REST write path)" }], 0)
    },
  }
}

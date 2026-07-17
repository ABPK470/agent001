/**
 * adapters/http-api.ts — generic HTTP / REST adapter.
 *
 * Reads: one HTTP request returns a JSON payload; the rows array is located
 *   via `jsonPath` (dot-path) or assumed to be the top-level array, then
 *   re-batched and yielded. (HTTP responses are single payloads; true
 *   streaming JSON parsing is a future enhancement — the engine still never
 *   holds more than one batch in memory between source and target.)
 * Writes: each row is sent as its own request (POST/PUT). HTTP has no
 *   transaction, so a failed row cannot be "rolled back" — the writer
 *   continues past errors and reports a `partial` summary with the per-row
 *   failure list. This matches the plan's append-mode "partial writes"
 *   contract for non-transactional targets.
 *
 * Driver calls go through an {@link HttpDriver} port so the adapter is
 * testable without network access.
 */

import type {
  AdapterCapabilities,
  Connector,
  ConnectorAdapter,
  MovementValue,
  MoveSummary,
  ReadSpec,
  Row,
  WriteSpec,
  HttpApiReadSpec,
  HttpApiWriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"

type RowBatch = Row[]

export interface HttpDriver {
  /** Issue a request and return the parsed JSON body (or null for empty). */
  request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown>
  close(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: true, query: false }
const DEFAULT_BATCH = 1000

function isHttpRead(spec: ReadSpec): spec is HttpApiReadSpec {
  return spec.kind === "httpApi"
}
function isHttpWrite(spec: WriteSpec): spec is HttpApiWriteSpec {
  return spec.kind === "httpApi"
}

export interface HttpApiAdapterOptions {
  readonly driverProvider: () => Promise<HttpDriver>
  readonly batchSize?: number
}

export function createHttpApiAdapter(
  _connector: Connector,
  options: HttpApiAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: HttpDriver | null = null

  return {
    kind: "httpApi",
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
      if (!driver) throw new Error("httpApi adapter read before open")
      if (!isHttpRead(spec)) throw new Error(`httpApi adapter cannot read spec kind '${spec.kind}'`)
      const json = await driver.request(spec.method, spec.path, spec.body, spec.headers)
      const rows = extractRows(json, spec.jsonPath)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("httpApi adapter write before open")
      if (!isHttpWrite(spec)) throw new Error(`httpApi adapter cannot write spec kind '${spec.kind}'`)
      let rowsRead = 0
      let rowsWritten = 0
      const errors: MoveSummary["errors"] = []
      for await (const batch of rows) {
        for (const row of batch) {
          rowsRead++
          try {
            await driver.request(spec.method, spec.path, mergeBody(spec.body, row), spec.headers)
            rowsWritten++
          } catch (e) {
            errors.push({ row: rowsRead - 1, message: messageOf(e) })
          }
        }
      }
      if (errors.length > 0) {
        return makeSummary("partial", rowsRead, rowsWritten, errors, null)
      }
      return makeSummary("completed", rowsRead, rowsWritten, [], null)
    },
  }
}

/** Merge a static spec body with the row: row fields win (last-write-wins). */
function mergeBody(specBody: unknown, row: Row): unknown {
  if (specBody && typeof specBody === "object" && !Array.isArray(specBody)) {
    return { ...(specBody as Record<string, unknown>), ...(row as Record<string, unknown>) }
  }
  return row
}

/** Locate the rows array in a JSON response. */
export function extractRows(json: unknown, jsonPath?: string): Row[] {
  let target: unknown = json
  if (jsonPath) {
    for (const key of jsonPath.split(".")) {
      if (target === null || typeof target !== "object") {
        throw new Error(`httpApi: cannot navigate jsonPath '${jsonPath}' (missing '${key}')`)
      }
      target = (target as Record<string, unknown>)[key]
    }
  }
  if (!Array.isArray(target)) {
    throw new Error(
      `httpApi: expected a JSON array of rows${jsonPath ? ` at '${jsonPath}'` : ""}, got ${typeof target}`,
    )
  }
  return target as Row[]
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Re-export for callers that build MovementValue-typed rows from raw JSON.
export type { MovementValue }

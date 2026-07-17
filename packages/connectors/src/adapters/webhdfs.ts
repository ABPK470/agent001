/**
 * adapters/webhdfs.ts — HDFS file adapter over the WebHDFS REST API.
 *
 * Reads: `op=OPEN` returns the file body; CSV (header row) or JSON array is
 *   parsed into rows and re-batched.
 * Writes: rows are serialized to CSV / JSON on the fly into a ReadableStream
 *   and `PUT` to HDFS (`op=CREATE` for replace, `op=APPEND` for append). The
 *   stream is pulled lazily from the row generator, so a multi-GB write never
 *   holds the whole file in memory.
 *
 * Driver calls go through a {@link WebHdfsDriver} port so the adapter is
 * testable without a live HDFS cluster.
 */

import type {
  AdapterCapabilities,
  Connector,
  ConnectorAdapter,
  MoveSummary,
  MovementValue,
  ReadSpec,
  Row,
  WebhdfsReadSpec,
  WebhdfsWriteSpec,
  WriteMode,
  WriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"

type RowBatch = Row[]

export interface WebHdfsDriver {
  /** Return the full text body of a file. */
  readText(path: string): Promise<string>
  /** Upload a byte stream to a path. `mode` selects CREATE (replace) vs APPEND. */
  putText(path: string, mode: WriteMode, body: ReadableStream<Uint8Array>): Promise<void>
  close(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: true, query: false }
const DEFAULT_BATCH = 1000

function isWebhdfsRead(spec: ReadSpec): spec is WebhdfsReadSpec {
  return spec.kind === "webhdfs"
}
function isWebhdfsWrite(spec: WriteSpec): spec is WebhdfsWriteSpec {
  return spec.kind === "webhdfs"
}

export interface WebhdfsAdapterOptions {
  readonly driverProvider: () => Promise<WebHdfsDriver>
  readonly writeEnabled: boolean
  readonly batchSize?: number
}

export function createWebhdfsAdapter(
  _connector: Connector,
  options: WebhdfsAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: WebHdfsDriver | null = null

  return {
    kind: "webhdfs",
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
      if (!driver) throw new Error("webhdfs adapter read before open")
      if (!isWebhdfsRead(spec)) throw new Error(`webhdfs adapter cannot read spec kind '${spec.kind}'`)
      const text = await driver.readText(spec.path)
      const rows = spec.format === "csv" ? parseCsv(text) : parseJsonArray(text)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error("webhdfs adapter write before open")
      if (!isWebhdfsWrite(spec)) throw new Error(`webhdfs adapter cannot write spec kind '${spec.kind}'`)
      if (!options.writeEnabled) {
        return makeSummary("failed", 0, 0, [{ row: 0, message: "connector is read-only (writeEnabled=false)" }], 0)
      }
      let rowsRead = 0
      const counting = async function* (): AsyncGenerator<RowBatch> {
        for await (const batch of rows) {
          rowsRead += batch.length
          yield batch
        }
      }
      const body = ReadableStream.from(serializeRows(counting(), spec.format))
      try {
        await driver.putText(spec.path, spec.mode, body)
        return makeSummary("completed", rowsRead, rowsRead, [], null)
      } catch (e) {
        return makeSummary("failed", rowsRead, 0, [{ row: 0, message: messageOf(e) }], null)
      }
    },
  }
}

// ── serialization (streaming) ────────────────────────────────────

/** Lazily serialize a row-batch stream to CSV / JSON text chunks. */
export async function* serializeRows(
  rows: AsyncGenerator<RowBatch>,
  format: "csv" | "json",
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder()
  let header: string[] | null = null
  let first = true
  for await (const batch of rows) {
    if (batch.length === 0) continue
    if (format === "csv") {
      if (!header) {
        header = Object.keys(batch[0]!)
        yield enc.encode(toCsvLine(header) + "\n")
      }
      for (const row of batch) {
        yield enc.encode(toCsvLine(header!.map((h) => row[h] ?? "")) + "\n")
      }
    } else {
      for (const row of batch) {
        const prefix = first ? "[" : ","
        first = false
        yield enc.encode(prefix + JSON.stringify(row))
      }
    }
  }
  if (format === "json" && !first) yield enc.encode("]")
}

function toCsvLine(values: unknown[]): string {
  return values.map(csvField).join(",")
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = typeof value === "string" ? value : String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

// ── parsing (read) ───────────────────────────────────────────────

function parseJsonArray(text: string): Row[] {
  const trimmed = text.trim()
  if (trimmed === "") return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) {
    throw new Error(`webhdfs: expected a JSON array, got ${typeof parsed}`)
  }
  return parsed as Row[]
}

/** Minimal RFC-4180-ish CSV parser: quotes, embedded commas, embedded newlines. */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = []
  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let i = 0
  let inQuotes = false
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ",") {
      record.push(field)
      field = ""
      i++
      continue
    }
    if (ch === "\r") {
      // handle CRLF
      if (text[i + 1] === "\n") i++
      record.push(field)
      field = ""
      records.push(record)
      record = []
      i++
      continue
    }
    if (ch === "\n") {
      record.push(field)
      field = ""
      records.push(record)
      record = []
      i++
      continue
    }
    field += ch
    i++
  }
  // flush trailing field/record (file without final newline)
  if (field !== "" || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  if (records.length === 0) return []
  const header = records[0]!
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!
    if (rec.length === 1 && rec[0] === "") continue // skip blank lines
    const row: Row = {}
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = (rec[c] ?? "") as MovementValue
    }
    rows.push(row)
  }
  return rows
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

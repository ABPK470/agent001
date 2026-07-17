/**
 * adapters/webhdfs.ts — HDFS file adapter over the WebHDFS REST API.
 *
 * Reads: `op=OPEN` returns the file body; CSV / JSON / Parquet is parsed into
 *   rows and re-batched.
 * Writes: CSV/JSON stream via PUT; Parquet materializes a binary buffer.
 *   `mode` selects CREATE (replace) vs APPEND (text) or read-merge-rewrite (parquet).
 */

import type {
  AdapterCapabilities,
  Connector,
  ConnectorAdapter,
  FileFormat,
  MoveSummary,
  MovementValue,
  ReadSpec,
  Row,
  WebhdfsReadSpec,
  WebhdfsWriteSpec,
  WriteMode,
  WriteOptions,
  WriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"
import { serializeParquet } from "../parquet.js"
import { decodeFileRows } from "./file-formats.js"
import { putDriverBytes, readDriverBytes } from "./driver-bytes.js"

type RowBatch = Row[]

export interface WebHdfsDriver {
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  putText(path: string, mode: WriteMode, body: ReadableStream<Uint8Array>): Promise<void>
  putBytes(path: string, mode: WriteMode, body: Uint8Array): Promise<void>
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
      const bytes = await readDriverBytes(driver, spec.path)
      const rows = await decodeFileRows(spec.format, bytes)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>, writeOpts?: WriteOptions): Promise<MoveSummary> {
      if (!driver) throw new Error("webhdfs adapter write before open")
      if (!isWebhdfsWrite(spec)) throw new Error(`webhdfs adapter cannot write spec kind '${spec.kind}'`)
      if (!options.writeEnabled) {
        return makeSummary("failed", 0, 0, [{ row: 0, message: "connector is read-only (writeEnabled=false)" }], 0)
      }
      try {
        throwIfAborted(writeOpts?.signal)
        if (spec.format === "parquet") {
          return await writeParquet(driver, spec.path, spec.mode, rows, writeOpts?.signal)
        }
        return await writeTextFormat(driver, spec.path, spec.mode, spec.format, rows, writeOpts?.signal)
      } catch (e) {
        return makeSummary("failed", 0, 0, [{ row: 0, message: messageOf(e) }], null)
      }
    },
  }
}

async function writeParquet(
  driver: WebHdfsDriver,
  path: string,
  mode: WriteMode,
  rows: AsyncGenerator<RowBatch>,
  signal?: AbortSignal,
): Promise<MoveSummary> {
  const all: Row[] = []
  if (mode === "append") {
    try {
      const existing = await readDriverBytes(driver, path)
      const prior = await decodeFileRows("parquet", existing)
      all.push(...prior)
    } catch {
      /* new file */
    }
  }
  let incoming = 0
  for await (const batch of rows) {
    throwIfAborted(signal)
    incoming += batch.length
    all.push(...batch)
  }
  await putDriverBytes(driver, path, "replace", serializeParquet(all))
  return makeSummary("completed", incoming, incoming, [], null)
}

async function writeTextFormat(
  driver: WebHdfsDriver,
  path: string,
  mode: WriteMode,
  format: Exclude<FileFormat, "parquet">,
  rows: AsyncGenerator<RowBatch>,
  signal?: AbortSignal,
): Promise<MoveSummary> {
  let rowsRead = 0
  const counting = async function* (): AsyncGenerator<RowBatch> {
    for await (const batch of rows) {
      throwIfAborted(signal)
      rowsRead += batch.length
      yield batch
    }
  }
  const body = ReadableStream.from(serializeRows(counting(), format))
  await driver.putText(path, mode, body)
  return makeSummary("completed", rowsRead, rowsRead, [], null)
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
  if (field !== "" || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  if (records.length === 0) return []
  const header = records[0]!
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!
    if (rec.length === 1 && rec[0] === "") continue
    const row: Row = {}
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = (rec[c] ?? "") as MovementValue
    }
    rows.push(row)
  }
  return rows
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    throw reason instanceof Error ? reason : new Error("Bridge move aborted")
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

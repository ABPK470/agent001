/**
 * object-file.ts — shared CSV/JSON file adapter for object-store and FTP kinds.
 *
 * aws, azure, and ftp share the same read/write shape (path + format + mode).
 * Each kind supplies its own {@link FileTransferDriver} for fetch/put bytes.
 */

import type {
  AdapterCapabilities,
  AwsReadSpec,
  AwsWriteSpec,
  AzureReadSpec,
  AzureWriteSpec,
  Connector,
  ConnectorAdapter,
  ConnectorKindId,
  FtpReadSpec,
  FtpWriteSpec,
  MoveSummary,
  ReadSpec,
  Row,
  WriteMode,
  WriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"
import { parseCsv, serializeRows } from "./webhdfs.js"

type RowBatch = Row[]
type ObjectFileKind = "aws" | "azure" | "ftp"

export interface FileTransferDriver {
  readText(path: string): Promise<string>
  putText(path: string, mode: WriteMode, body: ReadableStream<Uint8Array>): Promise<void>
  close(): Promise<void>
}

const CAPABILITIES: AdapterCapabilities = { read: true, write: true, query: false }
const DEFAULT_BATCH = 1000

type ObjectFileReadSpec = AwsReadSpec | AzureReadSpec | FtpReadSpec
type ObjectFileWriteSpec = AwsWriteSpec | AzureWriteSpec | FtpWriteSpec

function isObjectFileRead(kind: ObjectFileKind, spec: ReadSpec): spec is ObjectFileReadSpec {
  return spec.kind === kind
}

function isObjectFileWrite(kind: ObjectFileKind, spec: WriteSpec): spec is ObjectFileWriteSpec {
  return spec.kind === kind
}

export interface ObjectFileAdapterOptions {
  readonly driverProvider: () => Promise<FileTransferDriver>
  readonly writeEnabled: boolean
  readonly batchSize?: number
}

export function createObjectFileAdapter(
  kind: ObjectFileKind,
  _connector: Connector,
  options: ObjectFileAdapterOptions,
): ConnectorAdapter {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  let driver: FileTransferDriver | null = null

  return {
    kind: kind as ConnectorKindId,
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
      if (!driver) throw new Error(`${kind} adapter read before open`)
      if (!isObjectFileRead(kind, spec)) throw new Error(`${kind} adapter cannot read spec kind '${spec.kind}'`)
      const text = await driver.readText(spec.path)
      const rows = spec.format === "csv" ? parseCsv(text) : parseJsonArray(text)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>): Promise<MoveSummary> {
      if (!driver) throw new Error(`${kind} adapter write before open`)
      if (!isObjectFileWrite(kind, spec)) throw new Error(`${kind} adapter cannot write spec kind '${spec.kind}'`)
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

function parseJsonArray(text: string): Row[] {
  const trimmed = text.trim()
  if (trimmed === "") return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) {
    throw new Error(`expected a JSON array, got ${typeof parsed}`)
  }
  return parsed as Row[]
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

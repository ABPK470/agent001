/**
 * object-file.ts — shared CSV/JSON/Parquet file adapter for object-store and FTP kinds.
 *
 * aws, azure, and ftp share the same read/write shape (path + format + mode).
 * Each kind supplies its own {@link FileTransferDriver} for fetch/put bytes.
 *
 * Parquet append = read existing file (if any), concatenate rows, rewrite.
 * Parquet always uses a full-file put (binary); csv/json keep streaming puts.
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
  FileFormat,
  FtpReadSpec,
  FtpWriteSpec,
  MoveSummary,
  ReadSpec,
  Row,
  WriteMode,
  WriteOptions,
  WriteSpec,
} from "@mia/shared-types"
import { makeSummary } from "../engine.js"
import { serializeParquet } from "../parquet.js"
import { decodeFileRows } from "./file-formats.js"
import { putDriverBytes, readDriverBytes } from "./driver-bytes.js"
import { serializeRows } from "./webhdfs.js"

type RowBatch = Row[]
type ObjectFileKind = "aws" | "azure" | "ftp"

export interface FileTransferDriver {
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  putText(path: string, mode: WriteMode, body: ReadableStream<Uint8Array>): Promise<void>
  putBytes(path: string, mode: WriteMode, body: Uint8Array): Promise<void>
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
      const bytes = await readDriverBytes(driver, spec.path)
      const rows = await decodeFileRows(spec.format, bytes)
      for (let i = 0; i < rows.length; i += batchSize) {
        yield rows.slice(i, i + batchSize) as RowBatch
      }
    },
    async write(spec: WriteSpec, rows: AsyncGenerator<RowBatch>, writeOpts?: WriteOptions): Promise<MoveSummary> {
      if (!driver) throw new Error(`${kind} adapter write before open`)
      if (!isObjectFileWrite(kind, spec)) throw new Error(`${kind} adapter cannot write spec kind '${spec.kind}'`)
      try {
        throwIfAborted(writeOpts?.signal)
        if (spec.format === "parquet") {
          return await writeParquet(driver, spec.path, spec.mode, rows, writeOpts?.signal)
        }
        return await writeTextFormat(driver, spec.path, spec.mode, spec.format, rows, writeOpts?.signal)
      } catch (e) {
        if (isAbortError(e)) {
          return makeSummary("failed", 0, 0, [{ row: 0, message: messageOf(e) }], 0)
        }
        return makeSummary("failed", 0, 0, [{ row: 0, message: messageOf(e) }], null)
      }
    },
  }
}

async function writeParquet(
  driver: FileTransferDriver,
  path: string,
  mode: WriteMode,
  rows: AsyncGenerator<RowBatch>,
  signal?: AbortSignal,
): Promise<MoveSummary> {
  const all: Row[] = []
  if (mode === "append") {
    try {
      const existing = await readDriverBytes(driver, path)
      all.push(...(await decodeFileRows("parquet", existing)))
    } catch {
      /* new object */
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
  driver: FileTransferDriver,
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    throw reason instanceof Error ? reason : new Error("Bridge move aborted")
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && /aborted/i.test(e.message)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

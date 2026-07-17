/**
 * parquet.ts — Bridge codec for Apache Parquet row sets.
 *
 * Reads produce plain `Row` objects so any target connector (SQL, HTTP,
 * object store, …) can consume them. Writes build a single Parquet buffer
 * from row batches (columnar layout inferred from values).
 *
 * Size note: Parquet encode/decode for Bridge v1 materializes the file in
 * memory (same class of bound as Denodo/HTTP JSON payloads). Prefer
 * partitioned files for very large datasets.
 */

import { parquetReadObjects } from "hyparquet"
import { parquetWriteBuffer } from "hyparquet-writer"
import type { MovementValue, Row } from "@mia/shared-types"

/** Decode a Parquet file into Bridge rows. */
export async function parseParquet(bytes: Uint8Array): Promise<Row[]> {
  const file = {
    byteLength: bytes.byteLength,
    slice(start: number, end?: number): ArrayBuffer {
      return bytes.buffer.slice(
        bytes.byteOffset + start,
        bytes.byteOffset + (end ?? bytes.byteLength),
      ) as ArrayBuffer
    },
  }
  const objects = await parquetReadObjects({ file })
  return objects.map(normalizeParquetRow)
}

/** Encode Bridge rows as a Parquet ArrayBuffer → Uint8Array. */
export function serializeParquet(rows: readonly Row[]): Uint8Array {
  if (rows.length === 0) {
    // Empty file with no columns — still a valid minimal write for overwrite clears.
    const buf = parquetWriteBuffer({
      columnData: [{ name: "_empty", data: [], type: "STRING" }],
    })
    return new Uint8Array(buf)
  }
  const columns = collectColumns(rows)
  const columnData = columns.map((name) => {
    const data = rows.map((r) => toParquetCell(r[name]))
    return { name, data, type: inferParquetType(data) as "STRING" | "DOUBLE" | "BOOLEAN" }
  })
  const buf = parquetWriteBuffer({ columnData })
  return new Uint8Array(buf)
}

function normalizeParquetRow(obj: Record<string, unknown>): Row {
  const row: Row = {}
  for (const [key, value] of Object.entries(obj)) {
    row[key] = toMovementValue(value)
  }
  return row
}

function toMovementValue(value: unknown): MovementValue {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : String(value)
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toMovementValue)
  if (typeof value === "object") {
    const out: { [key: string]: MovementValue } = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toMovementValue(v)
    }
    return out
  }
  return String(value)
}

function collectColumns(rows: readonly Row[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        order.push(key)
      }
    }
  }
  return order
}

function toParquetCell(value: MovementValue | undefined): string | number | boolean | bigint | null {
  if (value === undefined || value === null) return null
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function inferParquetType(
  data: readonly (string | number | boolean | bigint | null)[],
): "STRING" | "DOUBLE" | "BOOLEAN" {
  let sawBool = false
  let sawNumber = false
  for (const v of data) {
    if (v === null) continue
    if (typeof v === "boolean") {
      sawBool = true
      continue
    }
    if (typeof v === "number" || typeof v === "bigint") {
      sawNumber = true
      continue
    }
    return "STRING"
  }
  if (sawNumber && !sawBool) return "DOUBLE"
  if (sawBool && !sawNumber) return "BOOLEAN"
  return "STRING"
}

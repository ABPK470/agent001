/**
 * file-formats.ts — shared CSV/JSON/Parquet decode for file adapters.
 */

import type { FileFormat, Row } from "@mia/shared-types"
import { parseParquet } from "../parquet.js"
import { parseCsv } from "./webhdfs.js"

export async function decodeFileRows(format: FileFormat, bytes: Uint8Array): Promise<Row[]> {
  if (format === "parquet") return parseParquet(bytes)
  const text = new TextDecoder().decode(bytes)
  if (format === "csv") return parseCsv(text)
  return parseJsonArray(text)
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

/**
 * Evaluation dataset — golden trace steps for regression / eval runs.
 */

import { randomUUID } from "node:crypto"
import { getDb } from "../connection.js"

export type DbEvalDatasetEntry = {
  id: string
  thread_id: string | null
  run_id: string
  scope_id: string
  kind: string
  call_index: number | null
  label: string | null
  input_json: string
  output_json: string | null
  metadata_json: string | null
  created_by: string
  created_at: string
}

export type InsertEvalDatasetInput = {
  threadId?: string | null
  runId: string
  scopeId: string
  kind: string
  callIndex?: number | null
  label?: string | null
  input: unknown
  output?: unknown
  metadata?: Record<string, unknown>
  createdBy: string
}

export function insertEvalDatasetEntry(input: InsertEvalDatasetInput): DbEvalDatasetEntry {
  const id = randomUUID()
  const created_at = new Date().toISOString()
  const row: DbEvalDatasetEntry = {
    id,
    thread_id: input.threadId ?? null,
    run_id: input.runId,
    scope_id: input.scopeId,
    kind: input.kind,
    call_index: input.callIndex ?? null,
    label: input.label ?? null,
    input_json: JSON.stringify(input.input),
    output_json: input.output != null ? JSON.stringify(input.output) : null,
    metadata_json: input.metadata != null ? JSON.stringify(input.metadata) : null,
    created_by: input.createdBy,
    created_at,
  }
  getDb()
    .prepare(
      `INSERT INTO eval_dataset_entries (
        id, thread_id, run_id, scope_id, kind, call_index, label,
        input_json, output_json, metadata_json, created_by, created_at
      ) VALUES (
        @id, @thread_id, @run_id, @scope_id, @kind, @call_index, @label,
        @input_json, @output_json, @metadata_json, @created_by, @created_at
      )`,
    )
    .run(row)
  return row
}

export function listEvalDatasetEntries(filters?: {
  runId?: string
  threadId?: string
  limit?: number
}): DbEvalDatasetEntry[] {
  const limit = filters?.limit ?? 200
  if (filters?.runId) {
    return getDb()
      .prepare(
        "SELECT * FROM eval_dataset_entries WHERE run_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(filters.runId, limit) as DbEvalDatasetEntry[]
  }
  if (filters?.threadId) {
    return getDb()
      .prepare(
        "SELECT * FROM eval_dataset_entries WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(filters.threadId, limit) as DbEvalDatasetEntry[]
  }
  return getDb()
    .prepare("SELECT * FROM eval_dataset_entries ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbEvalDatasetEntry[]
}

export function getEvalDatasetEntry(id: string): DbEvalDatasetEntry | undefined {
  return getDb()
    .prepare("SELECT * FROM eval_dataset_entries WHERE id = ?")
    .get(id) as DbEvalDatasetEntry | undefined
}

export function deleteEvalDatasetEntry(id: string): boolean {
  const result = getDb().prepare("DELETE FROM eval_dataset_entries WHERE id = ?").run(id)
  return result.changes > 0
}

export function evalEntryToWire(row: DbEvalDatasetEntry) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    scopeId: row.scope_id,
    kind: row.kind,
    callIndex: row.call_index,
    label: row.label,
    input: JSON.parse(row.input_json) as unknown,
    output: row.output_json != null ? (JSON.parse(row.output_json) as unknown) : null,
    metadata:
      row.metadata_json != null
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

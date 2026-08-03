/**
 * Evaluation dataset — golden trace steps for regression / eval runs.
 */

import { randomUUID } from "node:crypto"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runChanges, runExec, runGet } from "../../../schema/execute.js"

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
  const compiled = getPlatformDb().insertInto("eval_dataset_entries").values(row).compile()
  runExec(compiled)
  return row
}

export function listEvalDatasetEntries(filters?: {
  runId?: string
  threadId?: string
  limit?: number
}): DbEvalDatasetEntry[] {
  const limit = filters?.limit ?? 200
  let query = getPlatformDb().selectFrom("eval_dataset_entries").selectAll()
  if (filters?.runId) {
    query = query.where("run_id", "=", filters.runId)
  } else if (filters?.threadId) {
    query = query.where("thread_id", "=", filters.threadId)
  }
  const compiled = query.orderBy("created_at", "desc").limit(limit).compile()
  return runAll<DbEvalDatasetEntry>(compiled)
}

export function getEvalDatasetEntry(id: string): DbEvalDatasetEntry | undefined {
  const compiled = getPlatformDb()
    .selectFrom("eval_dataset_entries")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbEvalDatasetEntry>(compiled)
}

export function deleteEvalDatasetEntry(id: string): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("eval_dataset_entries")
    .where("id", "=", id)
    .compile()
  return runChanges(compiled) > 0
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

/**
 * Attachment metadata repository.
 *
 * Thin wrapper over the `attachments`, `attachment_tags`, and
 * `attachment_imports` tables. Pure persistence: no policy decisions,
 * no storage I/O. Storage lives in {@link ./storage}, policy lives in
 * the engine, and the API/route layer composes them.
 */

import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import {
  AttachmentImportMode,
  AttachmentIngestionMode,
  AttachmentScope,
  AttachmentSource,
  AttachmentStatus
} from "../../../../../internal/enums/attachments.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

export { AttachmentImportMode, AttachmentIngestionMode, AttachmentScope, AttachmentSource, AttachmentStatus }

export interface AttachmentRow {
  id: string
  scope: AttachmentScope
  run_id: string | null
  owner_upn: string | null
  original_name: string
  normalized_name: string
  media_type: string
  size_bytes: number
  content_hash: string
  storage_uri: string
  text_extract_uri: string | null
  ingestion_mode: AttachmentIngestionMode
  status: AttachmentStatus
  source: AttachmentSource
  purpose_tag: string | null
  goal_snapshot: string | null
  uploaded_at: string
  processed_at: string | null
  retention_until: string | null
}

export interface AttachmentTagRow {
  attachment_id: string
  tag_key: string
  tag_value: string
}

export interface AttachmentImportRow {
  id: string
  attachment_id: string
  run_id: string
  sandbox_path: string
  import_mode: AttachmentImportMode
  imported_at: string
  imported_by_tool_call: string | null
}

export interface CreateAttachmentInput {
  scope: AttachmentScope
  runId?: string | null
  ownerUpn?: string | null
  originalName: string
  normalizedName: string
  mediaType: string
  sizeBytes: number
  contentHash: string
  storageUri: string
  textExtractUri?: string | null
  ingestionMode: AttachmentIngestionMode
  source?: AttachmentSource
  purposeTag?: string | null
  goalSnapshot?: string | null
  retentionUntil?: string | null
}

export function insertAttachment(input: CreateAttachmentInput): AttachmentRow {
  const id = randomUUID()
  const uploadedAt = new Date().toISOString()
  const insert = getPlatformDb()
    .insertInto("attachments")
    .values({
      id,
      scope: input.scope,
      run_id: input.runId ?? null,
      owner_upn: input.ownerUpn ?? null,
      original_name: input.originalName,
      normalized_name: input.normalizedName,
      media_type: input.mediaType,
      size_bytes: input.sizeBytes,
      content_hash: input.contentHash,
      storage_uri: input.storageUri,
      text_extract_uri: input.textExtractUri ?? null,
      ingestion_mode: input.ingestionMode,
      status: AttachmentStatus.Uploaded,
      source: input.source ?? AttachmentSource.UserUpload,
      purpose_tag: input.purposeTag ?? null,
      goal_snapshot: input.goalSnapshot ?? null,
      uploaded_at: uploadedAt,
      processed_at: null,
      retention_until: input.retentionUntil ?? null,
    })
    .compile()
  runExec(insert)
  const row = getAttachmentIncludingDeleted(id)
  if (!row) throw new Error(`attachment insert failed: ${id}`)
  return row
}

function getAttachmentIncludingDeleted(id: string): AttachmentRow | undefined {
  const compiled = getPlatformDb()
    .selectFrom("attachments")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<AttachmentRow>(compiled)
}

export function getAttachment(id: string): AttachmentRow | undefined {
  const compiled = getPlatformDb()
    .selectFrom("attachments")
    .selectAll()
    .where("id", "=", id)
    .where("status", "!=", AttachmentStatus.Deleted)
    .compile()
  return runGet<AttachmentRow>(compiled)
}

export interface ListAttachmentsFilter {
  scope?: AttachmentScope
  runId?: string
  ownerUpn?: string
  /** Substring search over original_name / normalized_name / purpose_tag. */
  q?: string
}

export function listAttachments(filter: ListAttachmentsFilter = {}): AttachmentRow[] {
  let q = getPlatformDb()
    .selectFrom("attachments")
    .selectAll()
    .where("status", "!=", AttachmentStatus.Deleted)
  if (filter.scope) q = q.where("scope", "=", filter.scope)
  if (filter.runId) q = q.where("run_id", "=", filter.runId)
  if (filter.ownerUpn) q = q.where("owner_upn", "=", filter.ownerUpn)
  if (filter.q) {
    const like = `%${filter.q}%`
    q = q.where((eb) =>
      eb.or([
        eb("original_name", "like", like),
        eb("normalized_name", "like", like),
        eb(sql`coalesce(purpose_tag, '')`, "like", like),
      ]),
    )
  }
  const compiled = q.orderBy("uploaded_at", "desc").compile()
  return runAll<AttachmentRow>(compiled)
}

export function softDeleteAttachment(id: string): void {
  const compiled = getPlatformDb()
    .updateTable("attachments")
    .set({ status: AttachmentStatus.Deleted })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function markAttachmentProcessed(id: string, textExtractUri: string | null): void {
  const processedAt = new Date().toISOString()
  const compiled =
    textExtractUri === null
      ? getPlatformDb()
          .updateTable("attachments")
          .set({
            status: AttachmentStatus.Processed,
            processed_at: processedAt,
          })
          .where("id", "=", id)
          .compile()
      : getPlatformDb()
          .updateTable("attachments")
          .set({
            status: AttachmentStatus.Processed,
            text_extract_uri: textExtractUri,
            processed_at: processedAt,
          })
          .where("id", "=", id)
          .compile()
  runExec(compiled)
}

// ── Tags ───────────────────────────────────────────────────────────

export function addAttachmentTag(attachmentId: string, key: string, value: string): void {
  const compiled = getPlatformDb()
    .insertInto("attachment_tags")
    .values({
      attachment_id: attachmentId,
      tag_key: key,
      tag_value: value,
    })
    .onConflict((oc) => oc.columns(["attachment_id", "tag_key", "tag_value"]).doNothing())
    .compile()
  runExec(compiled)
}

export function listAttachmentTags(attachmentId: string): AttachmentTagRow[] {
  const compiled = getPlatformDb()
    .selectFrom("attachment_tags")
    .selectAll()
    .where("attachment_id", "=", attachmentId)
    .compile()
  return runAll<AttachmentTagRow>(compiled)
}

// ── Imports ────────────────────────────────────────────────────────

export interface RecordImportInput {
  attachmentId: string
  runId: string
  sandboxPath: string
  importMode: AttachmentImportMode
  importedByToolCall?: string | null
}

export function recordAttachmentImport(input: RecordImportInput): AttachmentImportRow {
  const id = randomUUID()
  const importedAt = new Date().toISOString()
  const insert = getPlatformDb()
    .insertInto("attachment_imports")
    .values({
      id,
      attachment_id: input.attachmentId,
      run_id: input.runId,
      sandbox_path: input.sandboxPath,
      import_mode: input.importMode,
      imported_at: importedAt,
      imported_by_tool_call: input.importedByToolCall ?? null,
    })
    .compile()
  runExec(insert)
  const compiled = getPlatformDb()
    .selectFrom("attachment_imports")
    .selectAll()
    .where("id", "=", id)
    .compile()
  const row = runGet<AttachmentImportRow>(compiled)
  if (!row) throw new Error(`attachment import insert failed: ${id}`)
  return row
}

export function listAttachmentImports(runId: string): AttachmentImportRow[] {
  const compiled = getPlatformDb()
    .selectFrom("attachment_imports")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("imported_at", "desc")
    .compile()
  return runAll<AttachmentImportRow>(compiled)
}

/**
 * Attachment metadata repository.
 *
 * Thin wrapper over the `attachments`, `attachment_tags`, and
 * `attachment_imports` tables. Pure persistence: no policy decisions,
 * no storage I/O. Storage lives in {@link ./storage}, policy lives in
 * the engine, and the API/route layer composes them.
 */

import type Database from "better-sqlite3"
import { randomUUID } from "node:crypto"
import {
  AttachmentImportMode,
  AttachmentIngestionMode,
  AttachmentScope,
  AttachmentSource,
  AttachmentStatus
} from "../../../enums/attachments.js"
import { getDb } from "../db-connection.js"

export { AttachmentImportMode, AttachmentIngestionMode, AttachmentScope, AttachmentSource, AttachmentStatus }

export interface AttachmentRow {
  id: string
  scope: AttachmentScope
  run_id: string | null
  session_id: string | null
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
  sessionId?: string | null
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

function db(): Database.Database {
  return getDb()
}

export function insertAttachment(input: CreateAttachmentInput): AttachmentRow {
  const id = randomUUID()
  const uploadedAt = new Date().toISOString()
  db()
    .prepare(
      `
    INSERT INTO attachments (
      id, scope, run_id, session_id, owner_upn,
      original_name, normalized_name, media_type, size_bytes, content_hash,
      storage_uri, text_extract_uri, ingestion_mode, status, source,
      purpose_tag, goal_snapshot, uploaded_at, retention_until
    ) VALUES (
      @id, @scope, @runId, @sessionId, @ownerUpn,
      @originalName, @normalizedName, @mediaType, @sizeBytes, @contentHash,
      @storageUri, @textExtractUri, @ingestionMode, 'uploaded', @source,
      @purposeTag, @goalSnapshot, @uploadedAt, @retentionUntil
    )
  `
    )
    .run({
      id,
      scope: input.scope,
      runId: input.runId ?? null,
      sessionId: input.sessionId ?? null,
      ownerUpn: input.ownerUpn ?? null,
      originalName: input.originalName,
      normalizedName: input.normalizedName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
      storageUri: input.storageUri,
      textExtractUri: input.textExtractUri ?? null,
      ingestionMode: input.ingestionMode,
      source: input.source ?? AttachmentSource.UserUpload,
      purposeTag: input.purposeTag ?? null,
      goalSnapshot: input.goalSnapshot ?? null,
      uploadedAt,
      retentionUntil: input.retentionUntil ?? null
    })
  const row = db().prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow
  return row
}

export function getAttachment(id: string): AttachmentRow | undefined {
  return db().prepare("SELECT * FROM attachments WHERE id = ? AND status != 'deleted'").get(id) as
    | AttachmentRow
    | undefined
}

export interface ListAttachmentsFilter {
  scope?: AttachmentScope
  runId?: string
  sessionId?: string
  ownerUpn?: string
  /** Substring search over original_name / normalized_name / purpose_tag. */
  q?: string
}

export function listAttachments(filter: ListAttachmentsFilter = {}): AttachmentRow[] {
  const where: string[] = ["status != 'deleted'"]
  const params: Record<string, unknown> = {}
  if (filter.scope) {
    where.push("scope = @scope")
    params["scope"] = filter.scope
  }
  if (filter.runId) {
    where.push("run_id = @runId")
    params["runId"] = filter.runId
  }
  if (filter.sessionId) {
    where.push("session_id = @sessionId")
    params["sessionId"] = filter.sessionId
  }
  if (filter.ownerUpn) {
    where.push("owner_upn = @ownerUpn")
    params["ownerUpn"] = filter.ownerUpn
  }
  if (filter.q) {
    where.push("(original_name LIKE @q OR normalized_name LIKE @q OR COALESCE(purpose_tag, '') LIKE @q)")
    params["q"] = `%${filter.q}%`
  }
  const sql = `SELECT * FROM attachments WHERE ${where.join(" AND ")} ORDER BY uploaded_at DESC, rowid DESC`
  return db().prepare(sql).all(params) as AttachmentRow[]
}

export function softDeleteAttachment(id: string): void {
  db().prepare("UPDATE attachments SET status = 'deleted' WHERE id = ?").run(id)
}

export function markAttachmentProcessed(id: string, textExtractUri: string | null): void {
  db()
    .prepare(
      `
    UPDATE attachments
       SET status = 'processed',
           text_extract_uri = COALESCE(@textExtractUri, text_extract_uri),
           processed_at = @now
     WHERE id = @id
  `
    )
    .run({ id, textExtractUri, now: new Date().toISOString() })
}

// ── Tags ───────────────────────────────────────────────────────────

export function addAttachmentTag(attachmentId: string, key: string, value: string): void {
  db()
    .prepare(
      `
    INSERT OR IGNORE INTO attachment_tags (attachment_id, tag_key, tag_value)
    VALUES (?, ?, ?)
  `
    )
    .run(attachmentId, key, value)
}

export function listAttachmentTags(attachmentId: string): AttachmentTagRow[] {
  return db()
    .prepare("SELECT * FROM attachment_tags WHERE attachment_id = ?")
    .all(attachmentId) as AttachmentTagRow[]
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
  db()
    .prepare(
      `
    INSERT INTO attachment_imports (
      id, attachment_id, run_id, sandbox_path, import_mode, imported_at, imported_by_tool_call
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      id,
      input.attachmentId,
      input.runId,
      input.sandboxPath,
      input.importMode,
      new Date().toISOString(),
      input.importedByToolCall ?? null
    )
  return db().prepare("SELECT * FROM attachment_imports WHERE id = ?").get(id) as AttachmentImportRow
}

export function listAttachmentImports(runId: string): AttachmentImportRow[] {
  return db()
    .prepare("SELECT * FROM attachment_imports WHERE run_id = ? ORDER BY imported_at DESC")
    .all(runId) as AttachmentImportRow[]
}

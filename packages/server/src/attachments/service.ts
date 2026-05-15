/**
 * Attachment service — small façade that composes the metadata repo with
 * content-addressed blob storage. Routes and tools call this layer; they
 * do not touch storage or SQL directly.
 */

import { basename, extname } from "node:path"
import { AttachmentIngestionMode } from "../enums/attachments.js"
import { auditAttachmentUploaded } from "./audit.js"
import { assertOwnerQuota, computeRetentionUntil } from "./lifecycle.js"
import {
    addAttachmentTag,
    insertAttachment,
    type AttachmentRow,
    type AttachmentScope,
    type AttachmentSource,
} from "./repo.js"
import { writeAttachmentBlob } from "./storage.js"

export interface UploadAttachmentInput {
  bytes:         Uint8Array
  originalName:  string
  mediaType:     string
  scope:         AttachmentScope
  runId?:        string | null
  sessionId?:    string | null
  ownerUpn?:     string | null
  purposeTag?:   string | null
  goalSnapshot?: string | null
  source?:       AttachmentSource
  tags?:         Array<{ key: string; value: string }>
  /**
   * Override default ingestion mode. Defaults are inferred from media type:
   *   text/* | application/json | application/csv → text_retrieval
   *   everything else                              → binary_reference
   */
  ingestionMode?: AttachmentIngestionMode
}

const TEXT_LIKE_PREFIXES = ["text/"]
const TEXT_LIKE_TYPES = new Set([
  "application/json",
  "application/csv",
  "application/xml",
  "application/x-yaml",
])

export function inferIngestionMode(mediaType: string): AttachmentIngestionMode {
  if (TEXT_LIKE_PREFIXES.some((p) => mediaType.startsWith(p)) || TEXT_LIKE_TYPES.has(mediaType)) {
    return AttachmentIngestionMode.TextRetrieval
  }
  return AttachmentIngestionMode.BinaryReference
}

/**
 * Strip directory components and unsafe characters from a user-supplied
 * filename. Preserves a single extension. The original name remains in
 * the metadata record; this is for sandbox-safe display and import.
 */
export function normalizeName(originalName: string): string {
  const baseName = basename(originalName)
  const ext = extname(baseName).toLowerCase()
  const stem = baseName.slice(0, baseName.length - ext.length)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100)
  const safeStem = /[A-Za-z0-9]/.test(stem) ? stem : "attachment"
  const safeExt = ext.replace(/[^A-Za-z0-9.]/g, "").slice(0, 16)
  return /[A-Za-z0-9]/.test(safeExt) ? `${safeStem}${safeExt}` : safeStem
}

export async function uploadAttachment(input: UploadAttachmentInput): Promise<AttachmentRow> {
  // Quota check first so we don't write the blob just to reject the row.
  // Owner-less uploads (legacy / service runs) are exempt.
  assertOwnerQuota(input.ownerUpn ?? null, input.bytes.byteLength)
  const blob = await writeAttachmentBlob(input.bytes)
  const ingestionMode = input.ingestionMode ?? inferIngestionMode(input.mediaType)
  const row = insertAttachment({
    scope:          input.scope,
    runId:          input.runId,
    sessionId:      input.sessionId,
    ownerUpn:       input.ownerUpn,
    originalName:   input.originalName,
    normalizedName: normalizeName(input.originalName),
    mediaType:      input.mediaType,
    sizeBytes:      blob.sizeBytes,
    contentHash:    blob.hash,
    storageUri:     blob.storageUri,
    ingestionMode,
    source:         input.source,
    purposeTag:     input.purposeTag,
    goalSnapshot:   input.goalSnapshot,
    // Apply scope-aware retention so a long-running deployment does not
    // accumulate stale rows. Operators tune via env (see lifecycle.ts).
    retentionUntil: computeRetentionUntil(input.scope),
  })
  for (const tag of input.tags ?? []) addAttachmentTag(row.id, tag.key, tag.value)
  auditAttachmentUploaded(row)
  return row
}

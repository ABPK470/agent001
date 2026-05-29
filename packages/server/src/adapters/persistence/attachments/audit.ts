/**
 * Attachment audit events.
 *
 * Single helper used by service / agent-service / routes so the schema
 * of `attachment.*` events is defined in one place. Events are persisted
 * via the existing event broadcaster (event_log table) and surface in
 * the operations log UI alongside run/tool events.
 *
 * Event taxonomy:
 *   attachment.uploaded   bytes accepted into the durable store
 *   attachment.imported   copy materialised inside a sandbox
 *   attachment.promoted   sandbox file promoted back into the store
 *   attachment.deleted    soft-delete (user action or retention prune)
 *
 * Payloads stay small and serialisable — file bytes never appear here.
 */

import { broadcast } from "../../../event-broadcaster.js"
import type { AttachmentRow } from "./repo.js"
import { EventType } from "@mia/agent"

function payloadFor(row: AttachmentRow): Record<string, unknown> {
  return {
    id:             row.id,
    scope:          row.scope,
    ownerUpn:       row.owner_upn,
    runId:          row.run_id,
    sessionId:      row.session_id,
    sizeBytes:      row.size_bytes,
    mediaType:      row.media_type,
    source:         row.source,
    normalizedName: row.normalized_name,
  }
}

export function auditAttachmentUploaded(row: AttachmentRow): void {
  broadcast({ type: EventType.AttachmentUploaded, data: payloadFor(row) })
}

export function auditAttachmentImported(row: AttachmentRow, sandboxPath: string): void {
  broadcast({
    type: EventType.AttachmentImported,
    data: { ...payloadFor(row), sandboxPath },
  })
}

export function auditAttachmentPromoted(row: AttachmentRow): void {
  broadcast({ type: EventType.AttachmentPromoted, data: payloadFor(row) })
}

export function auditAttachmentDeleted(opts: {
  id: string
  ownerUpn: string | null
  reason: "user" | "retention"
}): void {
  broadcast({
    type: EventType.AttachmentDeleted,
    data: { id: opts.id, ownerUpn: opts.ownerUpn, reason: opts.reason },
  })
}

export function auditAttachmentsPruned(count: number): void {
  if (count <= 0) return
  broadcast({ type: EventType.AttachmentPruned, data: { count } })
}

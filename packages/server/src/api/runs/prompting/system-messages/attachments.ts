/**
 * One-line metadata list of files the user attached to this run.
 * Bytes stay out of the prompt — the agent uses attachment tools to read them.
 */

import { getAttachment, type AttachmentRow } from "../../../../infra/persistence/attachments.js"

export function buildAttachmentManifest(ids: string[]): string {
  if (ids.length === 0) return ""
  const rows: AttachmentRow[] = []
  for (const id of ids) {
    const row = getAttachment(id)
    if (row) rows.push(row)
  }
  if (rows.length === 0) return ""
  const header = "Attached files for this run (use attachment tools to inspect or import):"
  const lines = rows.map(
    (r) =>
      `  - id=${r.id}  name=${r.normalized_name}  type=${r.media_type}  size=${r.size_bytes}B  mode=${r.ingestion_mode}`
  )
  return [header, ...lines].join("\n")
}

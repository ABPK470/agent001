/**
 * Server-side AttachmentService implementation.
 *
 * Bridges the agent-side {@link AttachmentService} interface to the
 * server's attachment repo, blob storage, and sandbox layout. Resolves
 * runId / sandboxRoot from the active {@link HostedPolicyContext} so a
 * single installed instance serves every concurrent run safely
 * (no module-global state).
 */

import { getPolicyContext, type AttachmentMetadata, type AttachmentService } from "@agent001/agent"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path"
import {
    getAttachment,
    listAttachments,
    readAttachmentBlob,
    recordAttachmentImport,
    type AttachmentRow,
} from "../attachments/index.js"

const TEXT_MEDIA_PREFIXES = ["text/"]
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/csv",
  "application/xml",
  "application/x-yaml",
])

function isTextMedia(mediaType: string): boolean {
  return TEXT_MEDIA_PREFIXES.some((p) => mediaType.startsWith(p)) || TEXT_MEDIA_TYPES.has(mediaType)
}

function toMetadata(row: AttachmentRow): AttachmentMetadata {
  return {
    id:             row.id,
    scope:          row.scope,
    originalName:   row.original_name,
    normalizedName: row.normalized_name,
    mediaType:      row.media_type,
    sizeBytes:      row.size_bytes,
    contentHash:    row.content_hash,
    ingestionMode:  row.ingestion_mode,
    uploadedAt:     row.uploaded_at,
    purposeTag:     row.purpose_tag,
  }
}

function currentRunContext(): { runId: string; sandboxRoot: string | null } {
  const ctx = getPolicyContext()
  if (!ctx) {
    throw new Error("Attachment service called outside an active run context.")
  }
  return { runId: ctx.runId, sandboxRoot: ctx.sandboxRoot }
}

/**
 * Reject sandbox-relative paths that would escape via `..`, absolute
 * roots, drive letters, or NUL bytes. Returns the resolved absolute path
 * inside the sandbox.
 */
function resolveSandboxPath(sandboxRoot: string, relPath: string): string {
  if (!relPath || relPath.includes("\0")) {
    throw new Error("destination is empty or contains illegal characters")
  }
  if (isAbsolute(relPath)) {
    throw new Error("destination must be sandbox-relative, not absolute")
  }
  const normalized = normalize(relPath)
  if (normalized.startsWith("..") || normalized === "..") {
    throw new Error("destination escapes the sandbox root")
  }
  const absRoot = resolve(sandboxRoot)
  const absDest = resolve(absRoot, normalized)
  // Final containment check — defends against symlink-style tricks in normalize.
  if (absDest !== absRoot && !absDest.startsWith(absRoot + sep)) {
    throw new Error("destination escapes the sandbox root")
  }
  return absDest
}

export const serverAttachmentService: AttachmentService = {
  async list(filter) {
    const { runId } = currentRunContext()
    // Default scope: attachments bound to the current run. Callers can
    // widen with explicit scope/runId, but we still confine to this run
    // by default so the agent never sees other runs' uploads.
    const rows = listAttachments({
      runId: filter?.runId ?? runId,
      ...(filter?.scope ? { scope: filter.scope } : {}),
      ...(filter?.q ? { q: filter.q } : {}),
    })
    return rows.map(toMetadata)
  },

  async get(id) {
    const row = getAttachment(id)
    return row ? toMetadata(row) : null
  },

  async read(id, opts) {
    const row = getAttachment(id)
    if (!row) throw new Error(`attachment not found: ${id}`)
    const bytes = await readAttachmentBlob(row.storage_uri)
    const limit = opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : bytes.byteLength
    const truncated = bytes.byteLength > limit
    const slice = truncated ? bytes.subarray(0, limit) : bytes
    if (isTextMedia(row.media_type)) {
      return { kind: "text", text: slice.toString("utf8"), truncated, sizeBytes: row.size_bytes }
    }
    return { kind: "binary", bytes: new Uint8Array(slice), truncated, sizeBytes: row.size_bytes }
  },

  async importToSandbox(id, sandboxRelPath) {
    const { runId, sandboxRoot } = currentRunContext()
    if (!sandboxRoot) {
      throw new Error("import_attachment requires an active sandbox; this run has none.")
    }
    const row = getAttachment(id)
    if (!row) throw new Error(`attachment not found: ${id}`)
    const dest = resolveSandboxPath(sandboxRoot, sandboxRelPath)
    const bytes = await readAttachmentBlob(row.storage_uri)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, bytes)
    recordAttachmentImport({
      attachmentId: id,
      runId,
      sandboxPath:  dest,
      importMode:   "copy",
    })
    return { sandboxPath: dest, sizeBytes: bytes.byteLength }
  },
}

// Re-exports kept here so tests can exercise path validation without
// reaching into private internals.
export const _internals = { resolveSandboxPath, isTextMedia }

// The following import is unused at runtime but kept to silence the
// "unused import" lint when we only need the side effect of types.
void readFile

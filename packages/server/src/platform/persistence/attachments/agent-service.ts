/**
 * Server-side AttachmentService implementation.
 *
 * Bridges the agent-side {@link AttachmentService} interface to the
 * server's attachment repo, blob storage, and sandbox layout. The server
 * binds per-run identity / sandbox facts explicitly when it constructs the
 * service instance used by a run.
 */

import { type AttachmentMetadata, type AttachmentService, type HostedPolicyContext } from "@mia/agent"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, normalize, resolve, sep } from "node:path"
import {
  getAttachment,
  listAttachments,
  readAttachmentBlob,
  recordAttachmentImport,
  uploadAttachment,
  type AttachmentRow
} from "./index.js"
import { AttachmentImportMode, AttachmentScope, AttachmentSource } from "../../../shared/enums/attachments.js"
import { auditAttachmentImported, auditAttachmentPromoted } from "./audit.js"

const TEXT_MEDIA_PREFIXES = ["text/"]
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/csv",
  "application/xml",
  "application/x-yaml"
])

function isTextMedia(mediaType: string): boolean {
  return TEXT_MEDIA_PREFIXES.some((p) => mediaType.startsWith(p)) || TEXT_MEDIA_TYPES.has(mediaType)
}

/**
 * Best-effort MIME guess from a filename extension. Conservative: anything
 * we don't recognise is reported as application/octet-stream so the
 * attachment store treats it as a binary reference, never inlining it.
 * The agent / operator can override the type explicitly via the tool.
 */
const EXT_MIME: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".html": "text/html",
  ".log": "text/plain",
  ".sql": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip"
}

function guessMediaType(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] ?? "application/octet-stream"
}

function toMetadata(row: AttachmentRow): AttachmentMetadata {
  return {
    id: row.id,
    scope: row.scope,
    originalName: row.original_name,
    normalizedName: row.normalized_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    ingestionMode: row.ingestion_mode,
    uploadedAt: row.uploaded_at,
    purposeTag: row.purpose_tag
  }
}

type AttachmentServiceContext = Pick<HostedPolicyContext, "runId" | "sandboxRoot" | "actorUpn">

function resolveContext(
  getContext: () => AttachmentServiceContext | null | undefined
): AttachmentServiceContext {
  const ctx = getContext()
  if (!ctx) {
    throw new Error("Attachment service called outside an active run context.")
  }
  return ctx
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

export function createServerAttachmentService(
  getContext: () => AttachmentServiceContext | null | undefined
): AttachmentService {
  return {
    async list(filter) {
      const ctx = resolveContext(getContext)
      const { runId } = ctx
      // Visibility model: the agent should see anything the user could
      // reasonably have attached to this run — items explicitly bound to
      // Items bound to this run plus any user_draft uploads the owner staged pre-run.
      const baseFilter: { scope?: AttachmentRow["scope"]; q?: string } = {
        ...(filter?.scope ? { scope: filter.scope } : {}),
        ...(filter?.q ? { q: filter.q } : {})
      }
      const explicitRunId = filter?.runId ?? runId
      const branches: Parameters<typeof listAttachments>[0][] = [{ ...baseFilter, runId: explicitRunId }]
      if (ctx?.actorUpn) branches.push({ ...baseFilter, ownerUpn: ctx.actorUpn })
      const seen = new Set<string>()
      const merged: AttachmentRow[] = []
      for (const b of branches) {
        for (const r of listAttachments(b)) {
          if (seen.has(r.id)) continue
          seen.add(r.id)
          merged.push(r)
        }
      }
      return merged.map(toMetadata)
    },

    async get(id) {
      const row = getAttachment(id)
      return row ? toMetadata(row) : null
    },

    async read(id, opts) {
      const row = getAttachment(id)
      if (!row) throw new Error(`attachment not found: ${id}`)
      const bytes = await readAttachmentBlob(row.storage_uri)
      const offset = Math.max(0, Math.min(opts?.offset ?? 0, bytes.byteLength))
      const remaining = bytes.byteLength - offset
      const limit = opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : remaining
      const sliceLen = Math.min(remaining, limit)
      const slice = bytes.subarray(offset, offset + sliceLen)
      const nextOffset = offset + sliceLen < bytes.byteLength ? offset + sliceLen : null
      const truncated = nextOffset !== null
      if (isTextMedia(row.media_type)) {
        return {
          kind: "text",
          text: slice.toString("utf8"),
          truncated,
          sizeBytes: row.size_bytes,
          offset,
          nextOffset
        }
      }
      return {
        kind: "binary",
        bytes: new Uint8Array(slice),
        truncated,
        sizeBytes: row.size_bytes,
        offset,
        nextOffset
      }
    },

    async importToSandbox(id, sandboxRelPath) {
      const { runId, sandboxRoot } = resolveContext(getContext)
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
        sandboxPath: dest,
        importMode: AttachmentImportMode.Copy
      })
      auditAttachmentImported(row, dest)
      return { sandboxPath: dest, sizeBytes: bytes.byteLength }
    },

    async promoteFromSandbox(sandboxRelPath, opts) {
      const { runId, sandboxRoot, actorUpn } = resolveContext(getContext)
      if (!sandboxRoot) {
        throw new Error("promote_attachment requires an active sandbox; this run has none.")
      }
      // Same containment rules as importToSandbox: agents must not exfiltrate
      // arbitrary host files by promoting paths outside the sandbox.
      const absPath = resolveSandboxPath(sandboxRoot, sandboxRelPath)
      const bytes = await readFile(absPath)
      const row = await uploadAttachment({
        bytes,
        originalName: basename(absPath),
        mediaType: opts?.mediaType ?? guessMediaType(extname(absPath)),
        // Bind to the run that produced it, but keep the bytes around as a
        // workspace asset so the user can still access them after the run
        // finishes.
        scope: AttachmentScope.WorkspaceAsset,
        runId,
        ownerUpn: actorUpn ?? null,
        source: AttachmentSource.Generated,
        ...(opts?.purposeTag !== undefined ? { purposeTag: opts.purposeTag } : {})
      })
      auditAttachmentPromoted(row)
      return toMetadata(row)
    }
  }
}

export const serverAttachmentService: AttachmentService = createServerAttachmentService(() => null)

// Re-exports kept here so tests can exercise path validation without
// reaching into private internals.
export const _internals = { resolveSandboxPath, isTextMedia }

// The following import is unused at runtime but kept to silence the
// "unused import" lint when we only need the side effect of types.
void readFile

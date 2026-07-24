/**
 * Attachment transport — Personal. Scope from personal.read / personal.write.
 */

import type { FastifyInstance } from "fastify"
import { Buffer } from "node:buffer"
import {
  auditAttachmentDeleted,
  getAttachment,
  listAttachments,
  listAttachmentTags,
  QuotaExceededError,
  readAttachmentBlob,
  softDeleteAttachment,
  uploadAttachment,
  type AttachmentRow
} from "../../infra/persistence/attachments.js"
import { AttachmentScope, isAttachmentScope } from "../../internal/enums/attachments.js"
import { canAccessOwned, personal, viewingAsOf } from "../auth/service/viewing-as.js"

/** Accept legacy `session` uploads during API transition. */
function normalizeAttachmentScope(scope: unknown): AttachmentScope | null {
  if (scope === "session") return AttachmentScope.UserDraft
  return isAttachmentScope(scope) ? scope : null
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

interface UploadBody {
  name: string
  mediaType?: string
  contentBase64: string
  scope?: AttachmentScope
  runId?: string | null
  purposeTag?: string | null
  goalSnapshot?: string | null
  tags?: Array<{ key: string; value: string }>
}

function publicView(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    runId: row.run_id,
    ownerUpn: row.owner_upn,
    originalName: row.original_name,
    normalizedName: row.normalized_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    ingestionMode: row.ingestion_mode,
    status: row.status,
    source: row.source,
    purposeTag: row.purpose_tag,
    uploadedAt: row.uploaded_at,
    processedAt: row.processed_at,
    tags: listAttachmentTags(row.id).map((tag) => ({ key: tag.tag_key, value: tag.tag_value }))
  }
}

export function registerAttachmentRoutes(app: FastifyInstance): void {
  app.post<{ Body: UploadBody }>(
    "/api/attachments",
    { ...personal.write, bodyLimit: MAX_UPLOAD_BYTES + 64 * 1024 },
    async (req, reply) => {
      const { session } = viewingAsOf(req)
      const body = req.body
      if (!body || typeof body.name !== "string" || typeof body.contentBase64 !== "string") {
        reply.code(400)
        return { error: "name and contentBase64 are required" }
      }
      let bytes: Buffer
      try {
        bytes = Buffer.from(body.contentBase64, "base64")
      } catch {
        reply.code(400)
        return { error: "contentBase64 is not valid base64" }
      }
      if (bytes.byteLength === 0) {
        reply.code(400)
        return { error: "empty payload" }
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        reply.code(413)
        return { error: `payload exceeds ${MAX_UPLOAD_BYTES} bytes` }
      }
      const scope: AttachmentScope = normalizeAttachmentScope(body.scope) ?? AttachmentScope.UserDraft
      if (scope === "run" && !body.runId) {
        reply.code(400)
        return { error: "runId is required when scope === 'run'" }
      }
      try {
        const row = await uploadAttachment({
          bytes,
          originalName: body.name,
          mediaType: body.mediaType || "application/octet-stream",
          scope,
          runId: body.runId ?? null,
          ownerUpn: session.upn,
          purposeTag: body.purposeTag ?? null,
          goalSnapshot: body.goalSnapshot ?? null,
          tags: body.tags
        })
        reply.code(201)
        return publicView(row)
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          reply.code(413)
          return {
            error: "attachment quota exceeded",
            bytesUsed: error.bytesUsed,
            bytesQuota: error.bytesQuota,
            attemptBytes: error.attemptBytes
          }
        }
        throw error
      }
    }
  )

  app.get<{ Querystring: { scope?: AttachmentScope; runId?: string; q?: string } }>(
    "/api/attachments",
    personal.read,
    async (req) => {
      const { viewingAsUpn } = viewingAsOf(req)
      return listAttachments({
        scope: req.query.scope,
        runId: req.query.runId,
        q: req.query.q,
        ownerUpn: viewingAsUpn,
      }).map(publicView)
    }
  )

  app.get<{ Params: { id: string } }>("/api/attachments/:id", personal.read, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const row = getAttachment(req.params.id)
    if (!row || !canAccessOwned(viewingAs, row.owner_upn)) {
      reply.code(404)
      return { error: "attachment not found" }
    }
    return publicView(row)
  })

  app.get<{ Params: { id: string } }>("/api/attachments/:id/content", personal.read, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const row = getAttachment(req.params.id)
    if (!row || !canAccessOwned(viewingAs, row.owner_upn)) {
      reply.code(404)
      return { error: "attachment not found" }
    }
    const bytes = await readAttachmentBlob(row.storage_uri)
    reply.header("content-type", row.media_type || "application/octet-stream")
    reply.header("content-length", String(bytes.byteLength))
    reply.header("content-disposition", `attachment; filename="${row.normalized_name}"`)
    reply.header("x-attachment-hash", row.content_hash)
    return reply.send(bytes)
  })

  app.delete<{ Params: { id: string } }>("/api/attachments/:id", personal.write, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const row = getAttachment(req.params.id)
    if (!row || !canAccessOwned(viewingAs, row.owner_upn)) {
      reply.code(404)
      return { error: "attachment not found" }
    }
    softDeleteAttachment(row.id)
    auditAttachmentDeleted({ id: row.id, ownerUpn: row.owner_upn, reason: "user" })
    return { ok: true }
  })
}

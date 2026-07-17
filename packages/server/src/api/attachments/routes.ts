/**
 * Attachment transport routes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
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

function requireSession(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.session) {
    reply.code(401)
    reply.send({ error: "authentication required" })
    return false
  }
  return true
}

function canViewAttachment(req: FastifyRequest, row: AttachmentRow): boolean {
  if (!req.session) return false
  if (req.session.isAdmin) return true
  return !!(row.owner_upn && row.owner_upn === req.session.upn)
}

export function registerAttachmentRoutes(app: FastifyInstance): void {
  app.post<{ Body: UploadBody }>(
    "/api/attachments",
    { bodyLimit: MAX_UPLOAD_BYTES + 64 * 1024 },
    async (req, reply) => {
      if (!requireSession(req, reply)) return
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
          ownerUpn: req.session!.upn,
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
    async (req, reply) => {
      if (!requireSession(req, reply)) return
      const session = req.session!
      const filter = {
        scope: req.query.scope,
        runId: req.query.runId,
        q: req.query.q,
        ...(session.isAdmin ? {} : { ownerUpn: session.upn ?? undefined })
      }
      return listAttachments(filter).map(publicView)
    }
  )

  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (req, reply) => {
    if (!requireSession(req, reply)) return
    const row = getAttachment(req.params.id)
    if (!row) {
      reply.code(404)
      return { error: "attachment not found" }
    }
    if (!canViewAttachment(req, row)) {
      reply.code(403)
      return { error: "forbidden" }
    }
    return publicView(row)
  })

  app.get<{ Params: { id: string } }>("/api/attachments/:id/content", async (req, reply) => {
    if (!requireSession(req, reply)) return
    const row = getAttachment(req.params.id)
    if (!row) {
      reply.code(404)
      return { error: "attachment not found" }
    }
    if (!canViewAttachment(req, row)) {
      reply.code(403)
      return { error: "forbidden" }
    }
    const bytes = await readAttachmentBlob(row.storage_uri)
    reply.header("content-type", row.media_type || "application/octet-stream")
    reply.header("content-length", String(bytes.byteLength))
    reply.header("content-disposition", `attachment; filename="${row.normalized_name}"`)
    reply.header("x-attachment-hash", row.content_hash)
    return reply.send(bytes)
  })

  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (req, reply) => {
    if (!requireSession(req, reply)) return
    const row = getAttachment(req.params.id)
    if (!row) {
      reply.code(404)
      return { error: "attachment not found" }
    }
    if (!canViewAttachment(req, row)) {
      reply.code(403)
      return { error: "forbidden" }
    }
    softDeleteAttachment(row.id)
    auditAttachmentDeleted({ id: row.id, ownerUpn: row.owner_upn, reason: "user" })
    return { ok: true }
  })
}

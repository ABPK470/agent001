/**
 * Webhook routes — receive messages from WhatsApp and Messenger.
 *
 * Each platform has two endpoints:
 *   GET  /webhooks/:platform — verification (platform confirms our webhook URL)
 *   POST /webhooks/:platform — incoming messages + status updates
 *
 * Plus management endpoints:
 *   GET    /api/channels           — list configured channels
 *   POST   /api/channels           — register/update a channel
 *   DELETE /api/channels/:type     — remove a channel
 *   GET    /api/conversations      — list conversations
 *   GET    /api/messages/:convId   — message history for a conversation
 *   GET    /api/delivery/stats     — delivery statistics
 */

import type { FastifyInstance } from "fastify"
import {
  type ChannelType,
  type MessageRouter,
  deleteChannelConfig,
  getDeliveryStats,
  getOutboundMessages,
  listChannelConfigs,
  saveChannelConfig,
} from "../channels/index.js"

export function registerWebhookRoutes(app: FastifyInstance, router: MessageRouter): void {

  // ── Raw body capture for webhook signature validation ───────
  // Store raw bytes on the request so we can verify HMAC signatures.
  // Fastify normally only gives us the parsed JSON body.
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.url.startsWith("/webhooks/")) {
      const chunks: Buffer[] = []
      for await (const chunk of payload) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
      }
      const rawBody = Buffer.concat(chunks);
      (req as unknown as Record<string, unknown>).rawBody = rawBody
      // Return a new readable stream from the buffer for Fastify's parser
      const { Readable } = await import("node:stream")
      return Readable.from(rawBody)
    }
    return payload
  })

  // ── WhatsApp webhook verification ──────────────────────────

  app.get<{
    Querystring: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string }
  }>("/webhooks/whatsapp", async (req, reply) => {
    const mode = req.query["hub.mode"]
    const token = req.query["hub.verify_token"]
    const challenge = req.query["hub.challenge"]

    const config = listChannelConfigs().find((c) => c.type === "whatsapp")
    if (!config) {
      reply.code(404)
      return "WhatsApp channel not configured"
    }

    if (mode === "subscribe" && token === config.verifyToken) {
      return challenge ?? ""
    }

    reply.code(403)
    return "Forbidden"
  })

  // ── WhatsApp incoming webhook ──────────────────────────────

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const channel = router.getChannel("whatsapp")
    if (!channel) {
      reply.code(404)
      return { error: "WhatsApp channel not configured" }
    }

    // Validate signature
    const signature = req.headers["x-hub-signature-256"] as string | undefined
    if (!signature) {
      reply.code(401)
      return { error: "Missing signature" }
    }

    const rawBody = (req as unknown as Record<string, unknown>).rawBody as Buffer | undefined
    if (!rawBody || !channel.validateSignature(rawBody, signature)) {
      reply.code(401)
      return { error: "Invalid signature" }
    }

    // Parse and route messages
    const messages = channel.parseWebhook(req.body)
    const results = messages.map((msg) => router.handleInbound(msg))

    return { ok: true, processed: results.length }
  })

  // ── Messenger webhook verification ─────────────────────────

  app.get<{
    Querystring: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string }
  }>("/webhooks/messenger", async (req, reply) => {
    const mode = req.query["hub.mode"]
    const token = req.query["hub.verify_token"]
    const challenge = req.query["hub.challenge"]

    const config = listChannelConfigs().find((c) => c.type === "messenger")
    if (!config) {
      reply.code(404)
      return "Messenger channel not configured"
    }

    if (mode === "subscribe" && token === config.verifyToken) {
      return challenge ?? ""
    }

    reply.code(403)
    return "Forbidden"
  })

  // ── Messenger incoming webhook ─────────────────────────────

  app.post("/webhooks/messenger", async (req, reply) => {
    const channel = router.getChannel("messenger")
    if (!channel) {
      reply.code(404)
      return { error: "Messenger channel not configured" }
    }

    // Validate signature
    const signature = req.headers["x-hub-signature-256"] as string | undefined
    if (!signature) {
      reply.code(401)
      return { error: "Missing signature" }
    }

    const rawBody = (req as unknown as Record<string, unknown>).rawBody as Buffer | undefined
    if (!rawBody || !channel.validateSignature(rawBody, signature)) {
      reply.code(401)
      return { error: "Invalid signature" }
    }

    // Parse and route messages
    const messages = channel.parseWebhook(req.body)
    const results = messages.map((msg) => router.handleInbound(msg))

    return { ok: true, processed: results.length }
  })

  // ── Channel management API ─────────────────────────────────

  app.get("/api/channels", async () => {
    const configs = listChannelConfigs()
    return configs.map((c) => ({
      type: c.type,
      platformId: c.platformId,
      connected: !!router.getChannel(c.type),
    }))
  })

  app.post<{
    Body: {
      type: ChannelType
      accessToken: string
      verifyToken: string
      appSecret: string
      platformId: string
    }
  }>("/api/channels", async (req, reply) => {
    const { type, accessToken, verifyToken, appSecret, platformId } = req.body

    if (!type || !accessToken || !verifyToken || !appSecret || !platformId) {
      reply.code(400)
      return { error: "All fields required: type, accessToken, verifyToken, appSecret, platformId" }
    }

    if (type !== "whatsapp" && type !== "messenger") {
      reply.code(400)
      return { error: "type must be 'whatsapp' or 'messenger'" }
    }

    saveChannelConfig({ type, accessToken, verifyToken, appSecret, platformId })

    reply.code(201)
    return { ok: true, type }
  })

  app.delete<{ Params: { type: string } }>("/api/channels/:type", async (req, reply) => {
    const type = req.params.type as ChannelType
    if (type !== "whatsapp" && type !== "messenger") {
      reply.code(400)
      return { error: "Invalid channel type" }
    }

    deleteChannelConfig(type)
    return { ok: true }
  })

  // ── Conversations + messages API ───────────────────────────

  app.get("/api/conversations", async () => {
    return router.listConversations().map((c) => ({
      id: c.id,
      channelType: c.channelType,
      senderId: c.senderId,
      senderName: c.senderName,
      activeRunId: c.activeRunId,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  })

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => {
    const messages = getOutboundMessages(req.params.id)
    return messages.map((m) => ({
      id: m.id,
      channelType: m.channelType,
      recipientId: m.recipientId,
      text: m.text,
      status: m.status,
      attempts: m.attempts,
      lastError: m.lastError,
      createdAt: m.createdAt.toISOString(),
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
    }))
  })

  // ── Delivery stats ─────────────────────────────────────────

  app.get("/api/delivery/stats", async () => {
    return getDeliveryStats()
  })
}

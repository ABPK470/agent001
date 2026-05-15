/**
 * Webhook routes — receive and dispatch Microsoft Teams messages.
 *
 * Endpoints:
 *   POST /webhooks/teams          — incoming Bot Framework Activity from Teams
 *
 * Management endpoints:
 *   GET    /api/channels           — list configured channels
 *   POST   /api/channels           — register/update a channel
 *   DELETE /api/channels/:type     — remove a channel
 *   GET    /api/conversations      — list conversations
 *   GET    /api/messages/:convId   — message history for a conversation
 *   GET    /api/delivery/stats     — delivery statistics
 */

import type { FastifyInstance } from "fastify"
import { deleteChannelConfig, getDeliveryStats, getOutboundMessages, listChannelConfigs, saveChannelConfig, TeamsChannel, type MessageQueue, type MessageRouter } from "../channels/index.js"
import { ChannelType, isChannelType } from "../enums/channels.js"

export function registerWebhookRoutes(app: FastifyInstance, router: MessageRouter, queue: MessageQueue): void {

  // ── Teams incoming webhook ─────────────────────────────────
  //
  // Teams does NOT use a GET verification step like Meta platforms.
  // Authentication is via JWT Bearer token in the Authorization header.

  app.post("/webhooks/teams", async (req, reply) => {
    const channel = router.getChannel(ChannelType.Teams)
    if (!channel) {
      reply.code(404)
      return { error: "Teams channel not configured" }
    }

    // The Bot Framework signs every request with a JWT Bearer token
    const authHeader = req.headers["authorization"] as string | undefined
    if (!authHeader) {
      reply.code(401)
      return { error: "Missing Authorization header" }
    }

    // validateSignature is async for Teams (fetches JWKS on first call)
    const valid = await channel.validateSignature(Buffer.alloc(0), authHeader)
    if (!valid) {
      reply.code(401)
      return { error: "Invalid Bot Framework token" }
    }

    // Parse and route messages; non-message activities (typing, etc.) are ignored
    const messages = channel.parseWebhook(req.body)
    const results = messages.map((msg) => router.handleInbound(msg))

    // Teams expects a 200 response — even for activities we don't act on
    return { ok: true, processed: results.length }
  })

  // ── Channel management API ────────────────────────────────
  //
  // POST /api/channels body:
  //   { type: ChannelType.Teams, platformId: "<AppId>", appSecret: "<AppPassword>",
  //     accessToken: "", verifyToken: "" }

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
    const { type, appSecret, platformId } = req.body

    if (!type || !appSecret || !platformId) {
      reply.code(400)
      return { error: "Required fields: type, platformId (App ID), appSecret (App Password)" }
    }

    if (type !== ChannelType.Teams) {
      reply.code(400)
      return { error: "type must be 'teams'" }
    }

    const cfg = {
      type,
      accessToken: req.body.accessToken ?? "",
      verifyToken: req.body.verifyToken ?? "",
      appSecret,
      platformId,
    }
    saveChannelConfig(cfg)

    // Hot-register without restart
    const channel = new TeamsChannel(cfg)
    queue.registerChannel(channel)
    router.registerChannel(channel)

    reply.code(201)
    return { ok: true, type }
  })

  app.delete<{ Params: { type: string } }>("/api/channels/:type", async (req, reply) => {
    if (!isChannelType(req.params.type)) {
      reply.code(400)
      return { error: "Invalid channel type" }
    }
    const type: ChannelType = req.params.type
    if (type !== ChannelType.Teams) {
      reply.code(400)
      return { error: "Invalid channel type" }
    }
    deleteChannelConfig(type)
    return { ok: true }
  })

  // ── Conversations + messages API ──────────────────────────

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

  // ── Delivery stats ────────────────────────────────────────

  app.get("/api/delivery/stats", async () => {
    return getDeliveryStats()
  })
}

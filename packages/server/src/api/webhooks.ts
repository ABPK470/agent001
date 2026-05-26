/**
 * Webhook ingress and channel transport routes.
 */

import type { FastifyInstance } from "fastify"
import { deleteChannelConfig, getDeliveryStats, getOutboundMessages, listChannelConfigs, saveChannelConfig, TeamsChannel, type MessageQueue, type MessageRouter } from "../channels/index.js"
import { ChannelType, isChannelType } from "../enums/channels.js"

export function registerWebhookRoutes(app: FastifyInstance, router: MessageRouter, queue: MessageQueue): void {
	app.post("/webhooks/teams", async (req, reply) => {
		const channel = router.getChannel(ChannelType.Teams)
		if (!channel) {
			reply.code(404)
			return { error: "Teams channel not configured" }
		}
		const authHeader = req.headers["authorization"] as string | undefined
		if (!authHeader) {
			reply.code(401)
			return { error: "Missing Authorization header" }
		}
		const valid = await channel.validateSignature(Buffer.alloc(0), authHeader)
		if (!valid) {
			reply.code(401)
			return { error: "Invalid Bot Framework token" }
		}
		const messages = channel.parseWebhook(req.body)
		const results = messages.map((msg) => router.handleInbound(msg))
		return { ok: true, processed: results.length }
	})

	app.get("/api/channels", async () => listChannelConfigs().map((config) => ({ type: config.type, platformId: config.platformId, connected: !!router.getChannel(config.type) })))

	app.post<{ Body: { type: ChannelType; accessToken: string; verifyToken: string; appSecret: string; platformId: string } }>("/api/channels", async (req, reply) => {
		const { type, appSecret, platformId } = req.body
		if (!type || !appSecret || !platformId) {
			reply.code(400)
			return { error: "Required fields: type, platformId (App ID), appSecret (App Password)" }
		}
		if (type !== ChannelType.Teams) {
			reply.code(400)
			return { error: "type must be 'teams'" }
		}
		const cfg = { type, accessToken: req.body.accessToken ?? "", verifyToken: req.body.verifyToken ?? "", appSecret, platformId }
		saveChannelConfig(cfg)
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

	app.get("/api/conversations", async () => router.listConversations().map((conversation) => ({
		id: conversation.id,
		channelType: conversation.channelType,
		senderId: conversation.senderId,
		senderName: conversation.senderName,
		activeRunId: conversation.activeRunId,
		createdAt: conversation.createdAt.toISOString(),
		updatedAt: conversation.updatedAt.toISOString(),
	})))

	app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => getOutboundMessages(req.params.id).map((message) => ({
		id: message.id,
		channelType: message.channelType,
		recipientId: message.recipientId,
		text: message.text,
		status: message.status,
		attempts: message.attempts,
		lastError: message.lastError,
		createdAt: message.createdAt.toISOString(),
		deliveredAt: message.deliveredAt?.toISOString() ?? null,
	})))

	app.get("/api/delivery/stats", async () => getDeliveryStats())
}

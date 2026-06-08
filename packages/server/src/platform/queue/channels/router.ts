/**
 * Message router — the brain of multi-platform messaging.
 *
 * Connects inbound messages from chat platforms to agent runs,
 * and routes agent responses back through the message queue.
 *
 * Flow:
 *   INBOUND:  Platform webhook → Router.handleInbound() → start/continue agent run
 *   OUTBOUND: Agent completes  → Router.sendReply()     → queue → channel → platform
 *
 * Conversations map a (channelType, senderId) pair to an agent run,
 * so a user's WhatsApp thread stays linked to their active agent session.
 */

import { EventType } from "@mia/agent"
import { createHash, randomUUID } from "node:crypto"
import type { CurrentSession } from "../../../features/auth/context.js"
import { broadcast } from "../../events/broadcaster.js"
import type { MessageQueue } from "./queue.js"
import type { Channel, ChannelType, Conversation, InboundMessage } from "./types.js"

// ── Persistence interface ────────────────────────────────────────

export interface ConversationStore {
  findByChannelAndSender(channelType: ChannelType, senderId: string): Conversation | undefined
  save(conv: Conversation): void
  updateActiveRun(id: string, runId: string | null): void
  get(id: string): Conversation | undefined
  getByRunId(runId: string): Conversation | undefined
  list(): Conversation[]
}

// ── Agent run trigger (injected — avoids circular dependency) ────

export interface RunTrigger {
  /** Start a new agent run with the given goal. Returns the run ID. */
  startRun(goal: string, session?: CurrentSession | null): string
}

// ── Message Router ───────────────────────────────────────────────

export class MessageRouter {
  private readonly channels = new Map<ChannelType, Channel>()
  private readonly queue: MessageQueue
  private readonly store: ConversationStore
  private readonly runTrigger: RunTrigger
  /**
   * Maps runId → conversationId for every run started via handleInbound.
   *
   * Root-cause fix: getByRunId() queries `WHERE active_run_id = ?`, which
   * returns nothing once a second message arrives and overwrites the field.
   * Keeping an in-memory map lets sendReply always find the right conversation
   * regardless of how many messages have arrived since.
   */
  private readonly runToConv = new Map<string, string>()

  constructor(queue: MessageQueue, store: ConversationStore, runTrigger: RunTrigger) {
    this.queue = queue
    this.store = store
    this.runTrigger = runTrigger
  }

  /** Register a channel. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.type, channel)
  }

  /** Get a registered channel. */
  getChannel(type: ChannelType): Channel | undefined {
    return this.channels.get(type)
  }

  /**
   * Handle an inbound message from a chat platform.
   *
   * 1. Find or create a conversation for this sender
   * 2. Start a new agent run with the user's message as the goal
   * 3. The agent runs async — when it completes, the orchestrator
   *    calls sendReply() to deliver the response
   */
  handleInbound(message: InboundMessage): { conversationId: string; runId: string } {
    // Find or create conversation
    let conv = this.store.findByChannelAndSender(message.channelType, message.senderId)

    if (!conv) {
      conv = {
        id: randomUUID(),
        channelType: message.channelType,
        senderId: message.senderId,
        senderName: message.senderName ?? null,
        activeRunId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
      this.store.save(conv)
    }

    // Start a new agent run with the user's message
    const runId = this.runTrigger.startRun(message.text, buildChannelSession(message))

    // Track run → conversation so sendReply works even if active_run_id
    // is later overwritten by a subsequent inbound message.
    this.runToConv.set(runId, conv.id)

    // Link the run to the conversation
    conv.activeRunId = runId
    conv.updatedAt = new Date()
    this.store.updateActiveRun(conv.id, runId)

    broadcast({
      type: EventType.ConversationMessage,
      data: {
        conversationId: conv.id,
        channelType: message.channelType,
        senderId: message.senderId,
        senderName: message.senderName ?? null,
        text: message.text,
        direction: "inbound",
        runId
      }
    })

    return { conversationId: conv.id, runId }
  }

  /**
   * Send a reply back to the chat platform.
   *
   * Called by the orchestrator when an agent run completes.
   * Looks up the conversation by run ID + queues the response
   * for delivery with retry.
   */
  async sendReply(runId: string, text: string): Promise<void> {
    // Prefer the in-memory map: the DB query (`WHERE active_run_id = ?`) fails
    // once a newer message has overwritten active_run_id on the conversation.
    const convId = this.runToConv.get(runId)
    const conv = convId ? this.store.get(convId) : this.store.getByRunId(runId)
    if (!conv) return // Run wasn't triggered by a chat message

    // Clean up the tracking entry
    this.runToConv.delete(runId)

    // Clear active run
    this.store.updateActiveRun(conv.id, null)

    // Queue the message for delivery
    await this.queue.enqueue(conv.channelType, conv.senderId, text, conv.id)

    broadcast({
      type: EventType.ConversationMessage,
      data: {
        conversationId: conv.id,
        channelType: conv.channelType,
        senderId: conv.senderId,
        text,
        direction: "outbound",
        runId
      }
    })
  }

  /** List all conversations. */
  listConversations(): Conversation[] {
    return this.store.list()
  }

  /** Get channels info for the API. */
  listChannels(): { type: ChannelType; connected: boolean }[] {
    return [...this.channels.entries()].map(([type]) => ({
      type,
      connected: true
    }))
  }
}

function buildChannelSession(message: InboundMessage): CurrentSession {
  const continuityId = buildChannelContinuityId(message.channelType, message.senderId)
  return {
    sid: continuityId,
    upn: continuityId,
    displayName: message.senderName?.trim() || `${message.channelType} user`,
    isAdmin: false,
    ip: `${message.channelType}:inbound`,
    userAgent: `${message.channelType}:channel`
  }
}

function buildChannelContinuityId(channelType: ChannelType, senderId: string): string {
  const digest = createHash("sha256").update(senderId).digest("hex").slice(0, 24)
  return `channel:${channelType}:${digest}`
}

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

import { randomUUID } from "node:crypto"
import type { Channel, ChannelType, Conversation, InboundMessage } from "./types.js"
import type { MessageQueue } from "./queue.js"
import { broadcast } from "../ws.js"

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
  startRun(goal: string): string
}

// ── Message Router ───────────────────────────────────────────────

export class MessageRouter {
  private readonly channels = new Map<ChannelType, Channel>()
  private readonly queue: MessageQueue
  private readonly store: ConversationStore
  private readonly runTrigger: RunTrigger

  constructor(
    queue: MessageQueue,
    store: ConversationStore,
    runTrigger: RunTrigger,
  ) {
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
        updatedAt: new Date(),
      }
      this.store.save(conv)
    }

    // Start a new agent run with the user's message
    const runId = this.runTrigger.startRun(message.text)

    // Link the run to the conversation
    conv.activeRunId = runId
    conv.updatedAt = new Date()
    this.store.updateActiveRun(conv.id, runId)

    broadcast({
      type: "conversation.message",
      data: {
        conversationId: conv.id,
        channelType: message.channelType,
        senderId: message.senderId,
        senderName: message.senderName ?? null,
        text: message.text,
        direction: "inbound",
        runId,
      },
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
    const conv = this.store.getByRunId(runId)
    if (!conv) return // Run wasn't triggered by a chat message

    // Clear active run
    this.store.updateActiveRun(conv.id, null)

    // Queue the message for delivery
    await this.queue.enqueue(conv.channelType, conv.senderId, text, conv.id)

    broadcast({
      type: "conversation.message",
      data: {
        conversationId: conv.id,
        channelType: conv.channelType,
        senderId: conv.senderId,
        text,
        direction: "outbound",
        runId,
      },
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
      connected: true,
    }))
  }
}

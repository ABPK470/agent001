/**
 * Message queue — in-process FIFO with per-channel serialization.
 *
 * Why per-channel serialization? WhatsApp and Messenger rate-limit
 * per sender. Sending messages for different users in parallel is fine,
 * but messages to the SAME user must be ordered (otherwise "Hello"
 * might arrive after "Here's your answer").
 *
 * The queue:
 *   1. Accepts outbound messages
 *   2. Serializes delivery per (channel, recipient) pair
 *   3. Retries failures with exponential backoff
 *   4. Persists state to SQLite for crash recovery
 *   5. Broadcasts delivery status via WebSocket
 *
 * This is the same pattern OpenClaw uses for multi-platform delivery.
 */

import { randomUUID } from "node:crypto"
import { broadcast } from "../ws.js"
import { DEFAULT_RETRY_POLICY, withRetry } from "./retry.js"
import type { Channel, ChannelType, DeliveryStatus, OutboundMessage, RetryPolicy } from "./types.js"

// ── Queue entry ──────────────────────────────────────────────────

interface QueueEntry {
  message: OutboundMessage
  resolve: (msg: OutboundMessage) => void
}

// ── Persistence interface (injected by the server) ───────────────

export interface QueueStore {
  save(msg: OutboundMessage): void
  updateStatus(id: string, status: DeliveryStatus, error: string | null, nextRetryAt: Date | null, deliveredAt: Date | null): void
  loadPending(): OutboundMessage[]
  saveAttempt(messageId: string, attempt: number, status: "success" | "failed", error: string | null, durationMs: number): void
}

// ── Message Queue ────────────────────────────────────────────────

export class MessageQueue {
  private readonly channels = new Map<ChannelType, Channel>()
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly processing = new Set<string>()
  private readonly retryPolicy: RetryPolicy
  private readonly store: QueueStore
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(store: QueueStore, retryPolicy?: RetryPolicy) {
    this.store = store
    this.retryPolicy = retryPolicy ?? DEFAULT_RETRY_POLICY
  }

  /** Register a channel for sending messages. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.type, channel)
  }

  /** Start the queue — recovers pending messages from the store. */
  start(): void {
    // Recover pending/retrying messages from the database
    const pending = this.store.loadPending()
    for (const msg of pending) {
      this.enqueueInternal(msg)
    }

    // Periodic retry check (handles retryAt scheduling)
    this.retryTimer = setInterval(() => this.processRetries(), 5000)
  }

  /** Stop the queue cleanly. */
  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * Enqueue a message for delivery.
   * Returns a promise that resolves when delivery succeeds or fails permanently.
   */
  async enqueue(
    channelType: ChannelType,
    recipientId: string,
    text: string,
    conversationId: string,
  ): Promise<OutboundMessage> {
    const msg: OutboundMessage = {
      id: randomUUID(),
      conversationId,
      channelType,
      recipientId,
      text,
      status: "queued",
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
      createdAt: new Date(),
      deliveredAt: null,
    }

    this.store.save(msg)
    broadcast({ type: "message.queued", data: { messageId: msg.id, channelType, recipientId } })

    return new Promise((resolve) => {
      this.enqueueInternal(msg, resolve)
    })
  }

  private enqueueInternal(msg: OutboundMessage, resolve?: (msg: OutboundMessage) => void): void {
    const key = `${msg.channelType}:${msg.recipientId}`
    if (!this.queues.has(key)) {
      this.queues.set(key, [])
    }
    this.queues.get(key)!.push({
      message: msg,
      resolve: resolve ?? (() => {}),
    })
    this.processQueue(key)
  }

  // ── Processing ───────────────────────────────────────────────

  private async processQueue(key: string): Promise<void> {
    if (this.processing.has(key)) return
    this.processing.add(key)

    try {
      const queue = this.queues.get(key)
      while (queue && queue.length > 0) {
        const entry = queue[0]

        // If scheduled for later, skip for now
        if (entry.message.nextRetryAt && entry.message.nextRetryAt > new Date()) {
          break
        }

        await this.deliverMessage(entry)
        queue.shift()
      }

      // Clean up empty queues
      const queue2 = this.queues.get(key)
      if (queue2 && queue2.length === 0) {
        this.queues.delete(key)
      }
    } finally {
      this.processing.delete(key)
    }
  }

  private async deliverMessage(entry: QueueEntry): Promise<void> {
    const { message } = entry
    const channel = this.channels.get(message.channelType)

    if (!channel) {
      message.status = "failed"
      message.lastError = `No channel registered for type "${message.channelType}"`
      this.store.updateStatus(message.id, "failed", message.lastError, null, null)
      broadcast({ type: "message.failed", data: { messageId: message.id, error: message.lastError } })
      entry.resolve(message)
      return
    }

    message.status = "sending"
    this.store.updateStatus(message.id, "sending", null, null, null)

    const startTime = Date.now()
    const result = await withRetry(
      () => channel.sendMessage(message.recipientId, message.text),
      this.retryPolicy,
    )
    const durationMs = Date.now() - startTime

    message.attempts = result.attempts

    if (result.success) {
      message.status = "delivered"
      message.deliveredAt = new Date()
      this.store.updateStatus(message.id, "delivered", null, null, message.deliveredAt)
      this.store.saveAttempt(message.id, result.attempts, "success", null, durationMs)

      broadcast({
        type: "message.delivered",
        data: { messageId: message.id, channelType: message.channelType, recipientId: message.recipientId, attempts: result.attempts },
      })
    } else {
      message.status = "failed"
      message.lastError = result.lastError?.message ?? "Unknown error"
      this.store.updateStatus(message.id, "failed", message.lastError, null, null)
      this.store.saveAttempt(message.id, result.attempts, "failed", message.lastError, durationMs)

      broadcast({
        type: "message.failed",
        data: { messageId: message.id, error: message.lastError, attempts: result.attempts },
      })
    }

    entry.resolve(message)
  }

  // ── Retry scheduling ─────────────────────────────────────────

  private processRetries(): void {
    const now = new Date()
    for (const [key, queue] of this.queues) {
      if (queue.length > 0 && !this.processing.has(key)) {
        const first = queue[0]
        if (first.message.nextRetryAt && first.message.nextRetryAt <= now) {
          this.processQueue(key)
        }
      }
    }
  }

  // ── Stats ────────────────────────────────────────────────────

  get pendingCount(): number {
    let count = 0
    for (const queue of this.queues.values()) {
      count += queue.length
    }
    return count
  }
}

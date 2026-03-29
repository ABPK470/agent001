/**
 * Tests for the message routing infrastructure:
 *   - Retry with exponential backoff + jitter
 *   - Message queue (FIFO, per-channel serialization)
 *   - WhatsApp webhook parsing + signature validation
 *   - Messenger webhook parsing + signature validation
 *   - Message router (inbound → run, run complete → outbound)
 */

import { createHmac } from "node:crypto"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { ChannelApiError, computeDelay, withRetry } from "../src/channels/retry.js"
import { MessageQueue } from "../src/channels/queue.js"
import type { QueueStore } from "../src/channels/queue.js"
import { WhatsAppChannel } from "../src/channels/whatsapp.js"
import { MessengerChannel } from "../src/channels/messenger.js"
import { MessageRouter } from "../src/channels/router.js"
import type { ConversationStore, RunTrigger } from "../src/channels/router.js"
import type { Channel, ChannelConfig, Conversation, DeliveryStatus, OutboundMessage } from "../src/channels/types.js"
import { DEFAULT_RETRY_POLICY } from "../src/channels/retry.js"

// ── Test helpers ─────────────────────────────────────────────────

function whatsAppConfig(): ChannelConfig {
  return {
    type: "whatsapp",
    accessToken: "test-token",
    verifyToken: "test-verify",
    appSecret: "test-secret",
    platformId: "123456789",
  }
}

function messengerConfig(): ChannelConfig {
  return {
    type: "messenger",
    accessToken: "test-token",
    verifyToken: "test-verify",
    appSecret: "test-secret",
    platformId: "page-123",
  }
}

/** In-memory queue store for testing (no SQLite). */
function memoryQueueStore(): QueueStore {
  const messages = new Map<string, OutboundMessage>()
  const attempts: { messageId: string; attempt: number; status: string; error: string | null; durationMs: number }[] = []

  return {
    save(msg) { messages.set(msg.id, { ...msg }) },
    updateStatus(id, status, error, nextRetryAt, deliveredAt) {
      const msg = messages.get(id)
      if (msg) {
        msg.status = status
        msg.lastError = error
        msg.nextRetryAt = nextRetryAt
        msg.deliveredAt = deliveredAt
      }
    },
    loadPending() {
      return [...messages.values()].filter(
        (m) => m.status === "queued" || m.status === "sending" || m.status === "retrying",
      )
    },
    saveAttempt(messageId, attempt, status, error, durationMs) {
      attempts.push({ messageId, attempt, status, error, durationMs })
    },
  }
}

/** In-memory conversation store for testing. */
function memoryConversationStore(): ConversationStore {
  const conversations = new Map<string, Conversation>()

  return {
    findByChannelAndSender(channelType, senderId) {
      for (const c of conversations.values()) {
        if (c.channelType === channelType && c.senderId === senderId) return c
      }
      return undefined
    },
    save(conv) { conversations.set(conv.id, { ...conv }) },
    updateActiveRun(id, runId) {
      const conv = conversations.get(id)
      if (conv) conv.activeRunId = runId
    },
    get(id) { return conversations.get(id) },
    getByRunId(runId) {
      for (const c of conversations.values()) {
        if (c.activeRunId === runId) return c
      }
      return undefined
    },
    list() { return [...conversations.values()] },
  }
}

/** Mock channel that tracks sent messages. */
function mockChannel(type: "whatsapp" | "messenger"): Channel & { sent: { to: string; text: string }[] } {
  const sent: { to: string; text: string }[] = []
  return {
    type,
    sent,
    async sendMessage(recipientId, text) {
      sent.push({ to: recipientId, text })
      return `msg-${sent.length}`
    },
    validateSignature() { return true },
    parseWebhook() { return [] },
  }
}

// ═══════════════════════════════════════════════════════════════════
// RETRY
// ═══════════════════════════════════════════════════════════════════

describe("retry", () => {
  describe("computeDelay", () => {
    it("increases exponentially", () => {
      const policy = { ...DEFAULT_RETRY_POLICY, jitterFactor: 0 }
      expect(computeDelay(0, policy)).toBe(1000)
      expect(computeDelay(1, policy)).toBe(2000)
      expect(computeDelay(2, policy)).toBe(4000)
      expect(computeDelay(3, policy)).toBe(8000)
    })

    it("caps at maxDelayMs", () => {
      const policy = { ...DEFAULT_RETRY_POLICY, jitterFactor: 0, maxDelayMs: 5000 }
      expect(computeDelay(10, policy)).toBe(5000)
    })

    it("adds jitter", () => {
      const policy = { ...DEFAULT_RETRY_POLICY, jitterFactor: 0.5 }
      const delay = computeDelay(0, policy)
      // Base is 1000, jitter adds 0-500
      expect(delay).toBeGreaterThanOrEqual(1000)
      expect(delay).toBeLessThanOrEqual(1500)
    })
  })

  describe("withRetry", () => {
    it("returns immediately on success", async () => {
      const fn = vi.fn().mockResolvedValue("ok")
      const result = await withRetry(fn, { ...DEFAULT_RETRY_POLICY, maxRetries: 3 })
      expect(result.success).toBe(true)
      expect(result.value).toBe("ok")
      expect(result.attempts).toBe(1)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it("retries on retryable errors", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new ChannelApiError("rate limited", 429))
        .mockResolvedValue("ok")

      const result = await withRetry(fn, {
        ...DEFAULT_RETRY_POLICY,
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
      })

      expect(result.success).toBe(true)
      expect(result.attempts).toBe(2)
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it("does NOT retry non-retryable errors (400)", async () => {
      const fn = vi.fn().mockRejectedValue(new ChannelApiError("bad request", 400))
      const result = await withRetry(fn, { ...DEFAULT_RETRY_POLICY, maxRetries: 3 })
      expect(result.success).toBe(false)
      expect(result.attempts).toBe(1)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it("gives up after maxRetries", async () => {
      const fn = vi.fn().mockRejectedValue(new ChannelApiError("server error", 500))
      const result = await withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 2,
        backoffMultiplier: 2,
        jitterFactor: 0,
      })
      expect(result.success).toBe(false)
      expect(result.attempts).toBe(3) // initial + 2 retries
      expect(fn).toHaveBeenCalledTimes(3)
    })
  })

  describe("ChannelApiError", () => {
    it("marks 429 as retryable", () => {
      expect(new ChannelApiError("", 429).retryable).toBe(true)
    })

    it("marks 500 as retryable", () => {
      expect(new ChannelApiError("", 500).retryable).toBe(true)
    })

    it("marks 503 as retryable", () => {
      expect(new ChannelApiError("", 503).retryable).toBe(true)
    })

    it("marks 400 as NOT retryable", () => {
      expect(new ChannelApiError("", 400).retryable).toBe(false)
    })

    it("marks 401 as NOT retryable", () => {
      expect(new ChannelApiError("", 401).retryable).toBe(false)
    })

    it("marks 403 as NOT retryable", () => {
      expect(new ChannelApiError("", 403).retryable).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// WHATSAPP CHANNEL
// ═══════════════════════════════════════════════════════════════════

describe("WhatsAppChannel", () => {
  it("validates HMAC-SHA256 signature", () => {
    const channel = new WhatsAppChannel(whatsAppConfig())
    const payload = Buffer.from('{"test": true}')
    const sig = "sha256=" + createHmac("sha256", "test-secret").update(payload).digest("hex")

    expect(channel.validateSignature(payload, sig)).toBe(true)
    expect(channel.validateSignature(payload, "sha256=wrong")).toBe(false)
  })

  it("parses text message webhook", () => {
    const channel = new WhatsAppChannel(whatsAppConfig())
    const body = {
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "+1234567890", phone_number_id: "123456789" },
            contacts: [{ wa_id: "15551234567", profile: { name: "John" } }],
            messages: [{
              id: "wamid.abc123",
              from: "15551234567",
              timestamp: "1234567890",
              type: "text",
              text: { body: "Hello agent!" },
            }],
          },
        }],
      }],
    }

    const messages = channel.parseWebhook(body)
    expect(messages).toHaveLength(1)
    expect(messages[0].channelType).toBe("whatsapp")
    expect(messages[0].senderId).toBe("15551234567")
    expect(messages[0].senderName).toBe("John")
    expect(messages[0].text).toBe("Hello agent!")
    expect(messages[0].platformMessageId).toBe("wamid.abc123")
  })

  it("ignores non-text messages", () => {
    const channel = new WhatsAppChannel(whatsAppConfig())
    const body = {
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {},
            messages: [{
              id: "wamid.abc123",
              from: "15551234567",
              timestamp: "1234567890",
              type: "image",
            }],
          },
        }],
      }],
    }

    expect(channel.parseWebhook(body)).toHaveLength(0)
  })

  it("returns empty for status-only webhooks", () => {
    const channel = new WhatsAppChannel(whatsAppConfig())
    const body = {
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {},
            statuses: [{ id: "wamid.abc", status: "delivered", timestamp: "123", recipient_id: "456" }],
          },
        }],
      }],
    }

    expect(channel.parseWebhook(body)).toHaveLength(0)
  })

  it("returns empty for unrelated objects", () => {
    const channel = new WhatsAppChannel(whatsAppConfig())
    expect(channel.parseWebhook({ object: "something_else" })).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// MESSENGER CHANNEL
// ═══════════════════════════════════════════════════════════════════

describe("MessengerChannel", () => {
  it("validates HMAC-SHA256 signature", () => {
    const channel = new MessengerChannel(messengerConfig())
    const payload = Buffer.from('{"test": true}')
    const sig = "sha256=" + createHmac("sha256", "test-secret").update(payload).digest("hex")

    expect(channel.validateSignature(payload, sig)).toBe(true)
    expect(channel.validateSignature(payload, "sha256=invalid")).toBe(false)
  })

  it("parses text message webhook", () => {
    const channel = new MessengerChannel(messengerConfig())
    const body = {
      object: "page",
      entry: [{
        id: "page-123",
        time: 1234567890,
        messaging: [{
          sender: { id: "user-456" },
          recipient: { id: "page-123" },
          timestamp: 1234567890,
          message: { mid: "mid.abc123", text: "Hello from Messenger!" },
        }],
      }],
    }

    const messages = channel.parseWebhook(body)
    expect(messages).toHaveLength(1)
    expect(messages[0].channelType).toBe("messenger")
    expect(messages[0].senderId).toBe("user-456")
    expect(messages[0].text).toBe("Hello from Messenger!")
    expect(messages[0].platformMessageId).toBe("mid.abc123")
  })

  it("ignores non-message events (delivery receipts)", () => {
    const channel = new MessengerChannel(messengerConfig())
    const body = {
      object: "page",
      entry: [{
        id: "page-123",
        time: 1234567890,
        messaging: [{
          sender: { id: "user-456" },
          recipient: { id: "page-123" },
          timestamp: 1234567890,
          delivery: { mids: ["mid.abc123"], watermark: 1234567890 },
        }],
      }],
    }

    expect(channel.parseWebhook(body)).toHaveLength(0)
  })

  it("returns empty for non-page objects", () => {
    const channel = new MessengerChannel(messengerConfig())
    expect(channel.parseWebhook({ object: "other" })).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// MESSAGE QUEUE
// ═══════════════════════════════════════════════════════════════════

describe("MessageQueue", () => {
  let store: QueueStore
  let queue: MessageQueue

  beforeEach(() => {
    // Mock broadcast to prevent errors (it imports ws.ts which isn't available in tests)
    vi.mock("../src/ws.js", () => ({
      broadcast: vi.fn(),
    }))

    store = memoryQueueStore()
    queue = new MessageQueue(store)
  })

  it("delivers a message through a channel", async () => {
    const channel = mockChannel("whatsapp")
    queue.registerChannel(channel)

    const result = await queue.enqueue("whatsapp", "15551234567", "Hello!", "conv-1")
    expect(result.status).toBe("delivered")
    expect(result.attempts).toBe(1)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toEqual({ to: "15551234567", text: "Hello!" })
  })

  it("fails when no channel is registered", async () => {
    const result = await queue.enqueue("whatsapp", "15551234567", "Hello!", "conv-1")
    expect(result.status).toBe("failed")
    expect(result.lastError).toContain("No channel registered")
  })

  it("tracks pending count", () => {
    expect(queue.pendingCount).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════════════

describe("MessageRouter", () => {
  let store: QueueStore
  let convStore: ConversationStore
  let queue: MessageQueue
  let router: MessageRouter
  let trigger: RunTrigger
  let runId: string

  beforeEach(() => {
    vi.mock("../src/ws.js", () => ({
      broadcast: vi.fn(),
    }))

    store = memoryQueueStore()
    convStore = memoryConversationStore()
    queue = new MessageQueue(store)

    runId = "run-001"
    trigger = { startRun: vi.fn(() => runId) }
    router = new MessageRouter(queue, convStore, trigger)
  })

  it("creates a conversation and starts a run on inbound message", () => {
    const result = router.handleInbound({
      platformMessageId: "wamid.abc",
      channelType: "whatsapp",
      senderId: "15551234567",
      senderName: "John",
      text: "What's the weather?",
      raw: {},
      receivedAt: new Date(),
    })

    expect(result.runId).toBe("run-001")
    expect(result.conversationId).toBeTruthy()
    expect(trigger.startRun).toHaveBeenCalledWith("What's the weather?")

    // Conversation was created
    const convs = router.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].channelType).toBe("whatsapp")
    expect(convs[0].senderId).toBe("15551234567")
    expect(convs[0].senderName).toBe("John")
    expect(convs[0].activeRunId).toBe("run-001")
  })

  it("reuses existing conversation for same sender", () => {
    const msg = {
      platformMessageId: "wamid.abc",
      channelType: "whatsapp" as const,
      senderId: "15551234567",
      text: "first",
      raw: {},
      receivedAt: new Date(),
    }

    const result1 = router.handleInbound(msg)
    runId = "run-002"
    const result2 = router.handleInbound({ ...msg, platformMessageId: "wamid.def", text: "second" })

    expect(result1.conversationId).toBe(result2.conversationId)
    expect(router.listConversations()).toHaveLength(1)
  })

  it("sends reply through the queue on run completion", async () => {
    const channel = mockChannel("whatsapp")
    queue.registerChannel(channel)
    router.registerChannel(channel)

    // Simulate inbound
    router.handleInbound({
      platformMessageId: "wamid.abc",
      channelType: "whatsapp",
      senderId: "15551234567",
      text: "Hello",
      raw: {},
      receivedAt: new Date(),
    })

    // Simulate run completion
    await router.sendReply("run-001", "The weather is sunny!")

    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toEqual({ to: "15551234567", text: "The weather is sunny!" })
  })

  it("does nothing if run has no conversation", async () => {
    const channel = mockChannel("whatsapp")
    queue.registerChannel(channel)

    await router.sendReply("unknown-run", "No one to send to")
    expect(channel.sent).toHaveLength(0)
  })

  it("lists registered channels", () => {
    const wa = mockChannel("whatsapp")
    const fb = mockChannel("messenger")
    router.registerChannel(wa)
    router.registerChannel(fb)

    const channels = router.listChannels()
    expect(channels).toHaveLength(2)
    expect(channels.map(c => c.type).sort()).toEqual(["messenger", "whatsapp"])
  })
})

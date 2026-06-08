/**
 * Tests for the message routing infrastructure:
 *   - Retry with exponential backoff + jitter
 *   - Message queue (FIFO, per-channel serialization)
 *   - Teams webhook parsing
 *   - Message router (inbound → run, run complete → outbound)
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { QueueStore } from "../src/platform/queue/channels/queue.js"
import { MessageQueue } from "../src/platform/queue/channels/queue.js"
import { ChannelApiError, computeDelay, DEFAULT_RETRY_POLICY, withRetry } from "../src/platform/queue/channels/retry.js"
import type { ConversationStore, RunTrigger } from "../src/platform/queue/channels/router.js"
import { MessageRouter } from "../src/platform/queue/channels/router.js"
import { TeamsChannel } from "../src/platform/queue/channels/teams.js"
import type { Channel, ChannelConfig, Conversation, OutboundMessage } from "../src/platform/queue/channels/types.js"

// ── Test helpers ─────────────────────────────────────────────────

function teamsConfig(): ChannelConfig {
  return {
    type: "teams",
    accessToken: "",
    verifyToken: "",
    appSecret: "test-app-password",
    platformId: "test-app-id-1234"
  }
}

/** In-memory queue store for testing (no SQLite). */
function memoryQueueStore(): QueueStore {
  const messages = new Map<string, OutboundMessage>()
  const attempts: {
    messageId: string
    attempt: number
    status: string
    error: string | null
    durationMs: number
  }[] = []

  return {
    save(msg) {
      messages.set(msg.id, { ...msg })
    },
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
        (m) => m.status === "queued" || m.status === "sending" || m.status === "retrying"
      )
    },
    saveAttempt(messageId, attempt, status, error, durationMs) {
      attempts.push({ messageId, attempt, status, error, durationMs })
    }
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
    save(conv) {
      conversations.set(conv.id, { ...conv })
    },
    updateActiveRun(id, runId) {
      const conv = conversations.get(id)
      if (conv) conv.activeRunId = runId
    },
    get(id) {
      return conversations.get(id)
    },
    getByRunId(runId) {
      for (const c of conversations.values()) {
        if (c.activeRunId === runId) return c
      }
      return undefined
    },
    list() {
      return [...conversations.values()]
    }
  }
}

/** Mock Teams channel that tracks sent messages. */
function mockTeamsChannel(): Channel & { sent: { to: string; text: string }[] } {
  const sent: { to: string; text: string }[] = []
  return {
    type: "teams",
    sent,
    async sendMessage(recipientId, text) {
      sent.push({ to: recipientId, text })
      return `msg-${sent.length}`
    },
    validateSignature() {
      return Promise.resolve(true)
    },
    parseWebhook() {
      return []
    }
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
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ChannelApiError("rate limited", 429))
        .mockResolvedValue("ok")

      const result = await withRetry(fn, {
        ...DEFAULT_RETRY_POLICY,
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 2
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
        jitterFactor: 0
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
// TEAMS CHANNEL
// ═══════════════════════════════════════════════════════════════════

describe("TeamsChannel", () => {
  it("parses a text message activity", () => {
    const channel = new TeamsChannel(teamsConfig())
    const body = {
      type: "message",
      id: "activity-abc123",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      from: { id: "user-123", name: "Alice" },
      conversation: { id: "conv-456" },
      recipient: { id: "test-app-id-1234" },
      text: "  Hello agent!  ",
      channelId: "msteams"
    }

    const messages = channel.parseWebhook(body)
    expect(messages).toHaveLength(1)

    const [msg] = messages
    expect(msg!.channelType).toBe("teams")
    expect(msg!.text).toBe("Hello agent!")
    expect(msg!.senderName).toBe("Alice")
    expect(msg!.platformMessageId).toBe("activity-abc123")

    // senderId should be a JSON-encoded conversation reference
    const ref = JSON.parse(msg!.senderId)
    expect(ref.serviceUrl).toBe("https://smba.trafficmanager.net/emea/")
    expect(ref.conversationId).toBe("conv-456")
    expect(ref.userId).toBe("user-123")
  })

  it("ignores non-message activity types", () => {
    const channel = new TeamsChannel(teamsConfig())
    expect(channel.parseWebhook({ type: "conversationUpdate" })).toHaveLength(0)
    expect(channel.parseWebhook({ type: "invoke" })).toHaveLength(0)
    expect(channel.parseWebhook({ type: "typing" })).toHaveLength(0)
  })

  it("ignores message activities with empty text", () => {
    const channel = new TeamsChannel(teamsConfig())
    expect(channel.parseWebhook({ type: "message", text: "" })).toHaveLength(0)
    expect(channel.parseWebhook({ type: "message", text: "   " })).toHaveLength(0)
    expect(channel.parseWebhook({ type: "message" })).toHaveLength(0)
  })

  it("returns empty for malformed payloads", () => {
    const channel = new TeamsChannel(teamsConfig())
    expect(channel.parseWebhook(null)).toHaveLength(0)
    expect(channel.parseWebhook({})).toHaveLength(0)
    expect(channel.parseWebhook("not an object")).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// MESSAGE QUEUE
// ═══════════════════════════════════════════════════════════════════

describe("MessageQueue", () => {
  let store: QueueStore
  let queue: MessageQueue

  beforeEach(() => {
    // Mock broadcast to prevent errors in isolated test env.
    vi.mock("../src/platform/events/broadcaster.js", () => ({
      broadcast: vi.fn()
    }))

    store = memoryQueueStore()
    queue = new MessageQueue(store)
  })

  it("delivers a message through a channel", async () => {
    const channel = mockTeamsChannel()
    queue.registerChannel(channel)

    const result = await queue.enqueue("teams", "15551234567", "Hello!", "conv-1")
    expect(result.status).toBe("delivered")
    expect(result.attempts).toBe(1)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toEqual({ to: "15551234567", text: "Hello!" })
  })

  it("fails when no channel is registered", async () => {
    const result = await queue.enqueue("teams", "15551234567", "Hello!", "conv-1")
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
    vi.mock("../src/platform/events/broadcaster.js", () => ({
      broadcast: vi.fn()
    }))

    store = memoryQueueStore()
    convStore = memoryConversationStore()
    queue = new MessageQueue(store)

    runId = "run-001"
    trigger = { startRun: vi.fn(() => runId) }
    router = new MessageRouter(queue, convStore, trigger)
  })

  it("creates a conversation and starts a run on inbound message", () => {
    const conversationRef = JSON.stringify({
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      conversationId: "conv-abc",
      userId: "user-123"
    })
    const result = router.handleInbound({
      platformMessageId: "activity-abc",
      channelType: "teams",
      senderId: conversationRef,
      senderName: "Alice",
      text: "What's the weather?",
      raw: {},
      receivedAt: new Date()
    })

    expect(result.runId).toBe("run-001")
    expect(result.conversationId).toBeTruthy()
    expect(trigger.startRun).toHaveBeenCalledTimes(1)
    const [goal, session] = vi.mocked(trigger.startRun).mock.calls[0] ?? []
    expect(goal).toBe("What's the weather?")
    expect(session).toMatchObject({
      displayName: "Alice",
      isAdmin: false,
      ip: "teams:inbound",
      userAgent: "teams:channel"
    })
    expect(session?.sid).toMatch(/^channel:teams:[0-9a-f]{24}$/)
    expect(session?.upn).toBe(session?.sid)

    // Conversation was created
    const convs = router.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].channelType).toBe("teams")
    expect(convs[0].senderName).toBe("Alice")
    expect(convs[0].activeRunId).toBe("run-001")
  })

  it("reuses existing conversation for same sender", () => {
    const senderId = JSON.stringify({
      serviceUrl: "https://smba.example.com/",
      conversationId: "c1",
      userId: "u1"
    })
    const msg = {
      platformMessageId: "activity-abc",
      channelType: "teams" as const,
      senderId,
      text: "first",
      raw: {},
      receivedAt: new Date()
    }

    const result1 = router.handleInbound(msg)
    runId = "run-002"
    const result2 = router.handleInbound({ ...msg, platformMessageId: "activity-def", text: "second" })

    expect(result1.conversationId).toBe(result2.conversationId)
    expect(router.listConversations()).toHaveLength(1)
  })

  it("stamps the same synthetic continuity identity for repeated inbound messages from one sender", () => {
    const senderId = JSON.stringify({
      serviceUrl: "https://smba.example.com/",
      conversationId: "c1",
      userId: "u1"
    })
    router.handleInbound({
      platformMessageId: "activity-1",
      channelType: "teams",
      senderId,
      senderName: "Alice",
      text: "first",
      raw: {},
      receivedAt: new Date()
    })
    router.handleInbound({
      platformMessageId: "activity-2",
      channelType: "teams",
      senderId,
      senderName: "Alice",
      text: "second",
      raw: {},
      receivedAt: new Date()
    })

    const firstSession = vi.mocked(trigger.startRun).mock.calls[0]?.[1]
    const secondSession = vi.mocked(trigger.startRun).mock.calls[1]?.[1]
    expect(firstSession?.sid).toBeTruthy()
    expect(secondSession?.sid).toBe(firstSession?.sid)
    expect(secondSession?.upn).toBe(firstSession?.upn)
  })

  it("sends reply through the queue on run completion", async () => {
    const channel = mockTeamsChannel()
    queue.registerChannel(channel)
    router.registerChannel(channel)

    const conversationRef = JSON.stringify({
      serviceUrl: "https://smba.example.com/",
      conversationId: "conv-abc",
      userId: "user-123"
    })

    // Simulate inbound
    router.handleInbound({
      platformMessageId: "activity-abc",
      channelType: "teams",
      senderId: conversationRef,
      text: "Hello",
      raw: {},
      receivedAt: new Date()
    })

    // Simulate run completion
    await router.sendReply("run-001", "The weather is sunny!")

    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toEqual({ to: conversationRef, text: "The weather is sunny!" })
  })

  it("does nothing if run has no conversation", async () => {
    const channel = mockTeamsChannel()
    queue.registerChannel(channel)

    await router.sendReply("unknown-run", "No one to send to")
    expect(channel.sent).toHaveLength(0)
  })

  it("lists registered channels", () => {
    const teams = mockTeamsChannel()
    router.registerChannel(teams)

    const channels = router.listChannels()
    expect(channels).toHaveLength(1)
    expect(channels[0]!.type).toBe("teams")
  })
})

/**
 * Agent Message Bus — inter-agent communication within a run tree.
 *
 * When a parent agent delegates to multiple children, those children
 * (and the parent) sometimes need to coordinate:
 *   - A researcher agent finds something the writer agent needs
 *   - A child agent needs to ask the parent for clarification
 *   - Multiple parallel children need to avoid duplicating work
 *
 * This is a lightweight pub/sub bus scoped to a single run tree
 * (root run + all its delegated children). Messages are:
 *   - Typed (topic string)
 *   - Attributed (fromRunId, fromAgentName)
 *   - Buffered (subscribers see messages sent before they subscribed)
 *   - Broadcast to WebSocket for UI visibility
 *
 * Design choices:
 *   - In-memory only (messages die with the run — they're ephemeral coordination)
 *   - One bus per root run (children share the parent's bus)
 *   - Topic-based: agents publish to topics, others subscribe
 *   - No persistence needed: if the server crashes, runs resume from checkpoint
 *     and agents re-discover state from tools (file system, etc.)
 */

import type { Tool } from "@agent001/agent"

// ── Types ────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string
  topic: string
  fromRunId: string
  fromAgent: string
  content: string
  timestamp: number
}

type MessageHandler = (msg: AgentMessage) => void

// ── AgentBus ─────────────────────────────────────────────────────

export class AgentBus {
  readonly rootRunId: string
  private readonly messages: AgentMessage[] = []
  private readonly subscribers = new Map<string, Set<MessageHandler>>()
  private msgCounter = 0

  constructor(rootRunId: string) {
    this.rootRunId = rootRunId
  }

  /** Publish a message to a topic. All current subscribers receive it. */
  publish(topic: string, fromRunId: string, fromAgent: string, content: string): AgentMessage {
    const msg: AgentMessage = {
      id: `${this.rootRunId}-msg-${++this.msgCounter}`,
      topic,
      fromRunId,
      fromAgent,
      content,
      timestamp: Date.now(),
    }
    this.messages.push(msg)

    // Notify subscribers
    const handlers = this.subscribers.get(topic)
    if (handlers) {
      for (const handler of handlers) {
        handler(msg)
      }
    }

    // Also notify wildcard subscribers
    const wildcardHandlers = this.subscribers.get("*")
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(msg)
      }
    }

    return msg
  }

  /** Subscribe to a topic. Use "*" for all messages. Returns unsubscribe function. */
  subscribe(topic: string, handler: MessageHandler): () => void {
    let handlers = this.subscribers.get(topic)
    if (!handlers) {
      handlers = new Set()
      this.subscribers.set(topic, handlers)
    }
    handlers.add(handler)
    return () => { handlers!.delete(handler) }
  }

  /** Get message history for a topic (or all topics if "*"). */
  history(topic?: string): AgentMessage[] {
    if (!topic || topic === "*") return [...this.messages]
    return this.messages.filter((m) => m.topic === topic)
  }

  /** Drain all subscribers (cleanup). */
  dispose(): void {
    this.subscribers.clear()
  }
}

// ── Agent communication tools ────────────────────────────────────

/**
 * Create tools that let an agent send/receive messages on the bus.
 * Each agent gets its own pair of tools bound to its identity.
 */
export function createBusTools(
  bus: AgentBus,
  runId: string,
  agentName: string,
): Tool[] {
  // Collect messages received while waiting
  const inbox: AgentMessage[] = []
  // Subscribe to messages directed to this agent or broadcast
  bus.subscribe("*", (msg) => {
    // Don't echo own messages
    if (msg.fromRunId === runId) return
    inbox.push(msg)
  })

  return [
    {
      name: "send_message",
      description:
        `Send a message to other agents in this run tree. Use topics to target specific agents ` +
        `or broadcast to all. Common topics: "status", "result", "request", "broadcast". ` +
        `Other agents will see your message in their next check_messages call.`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: `Topic/channel for the message. Use "broadcast" for all agents, or a specific topic like "research-results", "status-update".`,
          },
          content: {
            type: "string",
            description: "The message content. Be concise and specific.",
          },
        },
        required: ["topic", "content"],
      },
      execute: async (args) => {
        const topic = String(args.topic)
        const content = String(args.content)
        bus.publish(topic, runId, agentName, content)
        return `Message sent to topic "${topic}".`
      },
    },
    {
      name: "check_messages",
      description:
        `Check for messages from other agents in this run tree. Returns any new messages ` +
        `received since your last check. Use this to coordinate with sibling agents or ` +
        `receive updates from the parent agent.`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Optional: filter messages by topic. Omit to see all new messages.",
          },
        },
        required: [],
      },
      execute: async (args) => {
        const topic = args.topic ? String(args.topic) : undefined
        const messages = topic
          ? inbox.filter((m) => m.topic === topic)
          : [...inbox]

        // Drain the inbox (messages are consumed)
        inbox.length = 0

        if (messages.length === 0) {
          return "No new messages."
        }

        return messages
          .map((m) => `[${m.fromAgent}] (${m.topic}): ${m.content}`)
          .join("\n")
      },
    },
  ]
}

/**
 * Agent Message Bus — inter-agent communication within a run tree.
 *
 * When a parent agent delegates to multiple children, those children
 * (and the parent) sometimes need to coordinate:
 *   - A researcher agent finds something the writer agent needs
 *   - A child agent needs to ask the parent for clarification
 *   - Multiple parallel children need to avoid duplicating work
 *   - A child wants to ask a question and BLOCK on the answer
 *     (Question protocol + wait_for_response)
 *
 * Design choices
 * --------------
 *  - **Persistence-backed.** Every publish writes through to
 *    `agent_messages` (FK CASCADE on root run). Spawning a sibling
 *    later in the tree replays the full coordination so it sees
 *    prior Status / Result / Help messages without races. Reconnecting
 *    SSE clients can also rehydrate the BusFeed from history.
 *  - **One bus per root run.** Children share the parent's bus via the
 *    same root run id; lookups by `root_run_id` hit a covering index.
 *  - **Closed protocol set.** Free-form `topic` is preserved for
 *    domain channels, but every message also carries a `BusProtocol`
 *    discriminator (Status / Result / Help / Question / Answer /
 *    Broadcast) so the UI and parent agents can react to coordination
 *    intent without parsing prose.
 *  - **Help routes to a dedicated SSE event.** Anything published
 *    with `protocol: "help"` also fires `EventType.AgentHelpRequested`
 *    so the UI can surface it as an actionable card, separate from
 *    the firehose `AgentBusMessage` stream.
 */

import { EventType } from "@mia/shared-enums"
import * as db from "./adapters/persistence/sqlite.js"
import { BusProtocol } from "./enums/bus.js"
import { broadcast } from "./event-broadcaster.js"

import type { Tool } from "@mia/agent"

// ── Types ────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string
  topic: string
  fromRunId: string
  fromAgent: string
  protocol: BusProtocol
  content: string
  replyTo: string | null
  timestamp: number
}

type MessageHandler = (msg: AgentMessage) => void

function rowToMessage(row: db.AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    topic: row.topic,
    fromRunId: row.fromRunId,
    fromAgent: row.fromAgent,
    protocol: row.protocol,
    content: row.content,
    replyTo: row.replyTo,
    timestamp: row.createdAt
  }
}

// ── AgentBus ─────────────────────────────────────────────────────

export class AgentBus {
  readonly rootRunId: string
  private readonly subscribers = new Map<string, Set<MessageHandler>>()

  constructor(rootRunId: string) {
    this.rootRunId = rootRunId
  }

  /**
   * Publish a message. Writes through to SQLite, fans out to in-process
   * subscribers, and emits SSE so connected UIs see it in real time.
   * Help messages also fire `AgentHelpRequested` for prominent display.
   */
  publish(input: {
    topic: string
    fromRunId: string
    fromAgent: string
    content: string
    protocol?: BusProtocol
    replyTo?: string | null
  }): AgentMessage {
    const protocol = input.protocol ?? BusProtocol.Broadcast
    const row = db.insertAgentMessage({
      rootRunId: this.rootRunId,
      fromRunId: input.fromRunId,
      fromAgent: input.fromAgent,
      protocol,
      topic: input.topic,
      content: input.content,
      replyTo: input.replyTo ?? null
    })
    const msg = rowToMessage(row)

    this.dispatch(msg)
    this.emitSse(msg)
    return msg
  }

  private dispatch(msg: AgentMessage): void {
    const direct = this.subscribers.get(msg.topic)
    if (direct) for (const h of direct) h(msg)
    const wildcard = this.subscribers.get("*")
    if (wildcard) for (const h of wildcard) h(msg)
  }

  private emitSse(msg: AgentMessage): void {
    const payload = {
      runId: this.rootRunId,
      messageId: msg.id,
      topic: msg.topic,
      protocol: msg.protocol,
      fromRunId: msg.fromRunId,
      fromAgent: msg.fromAgent,
      content: msg.content,
      replyTo: msg.replyTo,
      timestamp: msg.timestamp
    }
    broadcast({ type: EventType.AgentBusMessage, data: payload })
    if (msg.protocol === BusProtocol.Help) {
      broadcast({ type: EventType.AgentHelpRequested, data: payload })
    }
  }

  /** Subscribe to a topic. Use "*" for all messages. Returns unsubscribe function. */
  subscribe(topic: string, handler: MessageHandler): () => void {
    let handlers = this.subscribers.get(topic)
    if (!handlers) {
      handlers = new Set()
      this.subscribers.set(topic, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
    }
  }

  /** Read message history from the persistent store (oldest first). */
  history(topic?: string): AgentMessage[] {
    const all = db.listAgentMessages(this.rootRunId).map(rowToMessage)
    if (!topic || topic === "*") return all
    return all.filter((m) => m.topic === topic)
  }

  /** Drain all subscribers (cleanup). DB rows are kept for audit/replay. */
  dispose(): void {
    this.subscribers.clear()
  }
}

// ── Agent communication tools ────────────────────────────────────

const PROTOCOL_PARAM_DESCRIPTION =
  `Coordination intent. One of: ` +
  `"status" (progress update), ` +
  `"result" (final answer for delegated goal), ` +
  `"help" (ask parent for intervention; surfaces in UI as Help Requested), ` +
  `"question" (ask sibling/parent; pair with wait_for_response), ` +
  `"answer" (reply to a question; requires reply_to), ` +
  `"broadcast" (informational, no reply expected). ` +
  `Defaults to "broadcast".`

function parseProtocol(value: unknown, fallback: BusProtocol = BusProtocol.Broadcast): BusProtocol {
  if (typeof value !== "string") return fallback
  switch (value) {
    case BusProtocol.Status:
      return BusProtocol.Status
    case BusProtocol.Result:
      return BusProtocol.Result
    case BusProtocol.Help:
      return BusProtocol.Help
    case BusProtocol.Question:
      return BusProtocol.Question
    case BusProtocol.Answer:
      return BusProtocol.Answer
    case BusProtocol.Broadcast:
      return BusProtocol.Broadcast
    default:
      return fallback
  }
}

/**
 * Create tools that let an agent send/receive messages on the bus.
 * Each agent gets its own set bound to its identity.
 */
export function createBusTools(bus: AgentBus, runId: string, agentName: string): Tool[] {
  // Live inbox — accumulates messages observed since this agent's last
  // check_messages call. Initialized from persisted history so a child
  // spawned mid-run-tree sees what siblings published before it existed.
  const inbox: AgentMessage[] = bus.history().filter((m) => m.fromRunId !== runId)

  bus.subscribe("*", (msg) => {
    if (msg.fromRunId === runId) return // don't echo own messages
    inbox.push(msg)
  })

  return [
    {
      name: "send_message",
      description:
        `Send a message to other agents in this run tree. ` +
        `Use the protocol parameter to declare intent (status/result/help/question/answer/broadcast). ` +
        `Help messages surface in the UI for human attention; Question messages can be paired ` +
        `with wait_for_response to block until a sibling/parent answers. Topics are free-form ` +
        `and useful for domain channels (e.g. "research-results", "schema-decisions").`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: `Topic/channel for the message. Use "broadcast" for all agents, or a specific topic like "research-results".`
          },
          content: {
            type: "string",
            description: "The message content. Be concise and specific."
          },
          protocol: {
            type: "string",
            enum: [...Object.values(BusProtocol)],
            description: PROTOCOL_PARAM_DESCRIPTION
          },
          reply_to: {
            type: "string",
            description:
              "Required when protocol='answer': the message id this is answering. Returned by check_messages / wait_for_response."
          }
        },
        required: ["topic", "content"]
      },
      execute: async (args) => {
        const topic = String(args["topic"])
        const content = String(args["content"])
        const protocol = parseProtocol(args["protocol"])
        const replyTo = args["reply_to"] ? String(args["reply_to"]) : null
        if (protocol === BusProtocol.Answer && !replyTo) {
          return `Error: protocol="answer" requires reply_to (the message id being answered).`
        }
        const msg = bus.publish({
          topic,
          fromRunId: runId,
          fromAgent: agentName,
          content,
          protocol,
          replyTo
        })
        return `Message ${msg.id} sent to topic "${topic}" with protocol "${protocol}".`
      }
    },
    {
      name: "check_messages",
      description:
        `Check for messages from other agents in this run tree. Returns any new messages ` +
        `received since your last check, including their id (use as reply_to in send_message ` +
        `with protocol="answer") and protocol. Use this to coordinate with siblings or receive ` +
        `updates from the parent.`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Optional: filter messages by topic. Omit to see all new messages."
          },
          protocol: {
            type: "string",
            enum: [...Object.values(BusProtocol)],
            description: "Optional: filter messages by protocol (e.g. only see questions)."
          }
        },
        required: []
      },
      execute: async (args) => {
        const topic = args["topic"] ? String(args["topic"]) : undefined
        const protocolFilter =
          typeof args["protocol"] === "string" ? parseProtocol(args["protocol"], BusProtocol.Broadcast) : null
        const matching = inbox.filter(
          (m) => (!topic || m.topic === topic) && (!protocolFilter || m.protocol === protocolFilter)
        )
        // Drain only the messages we actually returned
        for (const m of matching) {
          const idx = inbox.indexOf(m)
          if (idx >= 0) inbox.splice(idx, 1)
        }

        if (matching.length === 0) return "No new messages."

        return matching
          .map((m) => `[${m.fromAgent}] (${m.topic}, ${m.protocol}, id=${m.id}): ${m.content}`)
          .join("\n")
      }
    },
    {
      name: "wait_for_response",
      description:
        `Block until another agent publishes an Answer to a specific Question message you ` +
        `previously sent. Use this when you've sent a message with protocol="question" and ` +
        `cannot make progress without the reply. Returns the answer text and metadata, or a ` +
        `timeout marker if no answer arrives in time.`,
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "The id of your Question message (returned by send_message)."
          },
          timeout_ms: {
            type: "number",
            description:
              "How long to wait, in milliseconds. Defaults to 60000 (60s). Capped at 600000 (10 min)."
          }
        },
        required: ["message_id"]
      },
      execute: async (args) => {
        const messageId = String(args["message_id"] ?? "")
        if (!messageId) return "Error: 'message_id' is required."
        const requested = Number(args["timeout_ms"] ?? 60_000)
        const timeoutMs = Math.min(Math.max(1_000, requested), 600_000)

        // Fast path: check the persistent store first — an Answer might
        // already exist (sibling replied between send_message returning
        // and us calling wait_for_response).
        const existing = db.findReplyTo(messageId)
        if (existing) {
          return `[${existing.fromAgent}] (answer to ${messageId}): ${existing.content}`
        }

        return await new Promise<string>((resolve) => {
          let settled = false
          const finish = (text: string) => {
            if (settled) return
            settled = true
            unsubscribe()
            clearTimeout(timer)
            resolve(text)
          }
          const unsubscribe = bus.subscribe("*", (msg) => {
            if (msg.protocol !== BusProtocol.Answer) return
            if (msg.replyTo !== messageId) return
            finish(`[${msg.fromAgent}] (answer to ${messageId}): ${msg.content}`)
          })
          const timer = setTimeout(
            () => finish(`Timeout: no answer to ${messageId} within ${timeoutMs}ms.`),
            timeoutMs
          )
        })
      }
    }
  ]
}

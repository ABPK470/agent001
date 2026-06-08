/**
 * Persistence layer for the inter-agent bus.
 *
 * AgentBus writes through to this repo on publish and reads from it on
 * construction, so spawning a sibling later in the run tree (or
 * reconnecting an SSE client) replays the full coordination history.
 *
 * Lifecycle is run-scoped: rows are deleted by FK CASCADE when the
 * root run is purged. There is no separate retention policy.
 */

import { randomUUID } from "node:crypto"
import { BusProtocol, isBusProtocol } from "../../../enums/bus.js"
import { getDb } from "./connection.js"

export interface AgentMessageRow {
  id: string
  rootRunId: string
  fromRunId: string
  fromAgent: string
  protocol: BusProtocol
  topic: string
  content: string
  replyTo: string | null
  createdAt: number
}

interface RawRow {
  id: string
  root_run_id: string
  from_run_id: string
  from_agent: string
  protocol: string
  topic: string
  content: string
  reply_to: string | null
  created_at: string
}

function fromRaw(r: RawRow): AgentMessageRow {
  // `protocol` is constrained by a CHECK at the DB level; isBusProtocol
  // only re-validates so the in-memory union narrowing stays sound even
  // if the DB file was tampered with out-of-band.
  const protocol = isBusProtocol(r.protocol) ? r.protocol : BusProtocol.Broadcast
  return {
    id: r.id,
    rootRunId: r.root_run_id,
    fromRunId: r.from_run_id,
    fromAgent: r.from_agent,
    protocol,
    topic: r.topic,
    content: r.content,
    replyTo: r.reply_to,
    createdAt: Number(new Date(r.created_at))
  }
}

export interface InsertMessageInput {
  rootRunId: string
  fromRunId: string
  fromAgent: string
  protocol: BusProtocol
  topic: string
  content: string
  replyTo?: string | null
}

/** Insert a message and return the row that was written (with assigned id + timestamp). */
export function insertAgentMessage(input: InsertMessageInput): AgentMessageRow {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const db = getDb()
  db.prepare(
    `
    INSERT INTO agent_messages (id, root_run_id, from_run_id, from_agent, protocol, topic, content, reply_to, created_at)
    VALUES (@id, @root, @from_run, @from_agent, @protocol, @topic, @content, @reply_to, @created_at)
  `
  ).run({
    id,
    root: input.rootRunId,
    from_run: input.fromRunId,
    from_agent: input.fromAgent,
    protocol: input.protocol,
    topic: input.topic,
    content: input.content,
    reply_to: input.replyTo ?? null,
    created_at: createdAt
  })
  return {
    id,
    rootRunId: input.rootRunId,
    fromRunId: input.fromRunId,
    fromAgent: input.fromAgent,
    protocol: input.protocol,
    topic: input.topic,
    content: input.content,
    replyTo: input.replyTo ?? null,
    createdAt: Number(new Date(createdAt))
  }
}

/** Load every message for a root run, oldest first. */
export function listAgentMessages(rootRunId: string): AgentMessageRow[] {
  const rows = getDb()
    .prepare(
      `
    SELECT id, root_run_id, from_run_id, from_agent, protocol, topic, content, reply_to, created_at
      FROM agent_messages
     WHERE root_run_id = ?
     ORDER BY created_at ASC, id ASC
  `
    )
    .all(rootRunId) as RawRow[]
  return rows.map(fromRaw)
}

/** Find a single Answer that replies to the given message id. NULL if none yet. */
export function findReplyTo(messageId: string): AgentMessageRow | null {
  const row = getDb()
    .prepare(
      `
    SELECT id, root_run_id, from_run_id, from_agent, protocol, topic, content, reply_to, created_at
      FROM agent_messages
     WHERE reply_to = ?
       AND protocol = 'answer'
     ORDER BY created_at ASC, id ASC
     LIMIT 1
  `
    )
    .get(messageId) as RawRow | undefined
  return row ? fromRaw(row) : null
}

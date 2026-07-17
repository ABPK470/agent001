/**
 * Queue / bus contracts owned by the server.
 * Infra provides the concrete `RunQueue` and `AgentBus` implementations.
 */

import type { BusProtocol } from "../internal/enums/bus.js"
import { RunPriority } from "../internal/enums/queue.js"

export { RunPriority }

export interface QueueStats {
  concurrency: number
  active: number
  queued: number
  totalProcessed: number
  totalDropped: number
  entries: Array<{ runId: string; priority: RunPriority; waitingMs: number }>
}

/** Scheduling port for agent runs (concurrency + priority). */
export interface RunQueuePort {
  acquire(
    runId: string,
    priority?: RunPriority,
    signal?: AbortSignal
  ): Promise<() => void>
  remove(runId: string): boolean
  stats(): QueueStats
}

export interface AgentBusMessage {
  id: string
  topic: string
  fromRunId: string
  fromAgent: string
  protocol: BusProtocol
  content: string
  replyTo: string | null
  timestamp: number
}

/** Inter-agent message bus for a root run tree. */
export interface AgentBusPort {
  readonly rootRunId: string
  publish(input: {
    topic: string
    fromRunId: string
    fromAgent: string
    content: string
    protocol?: BusProtocol
    replyTo?: string | null
  }): AgentBusMessage
  subscribe(topic: string, handler: (msg: AgentBusMessage) => void): () => void
  history(topic?: string): AgentBusMessage[]
  dispose(): void
}

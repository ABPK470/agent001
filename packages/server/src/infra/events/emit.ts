import type { SseEvent } from "@mia/shared-types"

type BroadcastSink = (event: SseEvent) => void

const sinkState: { current: BroadcastSink | null } = { current: null }

/** Wire the SSE broadcaster at server boot — keeps LLM modules off the persistence graph. */
export function registerSseBroadcastSink(fn: BroadcastSink): void {
  sinkState.current = fn
}

export function emitSseEvent(event: Omit<SseEvent, "timestamp">): void {
  sinkState.current?.({ ...event, timestamp: new Date().toISOString() })
}

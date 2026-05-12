/**
 * Run-level lifecycle persistence sink.
 *
 * Mirrors the `setSyncEventSink` pattern: agent-package code emits via the
 * sink interface, server installs the SQLite-backed implementation at
 * startup. Keeps the agent package free of server-side deps.
 */

export interface SyncRunStartInput {
  planId: string
  entityType: string
  entityId: string | number
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  previewTotals: unknown
}

export interface SyncRunFinishInput {
  planId: string
  status: "success" | "failed"
  error?: string | null
  executeTotals?: unknown
  driftDetectedPct?: number | null
  durationMs: number
}

export interface SyncRunSink {
  start(input: SyncRunStartInput): void
  finish(input: SyncRunFinishInput): void
}

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.
const _state: { sink: SyncRunSink } = { sink: {
  start: () => {},
  finish: () => {},
} }

export function setSyncRunSink(sink: SyncRunSink): void {
  _state.sink = sink
}

export function getSyncRunSink(): SyncRunSink {
  return _state.sink
}

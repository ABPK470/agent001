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

let _sink: SyncRunSink = {
  start: () => {},
  finish: () => {},
}

export function setSyncRunSink(sink: SyncRunSink): void {
  _sink = sink
}

export function getSyncRunSink(): SyncRunSink {
  return _sink
}

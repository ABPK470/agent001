/**
 * Run-level lifecycle persistence sink.
 *
 * Mirrors the `setSyncEventSink` pattern: agent-package code emits via the
 * sink interface, server installs the SQLite-backed implementation at
 * startup. Keeps the agent package free of server-side deps.
 */

import { SyncRunStatus } from "../domain/index.js"
import type { AgentHost } from "../host/index.js"
import type { SyncPlan } from "./plan-store.js"

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
  status: typeof SyncRunStatus.Success | typeof SyncRunStatus.Failed
  error?: string | null
  executeTotals?: unknown
  driftDetectedPct?: number | null
  durationMs: number
}

export interface SyncRunSink {
  start(input: SyncRunStartInput): void
  finish(input: SyncRunFinishInput): void
  /**
   * Persist a plan body for later re-hydration (durable history).
   * Optional — when absent, plans only survive in memory + disk JSON
   * (subject to the in-process plan-store TTL).
   */
  savePlan?(plan: SyncPlan): void
  /**
   * Re-hydrate a plan body that's no longer in memory or on disk
   * (e.g. after server restart). Optional fallback for `loadPlan`.
   */
  loadPlan?(planId: string): SyncPlan | null
}

/** Server installs this once at startup. */
export function setSyncRunSink(host: AgentHost, sink: SyncRunSink): void {
  host.sync.runSink = sink
}

export function getSyncRunSink(host: AgentHost): SyncRunSink {
  return host.sync.runSink
}

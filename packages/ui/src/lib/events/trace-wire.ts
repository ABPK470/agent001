/**
 * Trace wire normalizer — REST envelopes `{ seq, createdAt, entry }` or bare TraceEntry[].
 */

import type { TraceEntry, TraceEnvelope } from "@mia/shared-types"

export type NormalizedTraceWire = {
  entries: TraceEntry[]
  /** Parallel to entries; null when wall-clock unknown (legacy bare array / live gap). */
  createdAtMs: Array<number | null>
}

function isTraceEnvelope(value: unknown): value is TraceEnvelope {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.seq === "number" &&
    typeof v.createdAt === "string" &&
    v.entry != null &&
    typeof v.entry === "object" &&
    typeof (v.entry as { kind?: unknown }).kind === "string"
  )
}

function isTraceEntry(value: unknown): value is TraceEntry {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { kind?: unknown }).kind === "string"
  )
}

/** Accept envelope rows or legacy bare TraceEntry rows. */
export function normalizeTraceWire(raw: unknown[]): NormalizedTraceWire {
  const entries: TraceEntry[] = []
  const createdAtMs: Array<number | null> = []
  for (const item of raw) {
    if (isTraceEnvelope(item)) {
      entries.push(item.entry)
      const ms = Date.parse(item.createdAt)
      createdAtMs.push(Number.isFinite(ms) ? ms : null)
      continue
    }
    if (isTraceEntry(item)) {
      entries.push(item)
      createdAtMs.push(null)
    }
  }
  return { entries, createdAtMs }
}

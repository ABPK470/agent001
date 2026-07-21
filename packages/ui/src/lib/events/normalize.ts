/**
 * Normalize wire TraceEntry / SSE payloads into EventAtom[].
 */

import type { TraceEntry } from "@mia/shared-types"
import type { EventAtom, EventAtomSource } from "./types"

function asPayload(entry: TraceEntry): Record<string, unknown> {
  return { ...(entry as unknown as Record<string, unknown>) }
}

/** One TraceEntry → EventAtom (seq = index unless overridden). */
export function atomFromTraceEntry(
  entry: TraceEntry,
  opts: { seq: number; t?: number; runId?: string; id?: string } ,
): EventAtom {
  return {
    id: opts.id ?? `trace-${opts.seq}-${entry.kind}`,
    seq: opts.seq,
    t: opts.t ?? opts.seq,
    source: "trace",
    type: entry.kind,
    runId: opts.runId,
    payload: asPayload(entry),
  }
}

/** Full run trace → atoms in order. */
export function atomsFromTrace(
  trace: TraceEntry[],
  opts?: { runId?: string; t0?: number },
): EventAtom[] {
  const t0 = opts?.t0 ?? 0
  return trace.map((entry, seq) =>
    atomFromTraceEntry(entry, {
      seq,
      t: t0 + seq,
      runId: opts?.runId,
    }),
  )
}

/** SSE firehose row → EventAtom. */
export function atomFromSse(opts: {
  type: string
  data: Record<string, unknown>
  seq: number
  t?: number
  runId?: string
  id?: string
  source?: EventAtomSource
}): EventAtom {
  const runId =
    opts.runId ??
    (typeof opts.data.runId === "string" ? opts.data.runId : undefined)
  return {
    id: opts.id ?? `sse-${opts.seq}-${opts.type}`,
    seq: opts.seq,
    t: opts.t ?? opts.seq,
    source: opts.source ?? "sse",
    type: opts.type,
    runId,
    payload: opts.data,
  }
}

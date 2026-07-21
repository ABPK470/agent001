/**
 * Flat log rows from EventAtom[] — Event Stream / firehose dialect.
 */

import { lookupEventDescriptor, type EventPayload } from "@mia/shared-types"
import type { EventAtom, FlatLogRow } from "./types"

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

/** One atom → flat log row via catalog (unknown → JSON preview). */
export function flatRowFromAtom(atom: EventAtom): FlatLogRow {
  let type = atom.type
  let payload = atom.payload

  if (type === "debug.trace" && payload.entry && typeof payload.entry === "object") {
    const inner = payload.entry as EventPayload
    const kind = str(inner.kind)
    if (kind) {
      type = kind
      payload = inner
    }
  }

  const d = lookupEventDescriptor(type)
  let message = d.summary(payload)
  if (d.id === "unknown" || (message === "event" && Object.keys(payload).length > 0)) {
    try {
      const raw = JSON.stringify(payload)
      message = raw.length > 120 ? `${raw.slice(0, 119)}…` : raw
    } catch {
      message = d.label
    }
  }

  return {
    id: atom.id,
    type,
    label: d.label,
    message,
    severity: d.severity,
    t: atom.t,
    runId: atom.runId,
    payload,
  }
}

export function buildFlatLog(atoms: EventAtom[]): FlatLogRow[] {
  return atoms
    .map(flatRowFromAtom)
    .filter((row) => lookupEventDescriptor(row.type).outline !== "ignore")
}

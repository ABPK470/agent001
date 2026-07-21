/**
 * Flat log rows from EventAtom[] — Event Stream / firehose dialect.
 */

import { lookupEventDescriptor, type EventPayload } from "@mia/shared-types"
import type { EventAtom, FlatLogRow, ViewSpec } from "./types"
import { resolveOutlineRole } from "./types"

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

/** Default flat-log view — no hierarchy; omit wire noise. */
export const FLAT_LOG_VIEW_SPEC: ViewSpec = {
  id: "flat-log",
  excludeTypes: ["answer.chunk"],
  excludeFamilies: ["telemetry"],
  roleByFamily: {},
  nest: [],
  foldDefault: "expanded",
}

/** One atom → flat log row via catalog (unknown → JSON preview). */
export function flatRowFromAtom(atom: EventAtom, viewSpec: ViewSpec = FLAT_LOG_VIEW_SPEC): FlatLogRow | null {
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
  if (resolveOutlineRole(type, d.family, viewSpec) === "omit") return null

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

export function buildFlatLog(
  atoms: EventAtom[],
  viewSpec: ViewSpec = FLAT_LOG_VIEW_SPEC,
): FlatLogRow[] {
  const rows: FlatLogRow[] = []
  for (const atom of atoms) {
    const row = flatRowFromAtom(atom, viewSpec)
    if (row) rows.push(row)
  }
  return rows
}

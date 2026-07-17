import { getDb } from "../../../infra/persistence/sqlite.js"
import { TrajectoryEditOperation } from "../../../internal/enums/trajectory.js"
import type { Mutation, Trajectory, TrajectoryEvent } from "./types.js"

// ── Loader ───────────────────────────────────────────────────────

/** Load the full trajectory for a run. */
export function loadTrajectory(runId: string): Trajectory {
  const rows = getDb()
    .prepare("SELECT seq, data, created_at FROM trace_entries WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ seq: number; data: string; created_at: string }>

  const events = rows
    .map((row) => {
      try {
        const event = JSON.parse(row.data) as TrajectoryEvent
        return { seq: row.seq, event, timestamp: row.created_at }
      } catch {
        return null
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  return { runId, events }
}

// ── Mutations ────────────────────────────────────────────────────

/** Apply mutations to a trajectory (returns a new trajectory, no side effects). */
export function applyMutations(trajectory: Trajectory, mutations: Mutation[]): Trajectory {
  let events = [...trajectory.events]

  // Sort mutations by seq descending so inserts/drops don't shift later indices
  const sorted = [...mutations].sort((a, b) => b.seq - a.seq)

  for (const mut of sorted) {
    switch (mut.type) {
      case TrajectoryEditOperation.Drop:
        events = events.filter((e) => e.seq !== mut.seq)
        break
      case TrajectoryEditOperation.Replace: {
        const replacement = mut.event
        const idx = events.findIndex((e) => e.seq === mut.seq)
        if (idx >= 0) {
          events[idx] = { ...events[idx], event: replacement }
        }
        break
      }
      case TrajectoryEditOperation.Inject: {
        const injected = mut.event
        const insertIdx = events.findIndex((e) => e.seq >= mut.seq)
        const entry = {
          seq: mut.seq,
          event: injected,
          timestamp: new Date().toISOString()
        }
        if (insertIdx >= 0) {
          events.splice(insertIdx, 0, entry)
        } else {
          events.push(entry)
        }
        break
      }
    }
  }

  // Re-number sequences
  events = events.map((e, i) => ({ ...e, seq: i }))

  return { runId: trajectory.runId, events }
}

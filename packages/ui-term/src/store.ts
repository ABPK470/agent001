/**
 * Term-UI store — small zustand atom focused on what the two-pane shell
 * actually renders.
 *
 *  - `events` is the unified operations log. Every SSE envelope flows in
 *    here, deduped & capped at MAX_EVENTS. The right-pane filter slices
 *    over this single buffer.
 *  - `transcript` is what the LEFT pane shows for the active run: an
 *    ordered list of human-readable rows derived from the same events,
 *    filtered to the active runId.
 *  - `streaming` is the live LLM answer being typed in token-by-token.
 *  - `pendingInput` mirrors classic UI's ask_user contract.
 */

import { create } from "zustand"
import { api } from "./api"
import type { Run, SseEvent } from "./types"

const MAX_EVENTS = 5000

export type TranscriptKind =
  | "goal"
  | "thinking"
  | "tool"
  | "tool-result"
  | "tool-error"
  | "answer"
  | "error"
  | "user-input"
  | "info"

export interface TranscriptRow {
  id: string
  runId: string
  kind: TranscriptKind
  text: string
  meta?: string         // small right-aligned tag (e.g. "12ms", "47 tk")
  timestamp: string
  toolCallId?: string   // correlates tool_call.executing ↔ tool_call.completed for parallel calls
}

interface State {
  connected: boolean
  setConnected: (v: boolean) => void

  runs: Run[]
  activeRunId: string | null
  setRuns: (r: Run[]) => void
  setActiveRun: (id: string | null) => void
  upsertRun: (r: Partial<Run> & { id: string }) => void

  events: SseEvent[]
  _eventSeen: Set<string>  // dedup guard — not for rendering
  transcript: TranscriptRow[]
  streamingAnswer: string

  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null

  platformThreadId: string | null
  ensurePlatformThread: () => Promise<string>

  pushEvent: (e: SseEvent) => void
  /** Replay historical events into the transcript only — does NOT touch the ops events buffer. */
  hydrateTranscript: (events: SseEvent[], runId: string) => void
  clearStream: () => void
  resetTranscript: (runId: string | null) => void
  clearPendingInput: () => void
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  setConnected: (v) => set({ connected: v }),

  runs: [],
  activeRunId: null,
  setRuns: (runs) => set({ runs }),
  setActiveRun: (id) => set({ activeRunId: id }),
  upsertRun: (r) => set((s) => {
    const idx = s.runs.findIndex((x) => x.id === r.id)
    if (idx === -1) {
      return { runs: [{ ...emptyRun(r.id), ...r } as Run, ...s.runs] }
    }
    const next = [...s.runs]
    next[idx] = { ...next[idx], ...r } as Run
    return { runs: next }
  }),

  events: [],
  transcript: [],
  streamingAnswer: "",
  pendingInput: null,
  platformThreadId: null,
  ensurePlatformThread: async () => {
    const cached = get().platformThreadId
    if (cached) return cached
    const thread = await api.createThread("Platform")
    set({ platformThreadId: thread.id })
    return thread.id
  },
  // Keys of events already in the events array — prevents backfill+SSE overlap dupes.
  _eventSeen: new Set<string>(),

  pushEvent: (e) => {
    const state = get()

    // Dedup across all sources (backfill, SSE, synthetic). Same key function
    // as the SSE stream's internal dedup but shared so backfill∩SSE overlap
    // is caught at the store level.
    const seq = e.data["seq"] ?? ""
    const kind = e.type === "debug.trace"
      ? ((e.data["entry"] as Record<string, unknown> | undefined)?.["kind"] ?? "")
      : ""
    const ek = `${e.type}:${e.timestamp}:${String(e.data["runId"] ?? "")}:${String(e.data["stepId"] ?? "")}:${kind}:${seq}`
    if (state._eventSeen.has(ek)) return
    const nextSeen = new Set(state._eventSeen)
    nextSeen.add(ek)
    if (nextSeen.size > 3000) {
      // Evict oldest 1000 keys — keeps memory bounded
      const arr = [...nextSeen]
      arr.splice(0, 1000)
      nextSeen.clear()
      arr.forEach((k) => nextSeen.add(k))
    }
    // Always append to the unified ops log (capped).
    const events = state.events.length >= MAX_EVENTS
      ? [...state.events.slice(-MAX_EVENTS + 1), e]
      : [...state.events, e]

    const patch: Partial<State> = { events, _eventSeen: nextSeen }

    // Maintain `runs` for run lifecycle events
    if (e.type === "run.queued") {
      // run.queued is the ONLY event that carries the goal text on the wire.
      // Store the run immediately so that run.started (which has no goal) can
      // fall back to state.runs to retrieve it.
      const id = String(e.data["runId"] ?? "")
      const goal = String(e.data["goal"] ?? "")
      if (id && !state.runs.find((r) => r.id === id)) {
        patch.runs = [emptyRun(id, goal, "pending", e.timestamp), ...state.runs]
      }
      if (!state.activeRunId) patch.activeRunId = id
    } else if (e.type === "run.started") {
      const id = String(e.data["runId"] ?? "")
      const goal = String(e.data["goal"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        const base: Run = idx === -1
          ? emptyRun(id, goal, "running", e.timestamp)
          : { ...state.runs[idx]!, status: "running" }
        const next = idx === -1 ? [base, ...state.runs] : (() => { const n = [...state.runs]; n[idx] = base; return n })()
        patch.runs = next
        // Auto-focus newly started run if nothing focused.
        if (!state.activeRunId) patch.activeRunId = id
      }
    } else if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") {
      const id = String(e.data["runId"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        if (idx !== -1) {
          const hasSubErrors = e.type === "run.completed"
            && state.events.some((ev) =>
              String(ev.data["runId"] ?? "") === id
              && (ev.type.includes("failed") || ev.type.includes(".error"))
            )
          const status = e.type === "run.completed" ? (hasSubErrors ? "partial_success" : "completed")
            : e.type === "run.failed" ? "failed"
            : "cancelled"
          const next = [...state.runs]
          next[idx] = {
            ...next[idx]!,
            status,
            answer: (e.data["answer"] as string | undefined) ?? next[idx]!.answer,
            error:  (e.data["error"]  as string | undefined) ?? next[idx]!.error,
            completedAt: e.timestamp,
          }
          patch.runs = next
        }
      }
    } else if (e.type === "answer.chunk" || e.type === "agent.chunk") {
      // Streaming LLM output for the active run.
      const runId = String(e.data["runId"] ?? "")
      if (runId === state.activeRunId) {
        const chunk = String(e.data["chunk"] ?? "")
        if (chunk) patch.streamingAnswer = state.streamingAnswer + chunk
      }
    } else if (e.type === "usage.updated") {
      // Live token/call counters — update the matching run record so the stats bar stays fresh
      const id = String(e.data["runId"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        if (idx !== -1) {
          const next = [...state.runs]
          next[idx] = {
            ...next[idx]!,
            totalTokens:       Number(e.data["totalTokens"]       ?? next[idx]!.totalTokens),
            promptTokens:      Number(e.data["promptTokens"]      ?? next[idx]!.promptTokens),
            completionTokens:  Number(e.data["completionTokens"]  ?? next[idx]!.completionTokens),
            llmCalls:          Number(e.data["llmCalls"]          ?? next[idx]!.llmCalls),
          }
          patch.runs = next
        }
      }
    } else if (e.type === "delegation.iteration") {
      // Live iteration counter
      const id = String(e.data["runId"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        if (idx !== -1) {
          const next = [...(patch.runs ?? state.runs)]
          next[idx] = {
            ...next[idx]!,
            lastIteration: Number(e.data["iteration"] ?? 0),
            maxIterations:  Number(e.data["maxIterations"] ?? 0),
          }
          patch.runs = next
        }
      }
    } else if (e.type === "planner.started") {
      // Mark that a planner was used for this run
      const id = String(e.data["runId"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        if (idx !== -1) {
          const next = [...(patch.runs ?? state.runs)]
          next[idx] = { ...next[idx]!, usedPlanner: true }
          patch.runs = next
        }
      }
    } else if (e.type === "step.completed" || e.type === "tool_call.completed" || e.type === "tool.result") {
      // Increment stepCount on the matching run for live step tracking
      const id = String(e.data["runId"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        if (idx !== -1) {
          const next = [...(patch.runs ?? state.runs)]
          next[idx] = { ...next[idx]!, stepCount: (next[idx]!.stepCount ?? 0) + 1 }
          patch.runs = next
        }
      }
    }

    // Build transcript row if relevant for active run.
    // Use patch.activeRunId when available — run.started sets patch.activeRunId
    // in the same tick, before set() is called, so state.activeRunId is still
    // the old value (null or previous run). Without this, the goal row and the
    // first few tool rows for a brand-new run are always dropped.
    const effectiveActiveRunId = (patch.activeRunId as string | null | undefined) ?? state.activeRunId
    const row = toTranscriptRow(e, state)
    if (row && row.runId === effectiveActiveRunId) {
      // De-dupe goal: server replays `run.started` from both the
      // global event backlog and the per-run log hydration, so the
      // same row would appear twice. Only keep the first.
      const isDupGoal = row.kind === "goal" &&
        state.transcript.some((r) => r.kind === "goal" && r.runId === row.runId)
      if (!isDupGoal) {
        patch.transcript = [...state.transcript, row]
      }
      // Reset stream once final answer arrives
      if (row.kind === "answer" || row.kind === "error") patch.streamingAnswer = ""
    }

    // ask_user prompt — server sends user_input.required; older paths use agent.ask_user / tool.ask_user
    if (e.type === "agent.ask_user" || e.type === "tool.ask_user" || e.type === "user_input.required") {
      const runId = String(e.data["runId"] ?? "")
      const question = String(e.data["question"] ?? "")
      if (runId && question) {
        patch.pendingInput = {
          runId,
          question,
          options: e.data["options"] as string[] | undefined,
          sensitive: !!e.data["sensitive"],
        }
      }
    }

    set(patch)
  },

  hydrateTranscript: (eventsToReplay, runId) => {
    const state = get()
    if (state.activeRunId !== runId) return  // stale replay — user switched run
    const rows: TranscriptRow[] = []
    const seen = new Set(state.transcript.map((r) => r.id))
    for (const e of eventsToReplay) {
      const row = toTranscriptRow(e, state)
      if (!row || row.runId !== runId || seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
    if (!rows.length) return
    const merged = [...state.transcript, ...rows]
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    set({ transcript: merged })
  },

  clearStream: () => set({ streamingAnswer: "" }),
  resetTranscript: (runId) => set((state) => ({
    // Preserve any rows that already arrived via SSE for this run (race between
    // api.startRun response and the SSE stream delivering run.started/goal).
    // Also clear _eventSeen so that a subsequent replay via searchEvents can
    // re-push events that were already in the seen-set from a prior visit.
    transcript: state.transcript.filter((r) => r.runId === runId),
    streamingAnswer: "",
    activeRunId: runId,
    _eventSeen: new Set<string>(),
  })),
  clearPendingInput: () => set({ pendingInput: null }),
}))

// ── helpers ──────────────────────────────────────────────────────

function emptyRun(id: string, goal = "", status = "pending", createdAt = new Date().toISOString()): Run {
  return {
    id, goal, status, answer: null, stepCount: 0, error: null,
    createdAt, completedAt: null,
    totalTokens: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0,
  }
}

function summarizeSqlQualityEvent(entry: Record<string, unknown>): string {
  const notes: string[] = []
  const validationCode = typeof entry["validationCode"] === "string" ? entry["validationCode"] : null
  const missingMirrors = Array.isArray(entry["missingPersistedMirrorCandidates"])
    ? (entry["missingPersistedMirrorCandidates"] as string[])
    : []
  const tempScalarSubqueryCount = Number(entry["tempScalarSubqueryCount"] ?? 0)
  const largeObjectRefs = Array.isArray(entry["largeObjectRefs"])
    ? (entry["largeObjectRefs"] as Array<{ name?: string; count?: number }>).filter((ref) => Number(ref.count ?? 0) > 2)
    : []

  if (validationCode) notes.push(`blocked by ${validationCode}`)
  if (missingMirrors.length > 0) notes.push(`missed mirror ${missingMirrors.join(", ")}`)
  if (largeObjectRefs.length > 0) notes.push(largeObjectRefs.map((ref) => `${ref.name ?? "object"} ${Number(ref.count ?? 0)}x`).join(", "))
  if (tempScalarSubqueryCount > 0) notes.push(`temp subqueries ${tempScalarSubqueryCount}`)
  if (notes.length > 0) return notes.join(" · ")
  return String(entry["phase"] ?? "checked")
}

function toTranscriptRow(e: SseEvent, state?: State): TranscriptRow | null {
  const runId = String(e.data["runId"] ?? "")
  if (!runId) return null
  const id = `${e.type}:${e.timestamp}:${e.data["seq"] ?? Math.random()}`
  const ts = e.timestamp

  if (e.type === "debug.trace") {
    const entry = e.data["entry"] as Record<string, unknown> | undefined
    if ((entry?.["kind"] as string | undefined) === "planner-sql-quality") {
      const text = `SQL quality — ${summarizeSqlQualityEvent(entry)}`
      const blocked = typeof entry["validationCode"] === "string" || entry["phase"] === "blocked"
      return { id, runId, kind: blocked ? "tool-error" : "info", text, timestamp: ts }
    }
    if ((entry?.["kind"] as string | undefined) === "planner-prompt-budget") {
      const before = Number(entry["totalBeforeChars"] ?? 0)
      const after = Number(entry["totalAfterChars"] ?? 0)
      const dropped = Array.isArray(entry["droppedSections"]) ? (entry["droppedSections"] as string[]) : []
      const tail = dropped.length > 0 ? ` · dropped=${dropped.join(",")}` : ""
      return {
        id,
        runId,
        kind: "info",
        text: `Prompt budget · ${before.toLocaleString()} → ${after.toLocaleString()} chars${tail}`,
        timestamp: ts,
      }
    }
  }

  switch (e.type) {
    case "run.started": {
      // run.started has no goal in the payload — look it up from state.runs,
      // which run.queued already populated.
      const goal = String(
        e.data["goal"] ??
        state?.runs.find((r) => r.id === runId)?.goal ??
        "",
      )
      return { id, runId, kind: "goal", text: goal, timestamp: ts }
    }
    case "agent.thinking":
      // server sends `content`, not `text` (run-executor.ts broadcasts { content: entry.text })
      return { id, runId, kind: "thinking", text: String(e.data["content"] ?? e.data["text"] ?? "thinking…"), timestamp: ts }
    case "tool.call":
    case "agent.tool_call":
    case "step.started":
    case "tool_call.executing": {
      const tool = String(e.data["tool"] ?? e.data["toolName"] ?? e.data["action"] ?? e.data["name"] ?? "tool")
      const args = e.data["argsSummary"] ?? e.data["input"] ?? e.data["args"] ?? ""
      const a = typeof args === "string" ? args : JSON.stringify(args)
      const toolCallId = e.data["toolCallId"] ? String(e.data["toolCallId"]) : undefined
      return { id, runId, kind: "tool", text: `${tool}  ${a}`.trim(), timestamp: ts, toolCallId }
    }
    case "tool.result":
    case "agent.tool_result":
    case "step.completed":
    case "tool_call.completed": {
      const tool = String(e.data["tool"] ?? e.data["toolName"] ?? e.data["action"] ?? e.data["name"] ?? "")
      const out = e.data["output"] as Record<string, unknown> | undefined
      const summary = String(
        e.data["summary"] ??
        e.data["text"] ??
        (out && typeof out["result"] === "string" ? out["result"] : "") ??
        "",
      )
      const ms = e.data["durationMs"] as number | undefined
      const toolCallId = e.data["toolCallId"] ? String(e.data["toolCallId"]) : undefined
      return {
        id, runId, kind: "tool-result",
        text: summary || (tool ? `↳ ${tool} ok` : "↳ ok"),
        meta: ms != null ? `${ms}ms` : undefined,
        timestamp: ts,
        toolCallId,
      }
    }
    case "tool.error":
    case "agent.tool_error":
    case "step.failed":
      return { id, runId, kind: "tool-error", text: String(e.data["error"] ?? e.data["text"] ?? ""), timestamp: ts }
    // ── Planner activity rows ────────────────────────────────────────────────
    // These keep the transcript alive during planner runs (which are otherwise
    // silent because child-agent step events carry child runIds, not parent's).
    case "planner.started":
      return { id, runId, kind: "thinking", text: `planning… route=${String(e.data["route"] ?? "?")} score=${String(e.data["score"] ?? "?")}`, timestamp: ts }
    case "planner.step.started":
      return { id, runId, kind: "tool", text: `step: ${String(e.data["stepName"] ?? "?")}  (${String(e.data["stepType"] ?? "delegate")})`, timestamp: ts }
    case "planner.step.completed": {
      const stepStatus = String(e.data["status"] ?? "done")
      const stepMs = e.data["durationMs"] as number | undefined
      return { id, runId, kind: "tool-result", text: `↳ ${String(e.data["stepName"] ?? "step")} → ${stepStatus}`, meta: stepMs != null ? `${stepMs}ms` : undefined, timestamp: ts }
    }
    case "delegation.started":
    case "planner.delegation.started":
      return { id, runId, kind: "thinking", text: `→ delegating: ${String(e.data["agentName"] ?? e.data["stepName"] ?? "child")} (depth ${String(e.data["depth"] ?? "?")})`, timestamp: ts }
    case "delegation.ended": {
      const delStatus = String(e.data["status"] ?? "done")
      const delErr = e.data["error"] ? ` — ${String(e.data["error"]).slice(0, 80)}` : ""
      const delKind: TranscriptKind = (e.data["status"] === "failed" || e.data["error"]) ? "tool-error" : "tool-result"
      return { id, runId, kind: delKind, text: `← ${delStatus}${delErr}`.trim(), timestamp: ts }
    }
    case "run.completed":
      return { id, runId, kind: "answer", text: String(e.data["answer"] ?? ""), timestamp: ts }
    case "run.failed":
      return { id, runId, kind: "error", text: String(e.data["error"] ?? "failed"), timestamp: ts }
    case "agent.ask_user":
    case "tool.ask_user":
      return { id, runId, kind: "user-input", text: String(e.data["question"] ?? ""), timestamp: ts }
    default:
      return null
  }
}

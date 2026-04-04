/**
 * TrajectoryReplay — full debugging tool for agent run trajectories.
 *
 * Three modes (tabs):
 *   1. Replay — step-through with VCR controls, validation, scorecard
 *   2. Mutations — drop/replace/inject events, replay mutated trace
 *   3. Compare — side-by-side comparison of two runs
 */

import {
    AlertTriangle,
    ArrowLeftRight,
    ChevronLeft,
    ChevronRight,
    Circle,
    FlaskConical,
    Pause,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    SkipBack,
    SkipForward,
    Trash2,
    Undo2,
    X,
} from "lucide-react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { RollbackPreview, Run } from "../types"
import { timeAgo, truncate } from "../util"

// ── Types ────────────────────────────────────────────────────────

type EventKind =
  | "goal" | "thinking" | "tool-call" | "tool-result"
  | "tool-error" | "iteration" | "delegation-start"
  | "delegation-end" | "delegation-iteration" | "usage"
  | "delegation-parallel-start" | "delegation-parallel-end"
  | "answer" | "error"
  | "system-prompt" | "tools-resolved" | "llm-request" | "llm-response"
  | "user-input-request" | "user-input-response"

interface TrajectoryEvent { kind: EventKind; [key: string]: unknown }
interface TrajectoryEntry { seq: number; event: TrajectoryEvent; timestamp: string }

interface Scorecard {
  totalEvents: number; toolCalls: number; toolErrors: number; errorRate: number
  iterations: number; delegations: number; hasAnswer: boolean; hasError: boolean
  toolsUsed: string[]; toolFrequency: Record<string, number>
  eventsPerIteration: number; thinkToActRatio: number; patterns: string[]
}

interface Violation { seq: number; from: string; to: string; message: string }

interface ReplayResponse {
  valid: boolean; violations: Violation[]; scorecard: Scorecard; eventCount: number
}

interface Mutation {
  type: "drop" | "replace" | "inject"
  seq: number
  event?: TrajectoryEvent
}

interface ComparisonResult {
  sameGoal: boolean; toolOverlap: number; toolCallDelta: number
  iterationDelta: number; errorRateDelta: number
  moreEfficient: "a" | "b" | "equal"; summary: string
}

type TabId = "replay" | "mutations" | "compare"

// ── Trace tree types + builders ──────────────────────────────────

interface TraceNode {
  entry: TrajectoryEntry
  flatIndex: number
  children?: TraceNode[]
  endEntry?: TrajectoryEntry
  endFlatIndex?: number
  subtreeCount?: number
}

const META_TREE_KINDS = new Set<string>(["usage", "delegation-iteration", "delegation-parallel-start", "delegation-parallel-end", "system-prompt", "tools-resolved", "llm-request", "llm-response"])

function buildTraceTree(trajectory: TrajectoryEntry[]): TraceNode[] {
  const roots: TraceNode[] = []
  const stack: { nodes: TraceNode[]; dlgt?: TraceNode }[] = [{ nodes: roots }]
  for (let i = 0; i < trajectory.length; i++) {
    const entry = trajectory[i]
    if (META_TREE_KINDS.has(entry.event.kind)) continue
    if (entry.event.kind === "delegation-start") {
      const node: TraceNode = { entry, flatIndex: i, children: [], subtreeCount: 0 }
      stack[stack.length - 1].nodes.push(node)
      stack.push({ nodes: node.children!, dlgt: node })
    } else if (entry.event.kind === "delegation-end") {
      const frame = stack.pop()
      if (frame?.dlgt) {
        frame.dlgt.endEntry = entry
        frame.dlgt.endFlatIndex = i
        frame.dlgt.subtreeCount = subtreeSize(frame.dlgt)
      }
    } else {
      stack[stack.length - 1].nodes.push({ entry, flatIndex: i })
    }
  }
  return roots
}

function subtreeSize(node: TraceNode): number {
  if (!node.children) return 0
  let c = 0
  for (const child of node.children) c += 1 + (child.subtreeCount ?? 0)
  return c
}

/** Returns the chain of delegation-start TraceNodes containing `flatIndex` */
function ancestorPath(tree: TraceNode[], flatIndex: number): TraceNode[] {
  const path: TraceNode[] = []
  function walk(nodes: TraceNode[]): boolean {
    for (const n of nodes) {
      if (n.flatIndex === flatIndex) return true
      if (n.children && n.endFlatIndex != null && flatIndex > n.flatIndex && flatIndex <= n.endFlatIndex) {
        path.push(n)
        walk(n.children) // try deeper match; even if none found, this delegation contains the cursor
        return true
      }
    }
    return false
  }
  walk(tree)
  return path
}

// ── Event color + label map ──────────────────────────────────────

const EVENT_META: Record<EventKind, { color: string; label: string; short: string }> = {
  "goal":              { color: "var(--color-accent)",     label: "Goal",           short: "GOAL" },
  "thinking":          { color: "var(--color-accent)",     label: "Thinking",       short: "THK" },
  "tool-call":         { color: "var(--color-warning)",    label: "Tool Call",      short: "CALL" },
  "tool-result":       { color: "var(--color-success)",    label: "Tool Result",    short: "RSLT" },
  "tool-error":        { color: "var(--color-error)",      label: "Tool Error",     short: "ERR" },
  "iteration":         { color: "var(--color-text-muted)", label: "Iteration",      short: "ITER" },
  "delegation-start":  { color: "var(--color-viz-plum)",   label: "Delegate Start", short: "DLGT" },
  "delegation-end":    { color: "var(--color-viz-plum)",   label: "Delegate End",   short: "DONE" },
  "delegation-iteration": { color: "var(--color-viz-plum)", label: "Child Iteration", short: "D·IT" },
  "usage":             { color: "var(--color-text-muted)", label: "Token Usage",    short: "USG" },
  "delegation-parallel-start": { color: "var(--color-viz-plum)", label: "Parallel Start", short: "P·GO" },
  "delegation-parallel-end":   { color: "var(--color-viz-plum)", label: "Parallel End",   short: "P·DN" },
  "answer":            { color: "var(--color-success)",    label: "Final Answer",   short: "ANS" },
  "error":             { color: "var(--color-error)",      label: "Fatal Error",    short: "FAIL" },
  "system-prompt":     { color: "var(--color-text-muted)", label: "System Prompt",  short: "SYS" },
  "tools-resolved":    { color: "var(--color-text-muted)", label: "Tools Resolved", short: "TOOL" },
  "llm-request":       { color: "var(--color-text-muted)", label: "LLM Request",    short: "LLM→" },
  "llm-response":      { color: "var(--color-text-muted)", label: "LLM Response",   short: "→LLM" },
  "user-input-request":  { color: "var(--color-accent)",  label: "User Prompt",    short: "ASK" },
  "user-input-response": { color: "var(--color-accent)",  label: "User Reply",     short: "RPL" },
}

const SPEEDS = [0.5, 1, 2, 4] as const

const TABS: Array<{ id: TabId; label: string; Icon: typeof Play }> = [
  { id: "replay",    label: "Replay",     Icon: Play },
  { id: "mutations", label: "Mutations",  Icon: FlaskConical },
  { id: "compare",   label: "Compare",    Icon: ArrowLeftRight },
]

// ══════════════════════════════════════════════════════════════════
// ██  Main component
// ══════════════════════════════════════════════════════════════════

export function TrajectoryReplay() {
  const activeRunId = useStore((s) => s.activeRunId)
  const runs = useStore((s) => s.runs) ?? []
  const [tab, setTab] = useState<TabId>("replay")

  // ── Run picker (shared across tabs) ──────────────────────────
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [showRunPicker, setShowRunPicker] = useState(false)
  const effectiveRunId = selectedRunId ?? activeRunId

  const completedRuns = useMemo(
    () => (runs).filter((r: Run) => r.status === "completed" || r.status === "failed"),
    [runs],
  )

  // Derive the effective run's status so we can reload when it changes
  const effectiveRunStatus = useMemo(
    () => runs.find((r: Run) => r.id === effectiveRunId)?.status ?? null,
    [runs, effectiveRunId],
  )

  // ── Shared trajectory data ───────────────────────────────────
  const [trajectory, setTrajectory] = useState<TrajectoryEntry[]>([])
  const [replayData, setReplayData] = useState<ReplayResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadTrajectory = useCallback(async (runId: string, mutations?: Mutation[]) => {
    setLoading(true)
    setError(null)
    try {
      const [trajRes, replayRes] = await Promise.all([
        api.getTrajectory(runId),
        api.replayTrajectory(runId, mutations as unknown as Array<Record<string, unknown>>),
      ])
      setTrajectory(trajRes.events as unknown as TrajectoryEntry[])
      setReplayData(replayRes as unknown as ReplayResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trajectory")
      setTrajectory([])
      setReplayData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load trajectory when run ID changes or when its status transitions to completed/failed.
  // Without the status dependency, trajectory loaded at run start (with just 1 "goal" event)
  // would never refresh when the run finishes.
  useEffect(() => {
    if (effectiveRunId && (effectiveRunStatus === "completed" || effectiveRunStatus === "failed")) {
      loadTrajectory(effectiveRunId)
    }
  }, [effectiveRunId, effectiveRunStatus, loadTrajectory])

  // ── Rollback state ──────────────────────────────────────────
  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreview | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<string | null>(null)
  const canRollback = effectiveRunStatus === "completed" || effectiveRunStatus === "failed"

  const handleRollbackPreview = useCallback(async () => {
    if (!effectiveRunId) return
    setRollbackLoading(true)
    setRollbackResult(null)
    try {
      const preview = await api.previewRollback(effectiveRunId)
      if (preview.wouldCompensate.length === 0 && preview.wouldFail.length === 0) {
        setRollbackResult("No file effects to rollback")
      } else {
        setRollbackPreview(preview)
      }
    } catch {
      setRollbackResult("Failed to load preview")
    }
    setRollbackLoading(false)
  }, [effectiveRunId])

  const handleRollbackConfirm = useCallback(async () => {
    if (!effectiveRunId) return
    setRollbackLoading(true)
    try {
      const result = await api.rollbackRun(effectiveRunId)
      if (result.failed.length > 0) {
        setRollbackResult(`Rolled back ${result.compensated}, ${result.failed.length} failed`)
      } else {
        setRollbackResult(`Rolled back ${result.compensated} effects, ${result.skipped} skipped`)
      }
    } catch {
      setRollbackResult("Rollback failed")
    }
    setRollbackPreview(null)
    setRollbackLoading(false)
  }, [effectiveRunId])

  // ── Empty / error states ─────────────────────────────────────

  if (!effectiveRunId) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Select a run to replay its trajectory
      </div>
    )
  }

  if (loading && trajectory.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading trajectory…
      </div>
    )
  }

  if (error && trajectory.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm">
        <span className="text-error">{error}</span>
        <button className="text-accent text-[13px] hover:underline" onClick={() => loadTrajectory(effectiveRunId)}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-0 select-none">
      {/* ── Top bar: run picker + tabs ──────────────────────── */}
      <div className="flex items-center gap-1.5 px-2 pb-2 shrink-0 border-b border-elevated/50">
        {/* Run picker */}
        <div className="relative">
          <button
            className="text-sm text-text-muted hover:text-text px-2 py-1 rounded-md hover:bg-elevated/60 transition-colors"
            onClick={() => setShowRunPicker(!showRunPicker)}
          >
            {effectiveRunId}
          </button>
          {showRunPicker && (
            <RunPicker
              runs={completedRuns}
              selectedId={effectiveRunId}
              onSelect={(id) => { setSelectedRunId(id); setShowRunPicker(false) }}
              onClose={() => setShowRunPicker(false)}
            />
          )}
        </div>

        {/* Validation badge */}
        {replayData && (
          <div className={`flex items-center gap-1.5 text-[13px] font-medium px-2 py-0.5 rounded-full ${
            replayData.valid ? "bg-success/10 text-success" : "bg-error/10 text-error"
          }`}>
            {replayData.valid ? <Circle size={9} fill="currentColor" /> : <AlertTriangle size={14} />}
            {replayData.valid ? "Valid" : `${replayData.violations?.length ?? 0} violation${(replayData.violations?.length ?? 0) === 1 ? "" : "s"}`}
          </div>
        )}

        {/* Rollback button */}
        {canRollback && !rollbackPreview && (
          <button
            className="flex items-center gap-1 text-[13px] text-warning/80 hover:text-warning px-2 py-1 rounded-md hover:bg-warning/10 transition-colors"
            onClick={handleRollbackPreview}
            disabled={rollbackLoading}
            title="Rollback all file changes from this run"
          >
            <Undo2 size={13} />
            {rollbackLoading ? "..." : "Rollback"}
          </button>
        )}
        {rollbackResult && (
          <span className="text-[11px] text-text-muted px-1">{rollbackResult}</span>
        )}

        <div className="flex-1" />

        {/* Tabs */}
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`flex items-center gap-1.5 text-[13px] px-2.5 py-1 rounded-md transition-colors ${
              tab === t.id
                ? "bg-accent/15 text-accent font-medium"
                : "text-text-muted hover:text-text hover:bg-elevated/60"
            }`}
            onClick={() => setTab(t.id)}
          >
            <t.Icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Rollback preview panel ─────────────────────────────── */}
      {rollbackPreview && (
        <div className="px-3 py-2 border-b border-elevated/50 bg-elevated/30 space-y-1.5">
          <div className="text-[13px] font-semibold text-warning">Rollback Preview</div>
          {rollbackPreview.wouldCompensate.length > 0 && (
            <div className="text-[12px]">
              <span className="text-success">Restore ({rollbackPreview.wouldCompensate.length}): </span>
              <span className="text-text-muted font-mono">
                {rollbackPreview.wouldCompensate.slice(0, 5).map(e => e.target.split("/").pop()).join(", ")}
                {rollbackPreview.wouldCompensate.length > 5 && ` +${rollbackPreview.wouldCompensate.length - 5} more`}
              </span>
            </div>
          )}
          {rollbackPreview.wouldSkip.length > 0 && (
            <div className="text-[12px] text-text-muted">
              Skip: {rollbackPreview.wouldSkip.length} (commands/already done)
            </div>
          )}
          {rollbackPreview.wouldFail.length > 0 && (
            <div className="text-[12px] text-error">
              Blocked: {rollbackPreview.wouldFail.map(e => `${e.target.split("/").pop()} — ${e.reason}`).join("; ")}
            </div>
          )}
          <div className="flex gap-2 pt-0.5">
            {rollbackPreview.wouldFail.length === 0 && rollbackPreview.wouldCompensate.length > 0 && (
              <button
                className="flex items-center gap-1 text-[12px] text-warning bg-warning/10 hover:bg-warning/20 px-2.5 py-1 rounded-md transition-colors"
                onClick={handleRollbackConfirm}
                disabled={rollbackLoading}
              >
                <Undo2 size={11} />
                Confirm
              </button>
            )}
            <button
              className="text-[12px] text-text-muted hover:text-text px-2.5 py-1 rounded-md transition-colors"
              onClick={() => setRollbackPreview(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Tab content ─────────────────────────────────────── */}
      {tab === "replay" && (
        <ReplayTab
          trajectory={trajectory}
          replayData={replayData}
        />
      )}
      {tab === "mutations" && (
        <MutationTab
          trajectory={trajectory}
          effectiveRunId={effectiveRunId}
          replayData={replayData}
        />
      )}
      {tab === "compare" && (
        <CompareTab
          currentRunId={effectiveRunId}
          runs={completedRuns}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// ██  Tab 1: Replay
// ══════════════════════════════════════════════════════════════════

function ReplayTab({
  trajectory,
  replayData,
}: {
  trajectory: TrajectoryEntry[]
  replayData: ReplayResponse | null
}) {
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const eventListRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const [panelWidth, setPanelWidth] = useState(320)
  const draggingRef = useRef(false)

  // Build delegation tree from flat trajectory
  const tree = useMemo(() => buildTraceTree(trajectory), [trajectory])

  // Track which delegation groups are expanded (by flatIndex)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  // Flag: cursor was moved by timeline/VCR/keyboard (not tree click)
  const seekRef = useRef(false)

  const seekTo = useCallback((idx: number) => {
    seekRef.current = true
    setCursor(idx)
  }, [])

  const toggleExpanded = useCallback((flatIndex: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(flatIndex)) next.delete(flatIndex)
      else next.add(flatIndex)
      return next
    })
  }, [])

  // Reset cursor when trajectory changes
  useEffect(() => { setCursor(0); setPlaying(false); setExpanded(new Set()) }, [trajectory])

  // Drag-to-resize left panel
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startX = e.clientX
    const startW = panelWidth
    function onMove(ev: MouseEvent) {
      if (!draggingRef.current) return
      const container = splitRef.current
      const maxW = container ? container.clientWidth * 0.6 : 600
      const newW = Math.max(200, Math.min(maxW, startW + ev.clientX - startX))
      setPanelWidth(newW)
    }
    function onUp() {
      draggingRef.current = false
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
  }, [panelWidth])

  // Playback timer
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (playing && trajectory.length > 0) {
      timerRef.current = setInterval(() => {
        setCursor((prev) => {
          if (prev >= trajectory.length - 1) { setPlaying(false); return prev }
          seekRef.current = true
          return prev + 1
        })
      }, 800 / speed)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [playing, speed, trajectory.length])

  // Auto-scroll
  useEffect(() => {
    const el = eventListRef.current
    if (!el) return
    const active = el.querySelector(`[data-seq="${cursor}"]`) as HTMLElement | null
    active?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [cursor])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      switch (e.key) {
        case " ": e.preventDefault(); setPlaying((p) => !p); break
        case "ArrowRight": e.preventDefault(); seekTo(Math.min(cursor + 1, trajectory.length - 1)); break
        case "ArrowLeft": e.preventDefault(); seekTo(Math.max(cursor - 1, 0)); break
        case "Home": e.preventDefault(); seekTo(0); break
        case "End": e.preventDefault(); seekTo(trajectory.length - 1); break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cursor, trajectory.length, seekTo])

  const violationSeqs = useMemo(() => {
    if (!replayData?.violations) return new Set<number>()
    return new Set(replayData.violations.map((v) => v.seq))
  }, [replayData])

  const violationAt = useCallback(
    (seq: number) => replayData?.violations?.find((v) => v.seq === seq),
    [replayData],
  )

  // Auto-expand delegations containing the cursor
  useEffect(() => {
    const ancestors = ancestorPath(tree, cursor)
    // If cursor is on a delegation-start, also expand it so children are visible
    const cursorKind = trajectory[cursor]?.event?.kind
    if (seekRef.current) {
      // Timeline / VCR / keyboard seek — show exactly the path to cursor
      seekRef.current = false
      const needed = new Set(ancestors.map(a => a.flatIndex))
      if (cursorKind === "delegation-start") needed.add(cursor)
      setExpanded(needed)
    } else {
      // Tree click — just ensure ancestors are expanded, don't collapse others
      const ids = ancestors.map(a => a.flatIndex)
      if (cursorKind === "delegation-start") ids.push(cursor)
      if (ids.length === 0) return
      setExpanded(prev => {
        if (ids.every(id => prev.has(id))) return prev
        const next = new Set(prev)
        for (const id of ids) next.add(id)
        return next
      })
    }
  }, [cursor, tree, trajectory])

  // Breadcrumb path for current cursor position
  const breadcrumbs = useMemo(() => ancestorPath(tree, cursor), [tree, cursor])

  const currentEntry = trajectory[cursor] ?? null

  if (trajectory.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No trajectory data</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Scorecard + counter */}
      {replayData?.scorecard && <ScorecardPanel scorecard={replayData.scorecard} />}
      <div className="flex items-center px-3 py-1 shrink-0">
        <div className="flex-1" />
        <span className="text-[13px] text-text-muted font-mono tabular-nums">{cursor + 1}/{trajectory.length}</span>
      </div>

      {/* Timeline */}
      <div className="px-2 py-1 shrink-0">
        <TimelineScrubber events={trajectory} cursor={cursor} violationSeqs={violationSeqs} onSeek={seekTo} />
      </div>

      {/* Event list + detail */}
      <div ref={splitRef} className="flex flex-1 min-h-0">
        <div ref={eventListRef} className="shrink-0 overflow-y-auto" style={{ width: panelWidth }}>
          {breadcrumbs.length > 0 && (
            <div className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-text-muted border-b border-elevated/30 bg-elevated/20 sticky top-0 z-10 flex-wrap">
              <button className="hover:text-text transition-colors shrink-0" onClick={() => { seekTo(0); setPlaying(false) }}>Root</button>
              {breadcrumbs.map((node) => (
                <Fragment key={node.flatIndex}>
                  <span className="text-text-muted/40 shrink-0">/</span>
                  <button
                    className="hover:text-accent transition-colors truncate max-w-[100px]"
                    onClick={() => { seekTo(node.flatIndex); setPlaying(false) }}
                    title={String(node.entry.event.childGoal ?? node.entry.event.goal ?? "")}
                  >
                    {trnc(node.entry.event.childGoal ?? node.entry.event.goal, 18)}
                  </button>
                </Fragment>
              ))}
            </div>
          )}
          <TraceTreeView
            nodes={tree}
            cursor={cursor}
            violationSeqs={violationSeqs}
            expanded={expanded}
            onToggle={toggleExpanded}
            onSelect={(fi) => { setCursor(fi); setPlaying(false) }}
          />
        </div>
        {/* Drag handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize bg-elevated/50 hover:bg-accent/40 active:bg-accent/60 transition-colors"
          onMouseDown={onDragStart}
        />
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {currentEntry && (
            <EventDetail entry={currentEntry} violation={violationAt(currentEntry.seq) ?? null} />
          )}
        </div>
      </div>

      {/* Playback controls */}
      <PlaybackControls
        cursor={cursor}
        total={trajectory.length}
        playing={playing}
        speed={speed}
        onCursor={seekTo}
        onPlay={() => { if (cursor >= trajectory.length - 1) seekTo(0); setPlaying(!playing) }}
        onSpeed={() => { const idx = SPEEDS.indexOf(speed as typeof SPEEDS[number]); setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]) }}
        onReset={() => { seekTo(0); setPlaying(false) }}
      />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// ██  Tab 2: Mutations
// ══════════════════════════════════════════════════════════════════

function MutationTab({
  trajectory,
  effectiveRunId,
  replayData,
}: {
  trajectory: TrajectoryEntry[]
  effectiveRunId: string
  replayData: ReplayResponse | null
}) {
  const [mutations, setMutations] = useState<Mutation[]>([])
  const [mutatedReplay, setMutatedReplay] = useState<ReplayResponse | null>(null)
  const [mutLoading, setMutLoading] = useState(false)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const tree = useMemo(() => buildTraceTree(trajectory), [trajectory])
  const mutatedSeqs = useMemo(() => new Set(mutations.map(m => m.seq)), [mutations])

  function addMutation(type: Mutation["type"], seq: number) {
    const event: TrajectoryEvent = type === "inject"
      ? { kind: "tool-error", text: "Injected error for testing" }
      : type === "replace"
        ? { kind: "tool-error", text: "Replaced event for testing" }
        : undefined as unknown as TrajectoryEvent
    const mut: Mutation = type === "drop"
      ? { type: "drop", seq }
      : { type, seq, event }
    setMutations((prev) => [...prev, mut])
  }

  function removeMutation(index: number) {
    setMutations((prev) => prev.filter((_, i) => i !== index))
  }

  const toggleExpanded = useCallback((flatIndex: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(flatIndex)) next.delete(flatIndex)
      else next.add(flatIndex)
      return next
    })
  }, [])

  async function runMutatedReplay() {
    if (mutations.length === 0) return
    setMutLoading(true)
    try {
      const res = await api.replayTrajectory(effectiveRunId, mutations as unknown as Array<Record<string, unknown>>)
      setMutatedReplay(res as unknown as ReplayResponse)
    } catch {
      setMutatedReplay(null)
    } finally {
      setMutLoading(false)
    }
  }

  const selectedEntry = selectedSeq != null
    ? trajectory.find(e => e.seq === selectedSeq) ?? null
    : null

  if (trajectory.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No trajectory to mutate</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* ── Mutation bar ─────────────────────────────────────── */}
      <div className="shrink-0 border-b border-elevated/40">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <FlaskConical size={14} className="text-accent" />
            <span className="text-sm font-semibold text-text">Mutations</span>
            <span className="text-[12px] font-mono text-text-muted bg-elevated/60 px-1.5 py-0.5 rounded">
              {mutations.length}
            </span>
          </div>
          <div className="flex-1" />
          {mutations.length > 0 && (
            <button
              className="text-[12px] text-text-muted hover:text-error transition-colors"
              onClick={() => { setMutations([]); setMutatedReplay(null) }}
            >
              Clear all
            </button>
          )}
          <button
            className={`flex items-center gap-1.5 text-[13px] px-3.5 py-1.5 rounded-lg font-medium transition-all ${
              mutations.length > 0
                ? "bg-accent/15 text-accent hover:bg-accent/25 shadow-sm shadow-accent/10"
                : "bg-elevated/30 text-text-muted cursor-not-allowed"
            }`}
            onClick={runMutatedReplay}
            disabled={mutations.length === 0 || mutLoading}
          >
            <RefreshCw size={13} className={mutLoading ? "animate-spin" : ""} />
            Replay
          </button>
        </div>

        {/* Applied mutations as chips */}
        {mutations.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-2.5">
            {mutations.map((mut, i) => (
              <div key={i} className={`inline-flex items-center gap-1.5 text-[12px] font-mono rounded-md px-2 py-1 border ${
                mut.type === "drop" ? "bg-error/8 text-error/80 border-error/15"
                  : mut.type === "replace" ? "bg-warning/8 text-warning/80 border-warning/15"
                    : "bg-accent/8 text-accent/80 border-accent/15"
              }`}>
                <span className="font-semibold">{mut.type.toUpperCase()}</span>
                <span className="text-text-muted">#{mut.seq}</span>
                {mut.event && <span className="opacity-60">→ {mut.event.kind}</span>}
                <button
                  className="ml-0.5 hover:text-error transition-colors"
                  onClick={() => removeMutation(i)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Main body: tree (left) + detail/results (right) ─── */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Nested event tree */}
        <div className="flex-1 min-w-0 overflow-y-auto border-r border-elevated/30">
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted/60 border-b border-elevated/20 sticky top-0 bg-base z-10">
            Event Tree — hover to mutate
          </div>
          <MutationTreeView
            nodes={tree}
            expanded={expanded}
            onToggle={toggleExpanded}
            selectedSeq={selectedSeq}
            onSelect={setSelectedSeq}
            mutatedSeqs={mutatedSeqs}
          />
        </div>

        {/* Right: Detail + Results */}
        <div className="w-[45%] shrink-0 overflow-y-auto flex flex-col">
          {/* Selected event detail */}
          {selectedEntry ? (
            <div className="p-4 border-b border-elevated/30">
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="text-[12px] font-bold font-mono px-2 py-0.5 rounded"
                  style={{ color: (EVENT_META[selectedEntry.event.kind] ?? EVENT_META["error"]).color }}
                >
                  {(EVENT_META[selectedEntry.event.kind] ?? EVENT_META["error"]).short}
                </span>
                <span className="text-[12px] text-text-muted font-mono">seq #{selectedEntry.seq}</span>
                <span className="text-[12px] text-text-muted/60 ml-auto">{new Date(selectedEntry.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="text-sm text-text leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto bg-elevated/20 rounded-lg p-3 font-mono text-[13px]">
                {mutEventFullText(selectedEntry.event)}
              </div>
              {/* Mutation actions for selected */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-elevated/20">
                <MutActionBtn label="Drop" icon={<Trash2 size={13} />} color="error" onClick={() => addMutation("drop", selectedEntry.seq)} />
                <MutActionBtn label="Replace" icon={<RefreshCw size={13} />} color="warning" onClick={() => addMutation("replace", selectedEntry.seq)} />
                <MutActionBtn label="Inject before" icon={<Plus size={13} />} color="accent" onClick={() => addMutation("inject", selectedEntry.seq)} />
              </div>
            </div>
          ) : (
            <div className="p-6 flex flex-col items-center justify-center text-center border-b border-elevated/30 min-h-[120px]">
              <div className="text-text-muted/40 mb-1"><FlaskConical size={24} /></div>
              <div className="text-[13px] text-text-muted">Select an event to see full details and mutation options</div>
            </div>
          )}

          {/* Replay results */}
          {mutatedReplay && (
            <div className="p-4 space-y-4 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text">Replay Result</span>
                <div className={`flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full ${
                  mutatedReplay.valid ? "bg-success/10 text-success" : "bg-error/10 text-error"
                }`}>
                  {mutatedReplay.valid ? <Circle size={8} fill="currentColor" /> : <AlertTriangle size={13} />}
                  {mutatedReplay.valid ? "Valid" : `${mutatedReplay.violations?.length ?? 0} violations`}
                </div>
              </div>

              {/* Scorecard comparison */}
              {replayData?.scorecard && mutatedReplay.scorecard && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted/60">Original</div>
                    <MiniScorecard sc={replayData.scorecard} />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted/60">Mutated</div>
                    <MiniScorecard sc={mutatedReplay.scorecard} />
                  </div>
                </div>
              )}

              {/* Violations */}
              {(mutatedReplay.violations?.length ?? 0) > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-error/70">Violations</div>
                  {mutatedReplay.violations!.map((v, i) => (
                    <div key={i} className="flex items-start gap-2.5 text-[13px] bg-error/5 border border-error/10 rounded-lg px-3 py-2">
                      <AlertTriangle size={14} className="text-error shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="font-mono text-error font-medium">#{v.seq}</span>
                        <span className="text-text-muted mx-1.5">·</span>
                        <span className="text-text-secondary">{v.from} → {v.to}</span>
                        <div className="text-error/70 mt-0.5 break-words">{v.message}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state for results */}
          {!mutatedReplay && mutations.length > 0 && (
            <div className="flex-1 flex items-center justify-center text-text-muted text-[13px] p-4">
              Click <span className="font-medium text-accent mx-1">Replay</span> to test with mutations applied
            </div>
          )}

          {/* Hint when no mutations and no selection */}
          {!mutatedReplay && mutations.length === 0 && !selectedEntry && (
            <div className="flex-1 flex flex-col items-center justify-center text-text-muted/50 p-6 text-center">
              <div className="text-[13px] leading-relaxed max-w-[240px]">
                Hover events in the tree and click mutation icons to drop, replace, or inject errors.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Mutation tree components ─────────────────────────────────────

function MutationTreeView({ nodes, expanded, onToggle, selectedSeq, onSelect, mutatedSeqs }: {
  nodes: TraceNode[]; expanded: Set<number>; onToggle: (fi: number) => void
  selectedSeq: number | null; onSelect: (seq: number) => void
  mutatedSeqs: Set<number>
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.children) {
          return (
            <MutDelegationGroup
              key={node.entry.seq}
              node={node}
              expanded={expanded}
              onToggle={onToggle}
              selectedSeq={selectedSeq}
              onSelect={onSelect}
              mutatedSeqs={mutatedSeqs}
            />
          )
        }
        return (
          <MutLeafNode
            key={node.entry.seq}
            entry={node.entry}
            isSelected={node.entry.seq === selectedSeq}
            isMutated={mutatedSeqs.has(node.entry.seq)}
            onSelect={() => onSelect(node.entry.seq)}
          />
        )
      })}
    </>
  )
}

function MutDelegationGroup({ node, expanded, onToggle, selectedSeq, onSelect, mutatedSeqs }: {
  node: TraceNode; expanded: Set<number>; onToggle: (fi: number) => void
  selectedSeq: number | null; onSelect: (seq: number) => void
  mutatedSeqs: Set<number>
}) {
  const isExpanded = expanded.has(node.flatIndex)
  const isSelected = node.entry.seq === selectedSeq
  const isMutated = mutatedSeqs.has(node.entry.seq)
  const hasError = !!node.endEntry?.event?.error
  const goal = String(node.entry.event.childGoal ?? node.entry.event.goal ?? "")

  return (
    <div>
      <div
        className={[
          "flex items-center gap-1.5 cursor-pointer transition-colors pl-1.5 pr-3 py-1.5",
          isSelected ? "bg-elevated/70" : "hover:bg-elevated/20",
          isMutated ? "ring-1 ring-inset ring-warning/30 bg-warning/5" : "",
        ].join(" ")}
        onClick={() => onSelect(node.entry.seq)}
      >
        <button
          className="flex items-center justify-center w-5 h-5 shrink-0 text-text-muted hover:text-text rounded transition-colors"
          onClick={(e) => { e.stopPropagation(); onToggle(node.flatIndex) }}
        >
          <ChevronRight size={14} className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} />
        </button>
        <span className="text-[12px] font-bold font-mono shrink-0" style={{ color: "var(--color-viz-plum)" }}>DLGT</span>
        <span className="text-sm text-text-secondary flex-1 min-w-0 line-clamp-2">{trnc(goal, 200)}</span>
        {!isExpanded && (
          <span className={`text-[11px] font-mono shrink-0 ml-2 ${hasError ? "text-error/60" : "text-success/60"}`}>
            {node.subtreeCount} {hasError ? "✗" : "✓"}
          </span>
        )}
      </div>

      {isExpanded && (
        <div className="ml-3 border-l-2 border-viz-plum/15 pl-0.5">
          <MutationTreeView
            nodes={node.children!}
            expanded={expanded}
            onToggle={onToggle}
            selectedSeq={selectedSeq}
            onSelect={onSelect}
            mutatedSeqs={mutatedSeqs}
          />
          {node.endEntry && (
            <div
              className={[
                "flex items-center gap-1.5 cursor-pointer transition-colors px-2.5 py-1 text-[12px] font-mono",
                node.endEntry.seq === selectedSeq ? "bg-elevated/70" : "hover:bg-elevated/20",
                hasError ? "text-error/60" : "text-success/60",
              ].join(" ")}
              onClick={() => onSelect(node.endEntry!.seq)}
            >
              <span>{hasError ? "✗ delegation failed" : "✓ delegation done"}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MutLeafNode({ entry, isSelected, isMutated, onSelect }: {
  entry: TrajectoryEntry; isSelected: boolean; isMutated: boolean
  onSelect: () => void
}) {
  const meta = EVENT_META[entry.event.kind] ?? EVENT_META["error"]
  const kind = entry.event.kind

  const baseCls = [
    "flex items-start gap-2 cursor-pointer transition-colors px-3 py-1.5",
    isSelected ? "bg-elevated/70" : "hover:bg-elevated/20",
    isMutated ? "ring-1 ring-inset ring-warning/30 bg-warning/5" : "",
  ].join(" ")

  // Iteration separator
  if (kind === "iteration") {
    return (
      <div className={`${baseCls} items-center text-text-muted text-[13px] font-mono pt-3 pb-1 border-t border-elevated/40 mt-1`} onClick={onSelect}>
        <span>iteration {String(entry.event.current)}/{String(entry.event.max)}</span>
      </div>
    )
  }

  const preview = (() => {
    switch (kind) {
      case "goal": return trnc(entry.event.text, 200)
      case "thinking": return trnc(entry.event.text, 200)
      case "tool-call": {
        const tool = String(entry.event.tool ?? "")
        const args = entry.event.argsSummary ? ` ${trnc(entry.event.argsSummary, 160)}` : ""
        return tool + args
      }
      case "tool-result": return trnc(entry.event.text, 200)
      case "tool-error": return trnc(entry.event.text, 200)
      case "delegation-start": return trnc(entry.event.childGoal ?? entry.event.goal, 200)
      case "delegation-end": return trnc(entry.event.result, 200)
      case "answer": return trnc(entry.event.text, 200)
      case "error": return trnc(entry.event.text, 200)
      default: return trnc(eventPreview(entry.event), 200)
    }
  })()

  return (
    <div className={baseCls} onClick={onSelect}>
      <span
        className="text-[11px] font-bold font-mono shrink-0 px-1.5 py-0.5 rounded mt-0.5"
        style={{ color: meta.color }}
      >
        {meta.short}
      </span>
      <span className={`text-[13px] min-w-0 flex-1 break-words line-clamp-3 leading-relaxed ${
        kind === "error" || kind === "tool-error" ? "text-error/80" : "text-text-secondary"
      }`}>
        {preview}
      </span>
    </div>
  )
}

function MutActionBtn({ label, icon, color, onClick }: {
  label: string; icon: React.ReactNode; color: string; onClick: () => void
}) {
  return (
    <button
      className={`flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-md transition-colors text-${color}/70 hover:text-${color} hover:bg-${color}/10`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function mutEventFullText(event: TrajectoryEvent): string {
  switch (event.kind) {
    case "goal": return String(event.text ?? "")
    case "thinking": return String(event.text ?? "")
    case "tool-call": {
      const tool = String(event.tool ?? "")
      const args = event.args ?? event.argsSummary
      return args ? `${tool}\n\n${typeof args === "string" ? args : JSON.stringify(args, null, 2)}` : tool
    }
    case "tool-result": return String(event.text ?? "")
    case "tool-error": return String(event.text ?? "")
    case "iteration": return `Iteration ${String(event.current)}/${String(event.max)}`
    case "delegation-start": {
      const goal = String(event.childGoal ?? event.goal ?? "")
      const delegate = event.delegate ? `\nDelegate: ${String(event.delegate)}` : ""
      return `Goal: ${goal}${delegate}`
    }
    case "delegation-end": {
      const result = String(event.result ?? "")
      const error = event.error ? `\nError: ${String(event.error)}` : ""
      return `Result: ${result}${error}`
    }
    case "answer": return String(event.text ?? "")
    case "error": return String(event.text ?? "")
    case "system-prompt": return String(event.text ?? "")
    case "tools-resolved": {
      const tools = (event as unknown as { tools: Array<{ name: string }> }).tools ?? []
      return tools.map((t: { name: string }) => t.name).join("\n")
    }
    case "llm-request": return JSON.stringify(event, null, 2)
    case "llm-response": return JSON.stringify(event, null, 2)
    case "user-input-request": return String((event as unknown as { question: string }).question ?? event.text ?? "")
    case "user-input-response": return String(event.text ?? "")
    default: return JSON.stringify(event, null, 2)
  }
}

function MiniScorecard({ sc }: { sc: Scorecard }) {
  return (
    <div className="bg-base rounded-lg px-3 py-2 space-y-1 font-mono text-[13px]">
      <Row label="Events" value={sc.totalEvents} />
      <Row label="Tool calls" value={sc.toolCalls} />
      <Row label="Errors" value={sc.toolErrors} accent={sc.toolErrors > 0} />
      <Row label="Err rate" value={`${Math.round(sc.errorRate * 100)}%`} accent={sc.errorRate > 0.2} />
      <Row label="Iterations" value={sc.iterations} />
      <Row label="Evt/iter" value={sc.eventsPerIteration?.toFixed?.(1) ?? "—"} />
      <Row label="Patterns" value={sc.patterns?.length > 0 ? sc.patterns.join(", ") : "—"} />
    </div>
  )
}

function Row({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted">{label}</span>
      <span className={accent ? "text-error" : "text-text-secondary"}>{value}</span>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// ██  Tab 3: Compare
// ══════════════════════════════════════════════════════════════════

function CompareTab({
  currentRunId,
  runs,
}: {
  currentRunId: string
  runs: Run[]
}) {
  const [compareRunId, setCompareRunId] = useState<string | null>(null)
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [compLoading, setCompLoading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [compError, setCompError] = useState<string | null>(null)

  // Scorecards for A and B
  const [scoreA, setScoreA] = useState<Scorecard | null>(null)
  const [scoreB, setScoreB] = useState<Scorecard | null>(null)

  async function runComparison(runIdB: string) {
    setCompLoading(true)
    setCompError(null)
    try {
      const [comp, replayA, replayB] = await Promise.all([
        api.compareTrajectories(currentRunId, runIdB),
        api.replayTrajectory(currentRunId),
        api.replayTrajectory(runIdB),
      ])
      setComparison(comp as unknown as ComparisonResult)
      setScoreA((replayA as unknown as ReplayResponse).scorecard ?? null)
      setScoreB((replayB as unknown as ReplayResponse).scorecard ?? null)
    } catch (err) {
      setCompError(err instanceof Error ? err.message : "Comparison failed")
      setComparison(null)
    } finally {
      setCompLoading(false)
    }
  }

  const otherRuns = useMemo(() => runs.filter((r) => r.id !== currentRunId), [runs, currentRunId])

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-2.5 text-[13px] text-text-muted border-b border-elevated/50">
        Compare the current run against another to see how they differ in efficiency, tools, and outcomes.
      </div>

      {/* Run selection */}
      <div className="px-4 py-2.5 flex items-center gap-2.5 border-b border-elevated/50">
        <div className="flex items-center gap-1.5 text-[13px]">
          <span className="text-text-muted">A:</span>
          <span className="font-mono text-text-secondary">{truncate(currentRunId, 16)}</span>
        </div>

        <ArrowLeftRight size={14} className="text-text-muted" />

        <div className="relative">
          <button
            className="text-[13px] text-accent hover:text-accent/80 px-2.5 py-1 rounded-md bg-accent/10 hover:bg-accent/15 transition-colors"
            onClick={() => setShowPicker(!showPicker)}
          >
            {compareRunId ? truncate(compareRunId, 16) : "Select run B…"}
          </button>
          {showPicker && (
            <RunPicker
              runs={otherRuns}
              selectedId={compareRunId}
              onSelect={(id) => {
                setCompareRunId(id)
                setShowPicker(false)
                runComparison(id)
              }}
              onClose={() => setShowPicker(false)}
            />
          )}
        </div>

        {compareRunId && (
          <button
            className="text-[13px] text-text-muted hover:text-text px-2 py-1 rounded-md hover:bg-elevated/60 transition-colors"
            onClick={() => runComparison(compareRunId)}
            disabled={compLoading}
          >
            <RefreshCw size={14} className={compLoading ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      {compLoading && (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">Comparing…</div>
      )}

      {compError && (
        <div className="px-3 py-4 text-sm text-error text-center">{compError}</div>
      )}

      {/* Comparison results */}
      {comparison && !compLoading && (
        <div className="px-4 py-3 space-y-3">
          {/* Summary banner */}
          <div className="text-sm text-text-secondary leading-relaxed bg-base rounded-lg px-3 py-2.5">
            {comparison.summary}
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-3 gap-2">
            <CompareMetric
              label="Tool overlap"
              value={`${Math.round(comparison.toolOverlap * 100)}%`}
              good={comparison.toolOverlap > 0.5}
            />
            <CompareMetric
              label="Efficiency"
              value={comparison.moreEfficient === "equal" ? "Equal" : comparison.moreEfficient === "a" ? "A wins" : "B wins"}
              good={comparison.moreEfficient === "a"}
            />
            <CompareMetric
              label="Same goal"
              value={comparison.sameGoal ? "Yes" : "No"}
              good={comparison.sameGoal}
            />
          </div>

          {/* Delta bars */}
          <div className="space-y-1.5">
            <DeltaBar label="Tool calls" delta={comparison.toolCallDelta} />
            <DeltaBar label="Iterations" delta={comparison.iterationDelta} />
            <DeltaBar label="Error rate" delta={comparison.errorRateDelta} percent />
          </div>

          {/* Side-by-side scorecards */}
          {scoreA && scoreB && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-[13px] text-text-muted font-medium">Run A</div>
                <MiniScorecard sc={scoreA} />
              </div>
              <div className="space-y-1">
                <div className="text-[13px] text-text-muted font-medium">Run B</div>
                <MiniScorecard sc={scoreB} />
              </div>
            </div>
          )}
        </div>
      )}

      {!comparison && !compLoading && !compError && (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Select a second run to compare
        </div>
      )}
    </div>
  )
}

function CompareMetric({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="bg-base rounded-lg px-3 py-2.5 text-center">
      <div className={`text-base font-semibold font-mono ${good ? "text-success" : "text-text-secondary"}`}>{value}</div>
      <div className="text-[13px] text-text-muted">{label}</div>
    </div>
  )
}

function DeltaBar({ label, delta, percent }: { label: string; delta: number; percent?: boolean }) {
  const display = percent ? `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}pp` : `${delta > 0 ? "+" : ""}${delta}`
  const isGood = delta < 0 // fewer = better for tool calls, iterations, error rate
  const absDelta = Math.abs(delta)
  const barWidth = Math.min(absDelta * (percent ? 200 : 20), 100) // scale

  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="w-24 text-text-muted shrink-0">{label}</span>
      <div className="flex-1 h-4 bg-base rounded relative overflow-hidden">
        <div className="absolute top-0 left-1/2 w-px h-full bg-elevated" />
        {delta !== 0 && (
          <div
            className={`absolute top-0 h-full rounded ${isGood ? "bg-success/30" : "bg-error/30"}`}
            style={{
              width: `${barWidth / 2}%`,
              ...(delta > 0 ? { left: "50%" } : { right: "50%" }),
            }}
          />
        )}
      </div>
      <span className={`w-14 text-right font-mono tabular-nums ${
        delta === 0 ? "text-text-muted" : isGood ? "text-success" : "text-error"
      }`}>
        {delta === 0 ? "—" : display}
      </span>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// ██  Shared sub-components
// ══════════════════════════════════════════════════════════════════

function PlaybackControls({
  cursor, total, playing, speed,
  onCursor, onPlay, onSpeed, onReset,
}: {
  cursor: number; total: number; playing: boolean; speed: number
  onCursor: (c: number) => void; onPlay: () => void; onSpeed: () => void; onReset: () => void
}) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-3 py-2 shrink-0 border-t border-elevated/50">
      <CtrlBtn onClick={() => { onCursor(0); }} title="Start (Home)"><SkipBack size={15} /></CtrlBtn>
      <CtrlBtn onClick={() => onCursor(Math.max(0, cursor - 1))} title="Back (←)"><ChevronLeft size={18} /></CtrlBtn>
      <button
        className="flex items-center justify-center w-10 h-10 rounded-full bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
        onClick={onPlay}
        title="Play/Pause (Space)"
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <CtrlBtn onClick={() => onCursor(Math.min(total - 1, cursor + 1))} title="Forward (→)"><ChevronRight size={18} /></CtrlBtn>
      <CtrlBtn onClick={() => onCursor(total - 1)} title="End"><SkipForward size={15} /></CtrlBtn>
      <div className="w-px h-5 bg-elevated mx-1.5" />
      <button className="text-[13px] font-mono text-text-muted hover:text-text px-2 py-1 rounded hover:bg-elevated/60 tabular-nums transition-colors" onClick={onSpeed} title="Speed">{speed}×</button>
      <CtrlBtn onClick={onReset} title="Reset"><RotateCcw size={14} /></CtrlBtn>
    </div>
  )
}

function CtrlBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded hover:bg-elevated/60 transition-colors" onClick={onClick} title={title}>
      {children}
    </button>
  )
}

// ── Collapsible trace tree ───────────────────────────────────────

function TraceTreeView({ nodes, cursor, violationSeqs, expanded, onToggle, onSelect }: {
  nodes: TraceNode[]; cursor: number; violationSeqs: Set<number>
  expanded: Set<number>; onToggle: (fi: number) => void; onSelect: (fi: number) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.children) {
          return (
            <DelegationGroup
              key={node.entry.seq}
              node={node}
              cursor={cursor}
              violationSeqs={violationSeqs}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          )
        }
        return (
          <EventListItem
            key={node.entry.seq}
            entry={node.entry}
            index={node.flatIndex}
            isActive={node.flatIndex === cursor}
            hasViolation={violationSeqs.has(node.entry.seq)}
            onClick={() => onSelect(node.flatIndex)}
          />
        )
      })}
    </>
  )
}

function DelegationGroup({ node, cursor, violationSeqs, expanded, onToggle, onSelect }: {
  node: TraceNode; cursor: number; violationSeqs: Set<number>
  expanded: Set<number>; onToggle: (fi: number) => void; onSelect: (fi: number) => void
}) {
  const isExpanded = expanded.has(node.flatIndex)
  const isActive = node.flatIndex === cursor
  const isEndActive = node.endFlatIndex != null && node.endFlatIndex === cursor
  const hasError = !!node.endEntry?.event?.error
  const goal = String(node.entry.event.childGoal ?? node.entry.event.goal ?? "")

  return (
    <div>
      {/* Delegation header */}
      <div
        data-seq={node.flatIndex}
        className={[
          "flex items-center gap-1.5 cursor-pointer transition-colors pl-1.5 pr-2.5 py-1",
          isActive ? "bg-elevated/80" : "hover:bg-elevated/30",
          violationSeqs.has(node.entry.seq) ? "border-l-2 border-error" : "",
        ].join(" ")}
        onClick={() => onSelect(node.flatIndex)}
      >
        <button
          className="flex items-center justify-center w-5 h-5 shrink-0 text-text-muted hover:text-text rounded transition-colors"
          onClick={(e) => { e.stopPropagation(); onToggle(node.flatIndex) }}
        >
          <ChevronRight size={14} className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} />
        </button>
        <span className="text-[13px] font-semibold font-mono shrink-0" style={{ color: "var(--color-viz-plum)" }}>DLGT</span>
        <span className="text-text-secondary text-sm truncate flex-1">{trnc(goal, 36)}</span>
        {!isExpanded && (
          <span className={`text-[11px] font-mono shrink-0 ${hasError ? "text-error/70" : "text-success/70"}`}>
            {node.subtreeCount} {hasError ? "✗" : "✓"}
          </span>
        )}
      </div>

      {/* Children — only rendered when expanded */}
      {isExpanded && (
        <div className="ml-3 border-l-2 border-viz-plum/15 pl-0.5">
          <TraceTreeView
            nodes={node.children!}
            cursor={cursor}
            violationSeqs={violationSeqs}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
          />
          {/* Delegation end indicator */}
          {node.endEntry && (
            <div
              data-seq={node.endFlatIndex}
              className={[
                "cursor-pointer transition-colors px-2.5 py-0.5 text-[12px] font-mono",
                isEndActive ? "bg-elevated/80" : "hover:bg-elevated/30",
                hasError ? "text-error/60" : "text-success/60",
              ].join(" ")}
              onClick={() => node.endFlatIndex != null && onSelect(node.endFlatIndex)}
            >
              {hasError ? "✗ delegation failed" : "✓ delegation done"}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Event list item (leaf nodes) ─────────────────────────────────

function EventListItem({ entry, index, isActive, hasViolation, onClick }: {
  entry: TrajectoryEntry; index: number; isActive: boolean; hasViolation: boolean; onClick: () => void
}) {
  const meta = EVENT_META[entry.event.kind] ?? EVENT_META["error"]
  const kind = entry.event.kind

  // Base wrapper — active highlight + violation left border
  const wrapCls = [
    "cursor-pointer transition-colors px-2.5",
    isActive ? "bg-elevated/80" : "hover:bg-elevated/30",
    hasViolation ? "border-l-2 border-error" : "",
  ].join(" ")

  // Iteration gets a separator
  if (kind === "iteration") {
    return (
      <div data-seq={index} className={`${wrapCls} text-text-muted text-[13px] font-mono pt-2 pb-0.5 border-t border-elevated/50 mt-0.5`} onClick={onClick}>
        iteration {String(entry.event.current)}/{String(entry.event.max)}
      </div>
    )
  }

  // Goal
  if (kind === "goal") {
    return (
      <div data-seq={index} className={`${wrapCls} pt-1.5 pb-1`} onClick={onClick}>
        <span className="text-accent font-semibold text-sm">GOAL</span>
        <span className="text-text ml-2 text-sm">{trnc(entry.event.text, 60)}</span>
      </div>
    )
  }

  // Thinking — left accent stripe
  if (kind === "thinking") {
    return (
      <div data-seq={index} className={`${wrapCls} py-0.5 pl-3 ${!hasViolation ? "border-l-2 border-accent/30" : ""}`} onClick={onClick}>
        <span className="text-accent text-[13px] font-medium">THK</span>
        <span className="text-text-secondary text-sm ml-2">{trnc(entry.event.text, 50)}</span>
      </div>
    )
  }

  // Tool call
  if (kind === "tool-call") {
    return (
      <div data-seq={index} className={`${wrapCls} py-1`} onClick={onClick}>
        <span className="text-warning text-[13px] font-medium font-mono">CALL</span>
        <span className="text-text text-sm font-medium font-mono ml-2">{String(entry.event.tool)}</span>
        {entry.event.argsSummary ? (
          <span className="text-text-muted text-[13px] font-mono ml-1.5 truncate">{String(trnc(entry.event.argsSummary, 40))}</span>
        ) : null}
      </div>
    )
  }

  // Tool result
  if (kind === "tool-result") {
    return (
      <div data-seq={index} className={`${wrapCls} py-0.5 pl-3`} onClick={onClick}>
        <span className="text-success text-[13px] font-medium font-mono">RSLT</span>
        <span className="text-text-muted text-[13px] font-mono ml-2">{trnc(entry.event.text, 50)}</span>
      </div>
    )
  }

  // Tool error
  if (kind === "tool-error") {
    return (
      <div data-seq={index} className={`${wrapCls} py-0.5 pl-3`} onClick={onClick}>
        <span className="text-error text-[13px] font-medium font-mono">ERR</span>
        <span className="text-error/80 text-sm ml-2">{trnc(entry.event.text, 50)}</span>
      </div>
    )
  }

  // Answer
  if (kind === "answer") {
    return (
      <div data-seq={index} className={`${wrapCls} pt-2 pb-1 border-t border-elevated/50 mt-0.5`} onClick={onClick}>
        <div className="text-success font-semibold text-sm">COMPLETED</div>
        <div className="text-text-secondary text-sm truncate">{trnc(entry.event.text, 60)}</div>
      </div>
    )
  }

  // Error
  if (kind === "error") {
    return (
      <div data-seq={index} className={`${wrapCls} pt-2 pb-1 border-t border-elevated/50 mt-0.5`} onClick={onClick}>
        <span className="text-error font-semibold text-sm">FAILED</span>
        <span className="text-error/80 text-sm ml-2">{trnc(entry.event.text, 50)}</span>
      </div>
    )
  }

  // Delegation iteration (child iteration tick)
  if (kind === "delegation-iteration") {
    return (
      <div data-seq={index} className={`${wrapCls} py-0.5 text-text-muted text-[12px] font-mono`} onClick={onClick}>
        ↳ child iter {String(entry.event.current ?? "")}/{String(entry.event.max ?? "")}
      </div>
    )
  }

  // Usage (token usage tick)
  if (kind === "usage") {
    return (
      <div data-seq={index} className={`${wrapCls} py-0.5 text-text-muted text-[12px] font-mono`} onClick={onClick}>
        ⊙ usage
      </div>
    )
  }

  // User input request
  if (kind === "user-input-request") {
    return (
      <div data-seq={index} className={`${wrapCls} py-1`} onClick={onClick}>
        <span className="text-accent text-[13px] font-medium font-mono">ASK</span>
        <span className="text-text-secondary text-sm ml-2">{trnc(entry.event.question ?? entry.event.text, 60)}</span>
      </div>
    )
  }

  // User input response
  if (kind === "user-input-response") {
    return (
      <div data-seq={index} className={`${wrapCls} py-0.5 pl-3`} onClick={onClick}>
        <span className="text-accent text-[13px] font-medium font-mono">RPL</span>
        <span className="text-text-muted text-[13px] font-mono ml-2">{trnc(entry.event.text, 60)}</span>
      </div>
    )
  }

  // Fallback — render with proper meta (no more false "FAIL")
  return (
    <div data-seq={index} className={`${wrapCls} py-0.5 text-text-muted text-[12px] font-mono`} onClick={onClick}>
      <span style={{ color: meta.color }}>{meta.short}</span>
      <span className="ml-2">{eventPreview(entry.event)}</span>
    </div>
  )
}

function TimelineScrubber({ events, cursor, violationSeqs, onSeek }: {
  events: TrajectoryEntry[]; cursor: number; violationSeqs: Set<number>; onSeek: (idx: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  function handleClick(e: React.MouseEvent) {
    const bar = barRef.current
    if (!bar || events.length === 0) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(Math.round(pct * (events.length - 1)))
  }
  const cursorPct = events.length > 1 ? (cursor / (events.length - 1)) * 100 : 0

  return (
    <div className="relative">
      <div ref={barRef} className="h-7 rounded-md bg-base cursor-pointer relative overflow-hidden" onClick={handleClick}>
        {events.map((entry, i) => {
          const pct = events.length > 1 ? (i / (events.length - 1)) * 100 : 50
          const meta = EVENT_META[entry.event.kind] ?? EVENT_META["error"]
          return (
            <div key={entry.seq} className="absolute top-0 h-full"
              style={{
                left: `${pct}%`,
                width: `${Math.max(100 / events.length, 2)}%`,
                background: violationSeqs.has(entry.seq) ? "var(--color-error)" : meta.color,
                opacity: i === cursor ? 0.6 : 0.15,
              }}
            />
          )
        })}
        <div className="absolute top-0 h-full w-0.5 bg-text z-10" style={{ left: `${cursorPct}%`, transition: "left 0.1s ease-out" }} />
      </div>
      <div className="h-px rounded-full bg-elevated/30 mt-0.5 overflow-hidden">
        <div className="h-full bg-accent/50 rounded-full" style={{ width: `${cursorPct}%`, transition: "width 0.1s ease-out" }} />
      </div>
    </div>
  )
}

function EventDetail({ entry, violation }: { entry: TrajectoryEntry; violation: Violation | null }) {
  const { event, timestamp, seq } = entry
  const meta = EVENT_META[event.kind] ?? EVENT_META["error"]
  const time = timestamp?.split("T")[1]?.split(".")[0] ?? ""

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className="text-base font-semibold" style={{ color: meta.color }}>{meta.label}</span>
        <span className="text-[13px] text-text-muted font-mono">#{seq}</span>
        <span className="text-[13px] text-text-muted font-mono ml-auto">{time}</span>
      </div>
      {violation && (
        <div className="flex items-start gap-2 bg-error/10 text-error text-sm px-3 py-2.5 rounded-lg">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-medium">Transition violation: </span>
            <span className="text-error/80">{violation.from} → {violation.to} — {violation.message}</span>
          </div>
        </div>
      )}
      <EventContent event={event} />
    </div>
  )
}

function EventContent({ event }: { event: TrajectoryEvent }) {
  switch (event.kind) {
    case "goal": return <ContentBlock label="Goal" text={String(event.text ?? "")} />
    case "thinking": return <ContentBlock label="Reasoning" text={String(event.text ?? "")} />
    case "tool-call":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-muted">Tool:</span>
            <span className="text-sm font-mono font-medium text-warning">{String(event.tool)}</span>
          </div>
          {event.argsSummary ? <div className="text-sm text-text-muted font-mono">{String(event.argsSummary)}</div> : null}
          {event.argsFormatted ? (
            <pre className="text-sm font-mono text-text-secondary bg-base rounded-lg p-3 overflow-auto whitespace-pre-wrap">{String(event.argsFormatted)}</pre>
          ) : null}
        </div>
      )
    case "tool-result": return <ContentBlock label="Result" text={String(event.text ?? "")} mono />
    case "tool-error": return <ContentBlock label="Error" text={String(event.text ?? "")} mono error />
    case "iteration": return <div className="text-sm text-text-muted font-mono">Iteration {String(event.current)}/{String(event.max)}</div>
    case "delegation-start":
      return (
        <div className="space-y-1">
          <ContentBlock label="Delegating" text={String(event.childGoal ?? event.goal ?? "")} />
          {event.childRunId ? <div className="text-[13px] text-text-muted font-mono">Child run: {String(event.childRunId)}</div> : null}
        </div>
      )
    case "delegation-end": return <ContentBlock label="Delegation result" text={String(event.result ?? event.answer ?? "")} />
    case "delegation-iteration": return <div className="text-sm text-text-muted font-mono">Child iteration {String(event.current ?? "")}/{String(event.max ?? "")}</div>
    case "usage": return <div className="text-sm text-text-muted font-mono">Token usage event</div>
    case "system-prompt": return <ContentBlock label="System Prompt" text={String(event.text ?? "")} mono />
    case "tools-resolved": {
      const tools = (event as unknown as { tools: Array<{ name: string }> }).tools ?? []
      return <ContentBlock label={`Tools Resolved (${tools.length})`} text={tools.map((t: { name: string }) => t.name).join(", ")} mono />
    }
    case "llm-request": {
      const req = event as unknown as { iteration: number; messageCount: number; toolCount: number }
      return <div className="text-sm text-text-muted font-mono">LLM Request — iteration {req.iteration + 1}, {req.messageCount} messages, {req.toolCount} tools</div>
    }
    case "llm-response": {
      const res = event as unknown as { iteration: number; durationMs: number; content: string | null; toolCalls: unknown[] }
      return (
        <div className="space-y-1">
          <div className="text-sm text-text-muted font-mono">LLM Response — {res.durationMs}ms, {res.toolCalls?.length ?? 0} tool calls</div>
          {res.content && <ContentBlock label="Content" text={res.content} />}
        </div>
      )
    }
    case "user-input-request": return <ContentBlock label="Question" text={String((event as unknown as { question: string }).question ?? event.text ?? "")} />
    case "user-input-response": return <ContentBlock label="User Reply" text={String(event.text ?? "")} />
    case "answer":
      return (
        <div className="space-y-1">
          <div className="text-sm text-success font-semibold">Final Answer</div>
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">{String(event.text)}</div>
        </div>
      )
    case "error": return <ContentBlock label="Fatal Error" text={String(event.text ?? "")} error />
    default: return <pre className="text-sm font-mono text-text-muted bg-base rounded-lg p-3 overflow-auto">{JSON.stringify(event, null, 2)}</pre>
  }
}

function ContentBlock({ label, text, mono, error: isError }: { label: string; text: string; mono?: boolean; error?: boolean }) {
  return (
    <div className="space-y-1">
      <div className={`text-sm font-medium ${isError ? "text-error" : "text-text-muted"}`}>{label}</div>
      <div className={`text-sm whitespace-pre-wrap leading-relaxed ${mono ? "font-mono bg-base rounded-lg p-3" : ""} ${isError ? "text-error/80" : "text-text-secondary"}`}>
        {text}
      </div>
    </div>
  )
}

function ScorecardPanel({ scorecard }: { scorecard: Scorecard }) {
  const errPct = Math.round(scorecard.errorRate * 100)
  return (
    <div className="px-3 py-2 border-b border-elevated/50">
      <div className="flex items-center gap-3 flex-wrap text-sm font-mono">
        <Stat label="events" value={scorecard.totalEvents} />
        <Stat label="calls" value={scorecard.toolCalls} />
        <Stat label="errors" value={scorecard.toolErrors} color={scorecard.toolErrors > 0 ? "text-error" : undefined} />
        <Stat label="err%" value={`${errPct}%`} color={errPct > 20 ? "text-error" : undefined} />
        <Stat label="iters" value={scorecard.iterations} />
        <Stat label="evt/iter" value={scorecard.eventsPerIteration?.toFixed?.(1) ?? "—"} />
        <Stat label="thk/act" value={scorecard.thinkToActRatio === Infinity ? "∞" : scorecard.thinkToActRatio?.toFixed?.(1) ?? "—"} />
        <Stat label="deleg" value={scorecard.delegations} />
        {(scorecard.patterns?.length ?? 0) > 0 && (
          <span className="text-text-muted/30">│</span>
        )}
        {(scorecard.patterns?.length ?? 0) > 0 && scorecard.patterns.map((p) => (
          <span key={p} className={`text-[12px] px-2 py-0.5 rounded-full font-medium ${
            p === "retry-loop" ? "bg-error/10 text-error"
              : p === "efficient" ? "bg-success/10 text-success"
                : "bg-accent/10 text-accent"
          }`}>{p}</span>
        ))}
        {(scorecard.toolsUsed?.length ?? 0) > 0 && (
          <span className="text-text-muted/30">│</span>
        )}
        {(scorecard.toolsUsed?.length ?? 0) > 0 && scorecard.toolsUsed.map((t) => (
          <span key={t} className="text-[12px] text-text-secondary">
            {t}<span className="text-text-muted">×{scorecard.toolFrequency[t]}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${color ?? "text-text"}`}>{value}</span>
      <span className="text-text-muted text-[12px] font-sans">{label}</span>
    </span>
  )
}

function RunPicker({ runs, selectedId, onSelect, onClose }: {
  runs: Run[]; selectedId: string | null; onSelect: (id: string) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])
  return (
    <div ref={ref} className="absolute top-full left-0 mt-1 w-80 max-h-72 overflow-y-auto bg-surface border border-border rounded-xl shadow-xl z-50">
      {runs.length === 0 && <div className="px-3 py-4 text-sm text-text-muted text-center">No runs</div>}
      {runs.map((run) => (
        <button
          key={run.id}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${run.id === selectedId ? "bg-elevated" : "hover:bg-elevated/40"}`}
          onClick={() => onSelect(run.id)}
        >
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: run.status === "completed" ? "var(--color-success)" : "var(--color-error)" }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text truncate">{truncate(run.goal, 44)}</div>
            <div className="text-[13px] text-text-muted">{timeAgo(run.createdAt)} · {run.stepCount} steps</div>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────

function eventPreview(event: TrajectoryEvent): string {
  switch (event.kind) {
    case "goal": return trnc(event.text, 200)
    case "thinking": return trnc(event.text, 200)
    case "tool-call": return `${String(event.tool ?? "")} ${trnc(event.argsSummary, 160)}`
    case "tool-result": return trnc(event.text, 200)
    case "tool-error": return trnc(event.text, 200)
    case "iteration": return `${event.current}/${event.max}`
    case "delegation-start": return trnc(event.childGoal ?? event.goal, 200)
    case "delegation-end": return trnc(event.result, 200)
    case "answer": return trnc(event.text, 200)
    case "error": return trnc(event.text, 200)
    case "system-prompt": return trnc(event.text, 80)
    case "tools-resolved": {
      const tools = (event as unknown as { tools: Array<{ name: string }> }).tools ?? []
      return `${tools.length} tools`
    }
    case "llm-request": {
      const req = event as unknown as { messageCount: number }
      return `${req.messageCount ?? "?"} messages`
    }
    case "llm-response": {
      const res = event as unknown as { durationMs: number }
      return `${res.durationMs ?? "?"}ms`
    }
    case "user-input-request": return trnc((event as unknown as { question: string }).question ?? event.text, 200)
    case "user-input-response": return trnc(event.text, 200)
    default: return ""
  }
}

function trnc(v: unknown, len: number): string {
  const s = String(v ?? "")
  return s.length > len ? s.slice(0, len) + "…" : s
}

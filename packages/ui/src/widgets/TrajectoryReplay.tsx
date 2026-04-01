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
  BarChart3,
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
  X,
} from "lucide-react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { Run } from "../types"
import { timeAgo, truncate } from "../util"

// ── Types ────────────────────────────────────────────────────────

type EventKind =
  | "goal" | "thinking" | "tool-call" | "tool-result"
  | "tool-error" | "iteration" | "delegation-start"
  | "delegation-end" | "delegation-iteration" | "usage"
  | "answer" | "error"

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

const META_TREE_KINDS = new Set<string>(["usage", "delegation-iteration"])

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
        if (walk(n.children)) return true
        path.pop()
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
  "answer":            { color: "var(--color-success)",    label: "Final Answer",   short: "ANS" },
  "error":             { color: "var(--color-error)",      label: "Fatal Error",    short: "FAIL" },
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

  useEffect(() => {
    if (effectiveRunId) loadTrajectory(effectiveRunId)
  }, [effectiveRunId, loadTrajectory])

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
            className="text-sm text-text-muted hover:text-text px-2 py-1 rounded-md hover:bg-elevated/60 transition-colors truncate max-w-[180px]"
            onClick={() => setShowRunPicker(!showRunPicker)}
          >
            {truncate(effectiveRunId, 14)}
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
  const [showScorecard, setShowScorecard] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const eventListRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const [panelWidth, setPanelWidth] = useState(320)
  const draggingRef = useRef(false)

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
        case "ArrowRight": e.preventDefault(); setCursor((c) => Math.min(c + 1, trajectory.length - 1)); break
        case "ArrowLeft": e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); break
        case "Home": e.preventDefault(); setCursor(0); break
        case "End": e.preventDefault(); setCursor(trajectory.length - 1); break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [trajectory.length])

  const violationSeqs = useMemo(() => {
    if (!replayData?.violations) return new Set<number>()
    return new Set(replayData.violations.map((v) => v.seq))
  }, [replayData])

  const violationAt = useCallback(
    (seq: number) => replayData?.violations?.find((v) => v.seq === seq),
    [replayData],
  )

  // Build delegation tree from flat trajectory
  const tree = useMemo(() => buildTraceTree(trajectory), [trajectory])

  // Track which delegation groups are expanded (by flatIndex)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const toggleExpanded = useCallback((flatIndex: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(flatIndex)) next.delete(flatIndex)
      else next.add(flatIndex)
      return next
    })
  }, [])

  // Auto-expand delegations containing the cursor (for VCR playback)
  useEffect(() => {
    const ancestors = ancestorPath(tree, cursor)
    if (ancestors.length === 0) return
    setExpanded(prev => {
      const ids = ancestors.map(a => a.flatIndex)
      if (ids.every(id => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }, [cursor, tree])

  // Breadcrumb path for current cursor position
  const breadcrumbs = useMemo(() => ancestorPath(tree, cursor), [tree, cursor])

  const currentEntry = trajectory[cursor] ?? null

  if (trajectory.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No trajectory data</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Scorecard toggle + counter */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        {replayData?.scorecard && (
          <button
            className={`flex items-center gap-1.5 text-[13px] px-2.5 py-1 rounded-md transition-colors ${
              showScorecard ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text hover:bg-elevated/60"
            }`}
            onClick={() => setShowScorecard(!showScorecard)}
          >
            <BarChart3 size={14} />
            Scorecard
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[13px] text-text-muted font-mono tabular-nums">{cursor + 1}/{trajectory.length}</span>
      </div>

      {/* Scorecard */}
      {showScorecard && replayData?.scorecard && <ScorecardPanel scorecard={replayData.scorecard} />}

      {/* Timeline */}
      <div className="px-2 py-1 shrink-0">
        <TimelineScrubber events={trajectory} cursor={cursor} violationSeqs={violationSeqs} onSeek={setCursor} />
      </div>

      {/* Event list + detail */}
      <div ref={splitRef} className="flex flex-1 min-h-0">
        <div ref={eventListRef} className="shrink-0 overflow-y-auto" style={{ width: panelWidth }}>
          {breadcrumbs.length > 0 && (
            <div className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-text-muted border-b border-elevated/30 bg-elevated/20 sticky top-0 z-10 flex-wrap">
              <button className="hover:text-text transition-colors shrink-0" onClick={() => { setCursor(0); setPlaying(false) }}>Root</button>
              {breadcrumbs.map((node) => (
                <Fragment key={node.flatIndex}>
                  <span className="text-text-muted/40 shrink-0">/</span>
                  <button
                    className="hover:text-accent transition-colors truncate max-w-[100px]"
                    onClick={() => { setCursor(node.flatIndex); setPlaying(false) }}
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
        onCursor={setCursor}
        onPlay={() => { if (cursor >= trajectory.length - 1) setCursor(0); setPlaying(!playing) }}
        onSpeed={() => { const idx = SPEEDS.indexOf(speed as typeof SPEEDS[number]); setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]) }}
        onReset={() => { setCursor(0); setPlaying(false) }}
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

  if (trajectory.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No trajectory to mutate</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      {/* Help text */}
      <div className="px-4 py-2.5 text-[13px] text-text-muted border-b border-elevated/50">
        Alter the trajectory and replay to test agent resilience. Drop events, replace them with errors,
        or inject new events — then see how the state machine and scorecard change.
      </div>

      {/* Mutation list */}
      <div className="px-4 py-2.5 space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">Mutations ({mutations.length})</span>
          <div className="flex-1" />
          <button
            className={`flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-md font-medium transition-colors ${
              mutations.length > 0
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "bg-elevated/50 text-text-muted cursor-not-allowed"
            }`}
            onClick={runMutatedReplay}
            disabled={mutations.length === 0 || mutLoading}
          >
            <RefreshCw size={13} className={mutLoading ? "animate-spin" : ""} />
            Replay with mutations
          </button>
        </div>

        {mutations.length === 0 && (
          <div className="text-[13px] text-text-muted py-2">
            No mutations yet. Click events below to add mutations.
          </div>
        )}

        {mutations.map((mut, i) => (
          <div key={i} className="flex items-center gap-2.5 bg-elevated/40 rounded-lg px-3 py-2 text-[13px]">
            <span className={`font-mono font-medium px-2 py-0.5 rounded ${
              mut.type === "drop" ? "bg-error/10 text-error"
                : mut.type === "replace" ? "bg-warning/10 text-warning"
                  : "bg-accent/10 text-accent"
            }`}>
              {mut.type.toUpperCase()}
            </span>
            <span className="text-text-muted">seq #{mut.seq}</span>
            {mut.event && <span className="text-text-secondary">→ {mut.event.kind}</span>}
            <div className="flex-1" />
            <button className="text-text-muted hover:text-error transition-colors" onClick={() => removeMutation(i)}>
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      {/* Mutated replay result */}
      {mutatedReplay && (
        <div className="px-4 py-3 border-t border-elevated/50 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">Mutated Replay Result</span>
            <div className={`flex items-center gap-1.5 text-[13px] font-medium px-2 py-0.5 rounded-full ${
              mutatedReplay.valid ? "bg-success/10 text-success" : "bg-error/10 text-error"
            }`}>
              {mutatedReplay.valid ? <Circle size={9} fill="currentColor" /> : <AlertTriangle size={14} />}
              {mutatedReplay.valid ? "Valid" : `${mutatedReplay.violations?.length ?? 0} violation${(mutatedReplay.violations?.length ?? 0) === 1 ? "" : "s"}`}
            </div>
          </div>

          {/* Compare original vs mutated side-by-side */}
          {replayData?.scorecard && mutatedReplay.scorecard && (
            <div className="grid grid-cols-2 gap-3 text-[13px]">
              <div className="space-y-1">
                <div className="text-text-muted font-medium text-[13px]">Original</div>
                <MiniScorecard sc={replayData.scorecard} />
              </div>
              <div className="space-y-1">
                <div className="text-text-muted font-medium text-[13px]">Mutated</div>
                <MiniScorecard sc={mutatedReplay.scorecard} />
              </div>
            </div>
          )}

          {/* Violations */}
          {(mutatedReplay.violations?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[13px] text-error font-medium">Violations</div>
              {mutatedReplay.violations!.map((v, i) => (
                <div key={i} className="flex items-start gap-2 text-[13px] text-error/80 bg-error/5 rounded-lg px-3 py-1.5">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>#{v.seq}: {v.from} → {v.to} — {v.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Event list with mutation actions */}
      <div className="border-t border-elevated/50">
        <div className="px-4 py-2 text-[12px] text-text-muted font-medium uppercase tracking-wide">
          Events — click actions to add mutations
        </div>
        {trajectory.map((entry) => {
          const meta = EVENT_META[entry.event.kind] ?? EVENT_META["error"]
          const kind = entry.event.kind
          const hasMut = mutations.some((m) => m.seq === entry.seq)

          // Mutation action buttons (shared for all rows)
          const actions = (
            <div className="flex items-center gap-1 shrink-0 ml-auto opacity-50 hover:opacity-100 transition-opacity">
              <MutButton title="Drop this event" onClick={() => addMutation("drop", entry.seq)} color="error">
                <Trash2 size={14} />
              </MutButton>
              <MutButton title="Replace with error" onClick={() => addMutation("replace", entry.seq)} color="warning">
                <RefreshCw size={14} />
              </MutButton>
              <MutButton title="Inject error before" onClick={() => addMutation("inject", entry.seq)} color="accent">
                <Plus size={14} />
              </MutButton>
            </div>
          )

          const rowBase = `flex items-center px-4 transition-colors ${hasMut ? "bg-warning/5" : ""}`

          // Iteration — separator
          if (kind === "iteration") {
            return (
              <div key={entry.seq} className={`${rowBase} text-text-muted text-[13px] font-mono pt-2 pb-0.5 border-t border-elevated/50 mt-0.5`}>
                <span>iteration {String(entry.event.current)}/{String(entry.event.max)}</span>
                {actions}
              </div>
            )
          }

          // Goal
          if (kind === "goal") {
            return (
              <div key={entry.seq} className={`${rowBase} pt-1.5 pb-1`}>
                <span className="text-accent font-semibold text-sm">GOAL</span>
                <span className="text-text ml-2 text-sm truncate">{trnc(entry.event.text, 60)}</span>
                {actions}
              </div>
            )
          }

          // Thinking
          if (kind === "thinking") {
            return (
              <div key={entry.seq} className={`${rowBase} py-0.5 pl-4 border-l-2 border-accent/30`}>
                <span className="text-accent text-[13px] font-medium">THK</span>
                <span className="text-text-secondary text-sm ml-2 truncate">{trnc(entry.event.text, 50)}</span>
                {actions}
              </div>
            )
          }

          // Tool call
          if (kind === "tool-call") {
            return (
              <div key={entry.seq} className={`${rowBase} py-1`}>
                <span className="text-warning text-[13px] font-medium font-mono">CALL</span>
                <span className="text-text text-sm font-medium font-mono ml-2">{String(entry.event.tool)}</span>
                {entry.event.argsSummary ? <span className="text-text-muted text-[13px] font-mono ml-1.5 truncate">{String(trnc(entry.event.argsSummary, 40))}</span> : null}
                {actions}
              </div>
            )
          }

          // Tool result
          if (kind === "tool-result") {
            return (
              <div key={entry.seq} className={`${rowBase} py-0.5 pl-4`}>
                <span className="text-success text-[13px] font-medium font-mono">RSLT</span>
                <span className="text-text-muted text-[13px] font-mono ml-2 truncate">{trnc(entry.event.text, 50)}</span>
                {actions}
              </div>
            )
          }

          // Tool error
          if (kind === "tool-error") {
            return (
              <div key={entry.seq} className={`${rowBase} py-0.5 pl-4`}>
                <span className="text-error text-[13px] font-medium font-mono">ERR</span>
                <span className="text-error/80 text-sm ml-2 truncate">{trnc(entry.event.text, 50)}</span>
                {actions}
              </div>
            )
          }

          // Answer
          if (kind === "answer") {
            return (
              <div key={entry.seq} className={`${rowBase} pt-2 pb-1 border-t border-elevated/50 mt-0.5 flex-col items-start`}>
                <div className="flex items-center w-full">
                  <span className="text-success font-semibold text-sm">COMPLETED</span>
                  {actions}
                </div>
                <div className="text-text-secondary text-sm truncate w-full">{trnc(entry.event.text, 80)}</div>
              </div>
            )
          }

          // Error
          if (kind === "error") {
            return (
              <div key={entry.seq} className={`${rowBase} pt-2 pb-1 border-t border-elevated/50 mt-0.5`}>
                <span className="text-error font-semibold text-sm">FAILED</span>
                <span className="text-error/80 text-sm ml-2 truncate">{trnc(entry.event.text, 50)}</span>
                {actions}
              </div>
            )
          }

          // Fallback
          return (
            <div key={entry.seq} className={`${rowBase} py-0.5`}>
              <span className="text-[13px] font-medium font-mono" style={{ color: meta.color }}>{meta.short}</span>
              <span className="text-text-secondary text-sm ml-2 truncate">{eventPreview(entry.event)}</span>
              {actions}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MutButton({ children, onClick, title, color }: {
  children: React.ReactNode; onClick: () => void; title: string; color: string
}) {
  return (
    <button
      className={`w-7 h-7 flex items-center justify-center rounded text-${color}/60 hover:text-${color} hover:bg-${color}/10 transition-colors`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
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

  // Fallback
  return (
    <div data-seq={index} className={`${wrapCls} py-0.5`} onClick={onClick}>
      <span className="text-[13px] font-medium font-mono" style={{ color: meta.color }}>{meta.short}</span>
      <span className="text-text-muted text-sm ml-2">{eventPreview(entry.event)}</span>
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
            <pre className="text-sm font-mono text-text-secondary bg-base rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap">{String(event.argsFormatted)}</pre>
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
    case "answer":
      return (
        <div className="space-y-1">
          <div className="text-sm text-success font-semibold">Final Answer</div>
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">{String(event.text)}</div>
        </div>
      )
    case "error": return <ContentBlock label="Fatal Error" text={String(event.text ?? "")} error />
    default: return <pre className="text-sm font-mono text-text-muted bg-base rounded-lg p-3 max-h-64 overflow-auto">{JSON.stringify(event, null, 2)}</pre>
  }
}

function ContentBlock({ label, text, mono, error: isError }: { label: string; text: string; mono?: boolean; error?: boolean }) {
  return (
    <div className="space-y-1">
      <div className={`text-sm font-medium ${isError ? "text-error" : "text-text-muted"}`}>{label}</div>
      <div className={`text-sm whitespace-pre-wrap leading-relaxed max-h-80 overflow-auto ${mono ? "font-mono bg-base rounded-lg p-3" : ""} ${isError ? "text-error/80" : "text-text-secondary"}`}>
        {text}
      </div>
    </div>
  )
}

function ScorecardPanel({ scorecard }: { scorecard: Scorecard }) {
  const errPct = Math.round(scorecard.errorRate * 100)
  return (
    <div className="px-3 py-2.5 border-b border-elevated/50 space-y-2.5">
      {/* Two-row compact stats strip */}
      <div className="flex items-center gap-4 text-sm font-mono">
        <Stat label="events" value={scorecard.totalEvents} />
        <Stat label="calls" value={scorecard.toolCalls} />
        <Stat label="errors" value={scorecard.toolErrors} color={scorecard.toolErrors > 0 ? "text-error" : undefined} />
        <Stat label="err%" value={`${errPct}%`} color={errPct > 20 ? "text-error" : undefined} />
        <Stat label="iters" value={scorecard.iterations} />
        <Stat label="evt/iter" value={scorecard.eventsPerIteration?.toFixed?.(1) ?? "—"} />
        <Stat label="thk/act" value={scorecard.thinkToActRatio === Infinity ? "∞" : scorecard.thinkToActRatio?.toFixed?.(1) ?? "—"} />
        <Stat label="deleg" value={scorecard.delegations} />
      </div>

      {/* Patterns + tools inline */}
      <div className="flex items-center gap-3 flex-wrap text-[13px]">
        {(scorecard.patterns?.length ?? 0) > 0 && (
          <>
            {scorecard.patterns.map((p) => (
              <span key={p} className={`px-2 py-0.5 rounded-full font-medium ${
                p === "retry-loop" ? "bg-error/10 text-error"
                  : p === "efficient" ? "bg-success/10 text-success"
                    : "bg-accent/10 text-accent"
              }`}>{p}</span>
            ))}
          </>
        )}
        {(scorecard.toolsUsed?.length ?? 0) > 0 && scorecard.toolsUsed.map((t) => (
          <span key={t} className="text-text-secondary font-mono">
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
    case "goal": return trnc(event.text, 50)
    case "thinking": return trnc(event.text, 50)
    case "tool-call": return String(event.tool ?? "")
    case "tool-result": return trnc(event.text, 50)
    case "tool-error": return trnc(event.text, 50)
    case "iteration": return `${event.current}/${event.max}`
    case "delegation-start": return trnc(event.childGoal ?? event.goal, 50)
    case "delegation-end": return trnc(event.result, 50)
    case "answer": return trnc(event.text, 50)
    case "error": return trnc(event.text, 50)
    default: return ""
  }
}

function trnc(v: unknown, len: number): string {
  const s = String(v ?? "")
  return s.length > len ? s.slice(0, len) + "…" : s
}

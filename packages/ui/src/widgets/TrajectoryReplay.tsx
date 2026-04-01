/**
 * TrajectoryReplay — step-through debugger for agent run trajectories.
 *
 * Features:
 *   - VCR-style playback controls (play, pause, step forward/back, speed)
 *   - Scrubber timeline with color-coded event markers
 *   - Event detail panel with expandable content
 *   - Scorecard overlay with quality metrics
 *   - State machine transition validation (highlights violations)
 *   - Run selector: pick any completed run to replay
 */

import {
    AlertTriangle,
    BarChart3,
    ChevronLeft,
    ChevronRight,
    Circle,
    Pause,
    Play,
    RotateCcw,
    SkipBack,
    SkipForward,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { Run } from "../types"
import { timeAgo, truncate } from "../util"

// ── Types (mirror server trajectory.ts) ──────────────────────────

type EventKind =
  | "goal" | "thinking" | "tool-call" | "tool-result"
  | "tool-error" | "iteration" | "delegation-start"
  | "delegation-end" | "answer" | "error"

interface TrajectoryEvent {
  kind: EventKind
  [key: string]: unknown
}

interface TrajectoryEntry {
  seq: number
  event: TrajectoryEvent
  timestamp: string
}

interface Scorecard {
  totalEvents: number
  toolCalls: number
  toolErrors: number
  errorRate: number
  iterations: number
  delegations: number
  hasAnswer: boolean
  hasError: boolean
  toolsUsed: string[]
  toolFrequency: Record<string, number>
  eventsPerIteration: number
  thinkToActRatio: number
  patterns: string[]
}

interface Violation {
  seq: number
  from: string
  to: string
  message: string
}

interface ReplayResponse {
  valid: boolean
  violations: Violation[]
  scorecard: Scorecard
  eventCount: number
}

// ── Event color + label map ──────────────────────────────────────

const EVENT_META: Record<EventKind, { color: string; label: string; short: string }> = {
  "goal":              { color: "var(--color-accent)",   label: "Goal",             short: "GOAL" },
  "thinking":          { color: "var(--color-accent)",   label: "Thinking",         short: "THK" },
  "tool-call":         { color: "var(--color-warning)",  label: "Tool Call",        short: "CALL" },
  "tool-result":       { color: "var(--color-success)",  label: "Tool Result",      short: "RSLT" },
  "tool-error":        { color: "var(--color-error)",    label: "Tool Error",       short: "ERR" },
  "iteration":         { color: "var(--color-text-muted)", label: "Iteration",      short: "ITER" },
  "delegation-start":  { color: "var(--color-viz-plum)", label: "Delegate Start",   short: "DLGT" },
  "delegation-end":    { color: "var(--color-viz-plum)", label: "Delegate End",     short: "DONE" },
  "answer":            { color: "var(--color-success)",  label: "Final Answer",     short: "ANS" },
  "error":             { color: "var(--color-error)",    label: "Fatal Error",      short: "FAIL" },
}

const SPEEDS = [0.5, 1, 2, 4] as const

// ── Main component ───────────────────────────────────────────────

export function TrajectoryReplay() {
  const activeRunId = useStore((s) => s.activeRunId)
  const runs = useStore((s) => s.runs)

  // Data
  const [trajectory, setTrajectory] = useState<TrajectoryEntry[]>([])
  const [replayData, setReplayData] = useState<ReplayResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Playback state
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [showScorecard, setShowScorecard] = useState(false)

  // Run selector
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [showRunPicker, setShowRunPicker] = useState(false)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const eventListRef = useRef<HTMLDivElement>(null)

  const effectiveRunId = selectedRunId ?? activeRunId

  // Completed runs for the picker
  const completedRuns = useMemo(
    () => runs.filter((r) => r.status === "completed" || r.status === "failed"),
    [runs],
  )

  // ── Load trajectory + replay data ────────────────────────────

  const loadTrajectory = useCallback(async (runId: string) => {
    setLoading(true)
    setError(null)
    setPlaying(false)
    setCursor(0)
    setShowScorecard(false)

    try {
      const [trajRes, replayRes] = await Promise.all([
        api.getTrajectory(runId),
        api.replayTrajectory(runId),
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

  // ── Playback timer ───────────────────────────────────────────

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)

    if (playing && trajectory.length > 0) {
      const intervalMs = 800 / speed
      timerRef.current = setInterval(() => {
        setCursor((prev) => {
          if (prev >= trajectory.length - 1) {
            setPlaying(false)
            return prev
          }
          return prev + 1
        })
      }, intervalMs)
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [playing, speed, trajectory.length])

  // ── Auto-scroll event list to cursor ─────────────────────────

  useEffect(() => {
    const el = eventListRef.current
    if (!el) return
    const active = el.querySelector(`[data-seq="${cursor}"]`) as HTMLElement | null
    if (active) {
      active.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  }, [cursor])

  // ── Keyboard shortcuts ───────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      switch (e.key) {
        case " ":
          e.preventDefault()
          setPlaying((p) => !p)
          break
        case "ArrowRight":
          e.preventDefault()
          setCursor((c) => Math.min(c + 1, trajectory.length - 1))
          break
        case "ArrowLeft":
          e.preventDefault()
          setCursor((c) => Math.max(c - 1, 0))
          break
        case "Home":
          e.preventDefault()
          setCursor(0)
          break
        case "End":
          e.preventDefault()
          setCursor(trajectory.length - 1)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [trajectory.length])

  // ── Violation lookup ─────────────────────────────────────────

  const violationSeqs = useMemo(() => {
    if (!replayData) return new Set<number>()
    return new Set(replayData.violations.map((v) => v.seq))
  }, [replayData])

  const violationAt = useCallback(
    (seq: number) => replayData?.violations.find((v) => v.seq === seq),
    [replayData],
  )

  // ── Current event ────────────────────────────────────────────

  const currentEntry = trajectory[cursor] ?? null
  const currentEvent = currentEntry?.event ?? null

  // ── Empty state ──────────────────────────────────────────────

  if (!effectiveRunId) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Select a run to replay its trajectory
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading trajectory...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm">
        <span className="text-error">{error}</span>
        <button
          className="text-accent text-[13px] hover:underline"
          onClick={() => effectiveRunId && loadTrajectory(effectiveRunId)}
        >
          Retry
        </button>
      </div>
    )
  }

  if (trajectory.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No trajectory data for this run
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-0 select-none">
      {/* ── Header: run picker + scorecard toggle ─────────────── */}
      <div className="flex items-center gap-2 px-1 pb-2 shrink-0 border-b border-elevated/50">
        {/* Run picker */}
        <div className="relative">
          <button
            className="text-[13px] text-text-muted hover:text-text px-2 py-1 rounded-md hover:bg-elevated/60 transition-colors truncate max-w-[180px]"
            onClick={() => setShowRunPicker(!showRunPicker)}
          >
            {effectiveRunId ? truncate(effectiveRunId, 12) : "Pick run..."}
          </button>

          {showRunPicker && (
            <RunPicker
              runs={completedRuns}
              selectedId={effectiveRunId}
              onSelect={(id) => {
                setSelectedRunId(id)
                setShowRunPicker(false)
              }}
              onClose={() => setShowRunPicker(false)}
            />
          )}
        </div>

        {/* Validation badge */}
        {replayData && (
          <div className={`flex items-center gap-1 text-[12px] font-medium px-2 py-0.5 rounded-full ${
            replayData.valid
              ? "bg-success/10 text-success"
              : "bg-error/10 text-error"
          }`}>
            {replayData.valid ? (
              <Circle size={8} fill="currentColor" />
            ) : (
              <AlertTriangle size={11} />
            )}
            {replayData.valid ? "Valid" : `${replayData.violations.length} violation${replayData.violations.length !== 1 ? "s" : ""}`}
          </div>
        )}

        <div className="flex-1" />

        {/* Scorecard toggle */}
        {replayData && (
          <button
            className={`flex items-center gap-1 text-[12px] px-2 py-1 rounded-md transition-colors ${
              showScorecard
                ? "bg-accent/15 text-accent"
                : "text-text-muted hover:text-text hover:bg-elevated/60"
            }`}
            onClick={() => setShowScorecard(!showScorecard)}
          >
            <BarChart3 size={13} />
            Scorecard
          </button>
        )}

        {/* Event counter */}
        <span className="text-[12px] text-text-muted font-mono tabular-nums">
          {cursor + 1}/{trajectory.length}
        </span>
      </div>

      {/* ── Scorecard overlay ─────────────────────────────────── */}
      {showScorecard && replayData && (
        <ScorecardPanel scorecard={replayData.scorecard} />
      )}

      {/* ── Timeline scrubber ─────────────────────────────────── */}
      <div className="px-1 py-2 shrink-0">
        <TimelineScrubber
          events={trajectory}
          cursor={cursor}
          violationSeqs={violationSeqs}
          onSeek={setCursor}
        />
      </div>

      {/* ── Main content: event list + detail ─────────────────── */}
      <div className="flex flex-1 min-h-0 gap-0">
        {/* Event list (left) */}
        <div
          ref={eventListRef}
          className="w-[180px] shrink-0 overflow-y-auto border-r border-elevated/50"
        >
          {trajectory.map((entry, i) => {
            const meta = EVENT_META[entry.event.kind] ?? EVENT_META["error"]
            const isActive = i === cursor
            const hasViolation = violationSeqs.has(entry.seq)

            return (
              <div
                key={entry.seq}
                data-seq={i}
                className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer text-[12px] font-mono transition-colors ${
                  isActive
                    ? "bg-elevated text-text"
                    : "text-text-muted hover:bg-elevated/40 hover:text-text-secondary"
                }`}
                onClick={() => { setCursor(i); setPlaying(false) }}
              >
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: hasViolation ? "var(--color-error)" : meta.color }}
                />
                <span className="font-medium" style={{ color: isActive ? meta.color : undefined }}>
                  {meta.short}
                </span>
                <span className="truncate flex-1 text-[11px]">
                  {eventPreview(entry.event)}
                </span>
              </div>
            )
          })}
        </div>

        {/* Event detail (right) */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {currentEvent && (
            <EventDetail
              entry={currentEntry!}
              violation={violationAt(currentEntry!.seq) ?? null}
            />
          )}
        </div>
      </div>

      {/* ── Playback controls ─────────────────────────────────── */}
      <div className="flex items-center justify-center gap-1 px-2 py-2 shrink-0 border-t border-elevated/50">
        {/* Jump to start */}
        <ControlButton
          onClick={() => { setCursor(0); setPlaying(false) }}
          title="Jump to start (Home)"
        >
          <SkipBack size={14} />
        </ControlButton>

        {/* Step back */}
        <ControlButton
          onClick={() => { setCursor(Math.max(0, cursor - 1)); setPlaying(false) }}
          title="Step back (←)"
        >
          <ChevronLeft size={16} />
        </ControlButton>

        {/* Play / Pause */}
        <button
          className="flex items-center justify-center w-9 h-9 rounded-full bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
          onClick={() => {
            if (cursor >= trajectory.length - 1) setCursor(0)
            setPlaying(!playing)
          }}
          title="Play/Pause (Space)"
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>

        {/* Step forward */}
        <ControlButton
          onClick={() => { setCursor(Math.min(trajectory.length - 1, cursor + 1)); setPlaying(false) }}
          title="Step forward (→)"
        >
          <ChevronRight size={16} />
        </ControlButton>

        {/* Jump to end */}
        <ControlButton
          onClick={() => { setCursor(trajectory.length - 1); setPlaying(false) }}
          title="Jump to end (End)"
        >
          <SkipForward size={14} />
        </ControlButton>

        {/* Divider */}
        <div className="w-px h-5 bg-elevated mx-1.5" />

        {/* Speed */}
        <button
          className="text-[12px] font-mono text-text-muted hover:text-text px-2 py-1 rounded-md hover:bg-elevated/60 transition-colors tabular-nums"
          onClick={() => {
            const idx = SPEEDS.indexOf(speed as typeof SPEEDS[number])
            setSpeed(SPEEDS[(idx + 1) % SPEEDS.length])
          }}
          title="Playback speed"
        >
          {speed}×
        </button>

        {/* Reset */}
        <ControlButton
          onClick={() => { setCursor(0); setPlaying(false) }}
          title="Reset"
        >
          <RotateCcw size={13} />
        </ControlButton>
      </div>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────

function ControlButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      className="flex items-center justify-center w-7 h-7 text-text-muted hover:text-text rounded-md hover:bg-elevated/60 transition-colors"
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
}

// ── Timeline scrubber ────────────────────────────────────────────

function TimelineScrubber({
  events,
  cursor,
  violationSeqs,
  onSeek,
}: {
  events: TrajectoryEntry[]
  cursor: number
  violationSeqs: Set<number>
  onSeek: (idx: number) => void
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
      {/* Track */}
      <div
        ref={barRef}
        className="h-6 rounded-md bg-base cursor-pointer relative overflow-hidden"
        onClick={handleClick}
      >
        {/* Event tick marks */}
        {events.map((entry, i) => {
          const pct = events.length > 1 ? (i / (events.length - 1)) * 100 : 50
          const meta = EVENT_META[entry.event.kind] ?? EVENT_META["error"]
          const hasViolation = violationSeqs.has(entry.seq)

          return (
            <div
              key={entry.seq}
              className="absolute top-0 h-full"
              style={{
                left: `${pct}%`,
                width: `${Math.max(100 / events.length, 2)}%`,
                background: hasViolation ? "var(--color-error)" : meta.color,
                opacity: i === cursor ? 0.6 : 0.15,
                transition: "opacity 0.1s",
              }}
            />
          )
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 h-full w-0.5 bg-text z-10"
          style={{ left: `${cursorPct}%`, transition: "left 0.1s ease-out" }}
        />
      </div>

      {/* Progress bar */}
      <div className="h-0.5 rounded-full bg-elevated/30 mt-1 overflow-hidden">
        <div
          className="h-full bg-accent/50 rounded-full"
          style={{ width: `${cursorPct}%`, transition: "width 0.1s ease-out" }}
        />
      </div>
    </div>
  )
}

// ── Event detail panel ───────────────────────────────────────────

function EventDetail({
  entry,
  violation,
}: {
  entry: TrajectoryEntry
  violation: Violation | null
}) {
  const { event, timestamp, seq } = entry
  const meta = EVENT_META[event.kind] ?? EVENT_META["error"]
  const time = timestamp.split("T")[1]?.split(".")[0] ?? ""

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: meta.color }}
        />
        <span className="text-sm font-semibold" style={{ color: meta.color }}>
          {meta.label}
        </span>
        <span className="text-[12px] text-text-muted font-mono">
          #{seq}
        </span>
        <span className="text-[12px] text-text-muted font-mono ml-auto">
          {time}
        </span>
      </div>

      {/* Violation warning */}
      {violation && (
        <div className="flex items-start gap-2 bg-error/10 text-error text-[13px] px-3 py-2 rounded-lg">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-medium">Transition violation: </span>
            <span className="text-error/80">
              {violation.from} → {violation.to} — {violation.message}
            </span>
          </div>
        </div>
      )}

      {/* Content per event type */}
      <EventContent event={event} />
    </div>
  )
}

function EventContent({ event }: { event: TrajectoryEvent }) {
  switch (event.kind) {
    case "goal":
      return <ContentBlock label="Goal" text={event.text as string} />

    case "thinking":
      return <ContentBlock label="Reasoning" text={event.text as string} mono={false} />

    case "tool-call":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-text-muted">Tool:</span>
            <span className="text-sm font-mono font-medium text-warning">{String(event.tool)}</span>
          </div>
          {event.argsSummary ? (
            <div className="text-[13px] text-text-muted font-mono">{String(event.argsSummary)}</div>
          ) : null}
          {event.argsFormatted ? (
            <pre className="text-[13px] font-mono text-text-secondary bg-base rounded-lg p-3 max-h-48 overflow-auto whitespace-pre-wrap">
              {String(event.argsFormatted)}
            </pre>
          ) : null}
        </div>
      )

    case "tool-result":
      return <ContentBlock label="Result" text={event.text as string} mono />

    case "tool-error":
      return <ContentBlock label="Error" text={event.text as string} mono error />

    case "iteration":
      return (
        <div className="text-[13px] text-text-muted font-mono">
          Iteration {String(event.current)}/{String(event.max)}
        </div>
      )

    case "delegation-start":
      return (
        <div className="space-y-1">
          <ContentBlock label="Delegating" text={(event.childGoal ?? event.goal ?? "") as string} />
          {event.childRunId ? (
            <div className="text-[12px] text-text-muted font-mono">
              Child run: {String(event.childRunId)}
            </div>
          ) : null}
        </div>
      )

    case "delegation-end":
      return <ContentBlock label="Delegation result" text={(event.result ?? event.answer ?? "") as string} />

    case "answer":
      return (
        <div className="space-y-1">
          <div className="text-[13px] text-success font-semibold">Final Answer</div>
          <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
            {String(event.text)}
          </div>
        </div>
      )

    case "error":
      return <ContentBlock label="Fatal Error" text={String(event.text)} error />

    default:
      return (
        <pre className="text-[13px] font-mono text-text-muted bg-base rounded-lg p-3 max-h-48 overflow-auto">
          {JSON.stringify(event, null, 2)}
        </pre>
      )
  }
}

function ContentBlock({
  label,
  text,
  mono,
  error: isError,
}: {
  label: string
  text: string
  mono?: boolean
  error?: boolean
}) {
  return (
    <div className="space-y-1">
      <div className={`text-[13px] font-medium ${isError ? "text-error" : "text-text-muted"}`}>
        {label}
      </div>
      <div
        className={`text-sm whitespace-pre-wrap leading-relaxed max-h-64 overflow-auto ${
          mono
            ? "font-mono text-[13px] bg-base rounded-lg p-3"
            : ""
        } ${isError ? "text-error/80" : "text-text-secondary"}`}
      >
        {text}
      </div>
    </div>
  )
}

// ── Scorecard panel ──────────────────────────────────────────────

function ScorecardPanel({ scorecard }: { scorecard: Scorecard }) {
  return (
    <div className="px-2 py-3 border-b border-elevated/50 space-y-2">
      {/* Metrics grid */}
      <div className="grid grid-cols-4 gap-2">
        <Metric label="Events" value={scorecard.totalEvents} />
        <Metric label="Tool calls" value={scorecard.toolCalls} />
        <Metric label="Errors" value={scorecard.toolErrors} accent={scorecard.toolErrors > 0 ? "error" : undefined} />
        <Metric label="Iterations" value={scorecard.iterations} />
        <Metric label="Err rate" value={`${Math.round(scorecard.errorRate * 100)}%`} accent={scorecard.errorRate > 0.2 ? "error" : undefined} />
        <Metric label="Evt/iter" value={scorecard.eventsPerIteration.toFixed(1)} />
        <Metric label="Think/act" value={scorecard.thinkToActRatio === Infinity ? "∞" : scorecard.thinkToActRatio.toFixed(1)} />
        <Metric label="Delegates" value={scorecard.delegations} />
      </div>

      {/* Patterns */}
      {scorecard.patterns.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-text-muted">Patterns:</span>
          {scorecard.patterns.map((p) => (
            <span
              key={p}
              className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${
                p === "retry-loop"
                  ? "bg-error/10 text-error"
                  : p === "efficient"
                    ? "bg-success/10 text-success"
                    : "bg-accent/10 text-accent"
              }`}
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {/* Tools used */}
      {scorecard.toolsUsed.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-text-muted">Tools:</span>
          {scorecard.toolsUsed.map((t) => (
            <span
              key={t}
              className="text-[11px] px-1.5 py-0.5 rounded bg-elevated text-text-secondary font-mono"
            >
              {t}
              <span className="text-text-muted ml-1">×{scorecard.toolFrequency[t]}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string
  value: string | number
  accent?: "error" | "success"
}) {
  return (
    <div className="text-center">
      <div className={`text-sm font-semibold font-mono tabular-nums ${
        accent === "error" ? "text-error" : accent === "success" ? "text-success" : "text-text"
      }`}>
        {value}
      </div>
      <div className="text-[11px] text-text-muted">{label}</div>
    </div>
  )
}

// ── Run picker dropdown ──────────────────────────────────────────

function RunPicker({
  runs,
  selectedId,
  onSelect,
  onClose,
}: {
  runs: Run[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 w-72 max-h-64 overflow-y-auto bg-surface border border-border rounded-xl shadow-xl z-50"
    >
      {runs.length === 0 && (
        <div className="px-3 py-4 text-[13px] text-text-muted text-center">
          No completed runs
        </div>
      )}
      {runs.map((run) => (
        <button
          key={run.id}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
            run.id === selectedId
              ? "bg-elevated"
              : "hover:bg-elevated/40"
          }`}
          onClick={() => onSelect(run.id)}
        >
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              background: run.status === "completed" ? "var(--color-success)" : "var(--color-error)",
            }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-text truncate">{truncate(run.goal, 40)}</div>
            <div className="text-[11px] text-text-muted">
              {timeAgo(run.createdAt)} · {run.stepCount} steps
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────

/** Short preview text for the event list sidebar. */
function eventPreview(event: TrajectoryEvent): string {
  switch (event.kind) {
    case "goal": return truncStr(event.text as string, 20)
    case "thinking": return truncStr(event.text as string, 20)
    case "tool-call": return event.tool as string
    case "tool-result": return truncStr(event.text as string, 20)
    case "tool-error": return truncStr(event.text as string, 20)
    case "iteration": return `${event.current}/${event.max}`
    case "delegation-start": return truncStr((event.childGoal ?? event.goal ?? "") as string, 20)
    case "delegation-end": return truncStr((event.result ?? "") as string, 20)
    case "answer": return truncStr(event.text as string, 20)
    case "error": return truncStr(event.text as string, 20)
    default: return ""
  }
}

function truncStr(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + "…" : s
}

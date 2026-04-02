/**
 * OperatorEnvironment — Integrated Operator Environment (IOE).
 *
 * VS Code-inspired single-pane-of-glass for the entire agent platform.
 * All data, all controls, fully customizable layout with resizable panels.
 *
 * Layout (IDE-style):
 *   ┌─────────┬──────────────────────────┬──────────┐
 *   │ Activity │     Editor Area          │  Side    │
 *   │  Bar     │  (tabbed main content)   │  Panel   │
 *   │ (icons)  │                          │          │
 *   │         ├──────────────────────────┤          │
 *   │         │     Bottom Panel          │          │
 *   │         │  (logs / audit / feed)    │          │
 *   ├─────────┴──────────────────────────┴──────────┤
 *   │              Status Bar                        │
 *   └────────────────────────────────────────────────┘
 *
 * Panels:
 *   - Activity Bar: icon rail to switch sidebar sections
 *   - Sidebar (left/right, collapsible): Explorer, Runs, Agents, Tools, Notifications
 *   - Editor Area: tabbed panels — Trace, DAG, Timeline, Viz
 *   - Bottom Panel: Logs, Audit, Feed, Problems
 *   - Status Bar: run state, connection, usage, provider/model
 */

import {
    AlertTriangle,
    Bell,
    Bot,
    ChevronDown,
    ChevronRight,
    CircleDot,
    FolderTree,
    History,
    type LucideIcon,
    PanelBottom,
    PanelLeft,
    PanelRight,
    Search,
    Settings,
    Terminal,
} from "lucide-react"
import {
    Fragment,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react"
import { api } from "../api"
import { useStore } from "../store"
import type {
    AgentDefinition,
    AuditEntry,
    LogEntry,
    PolicyRule,
    Run,
    Step,
    ToolInfo,
    TraceEntry,
} from "../types"
import { fmtTokens, timeAgo, truncate } from "../util"

// ═══════════════════════════════════════════════════════════════════
//  Design tokens — matches the app CSS custom properties
// ═══════════════════════════════════════════════════════════════════

const C = {
  base: "#09090b",
  surface: "#121214",
  elevated: "#1c1c1f",
  border: "rgba(255,255,255,0.08)",
  borderSolid: "#27272a",
  text: "#f4f4f5",
  textSecondary: "#d4d4d8",
  muted: "#a1a1aa",
  dim: "#52525b",
  accent: "#7B6FC7",
  accentHover: "#9189D4",
  success: "#5db078",
  warning: "#d4a64a",
  error: "#c95a4a",
  coral: "#EA6248",
  peach: "#F49D6C",
  plum: "#825776",
  cyan: "#6CB4EE",
}

// ═══════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════

type SidebarSection = "explorer" | "runs" | "agents" | "notifications" | "search"
type EditorTab = "trace" | "dag" | "timeline" | "details"
type BottomTab = "output" | "audit" | "feed" | "problems"
type PanelSide = "left" | "right"

interface LlmConfig {
  provider: string
  model: string
  hasApiKey: boolean
  baseUrl: string
}
interface UsageData {
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number; runCount: number }
}
interface HealthData { status: string; active: number }

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function ts(date: string): string {
  return new Date(date).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function dur(start: string | null, end: string | null): string {
  if (!start) return ""
  const s = new Date(start).getTime()
  const e = end ? new Date(end).getTime() : Date.now()
  const ms = e - s
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusDot(status: string): string {
  switch (status) {
    case "completed": return C.success
    case "failed": return C.error
    case "running": case "pending": case "planning": return C.accent
    case "cancelled": return C.warning
    default: return C.dim
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Resizable split hook
// ═══════════════════════════════════════════════════════════════════

function useResizable(initial: number, min: number, max: number, direction: "horizontal" | "vertical") {
  const [size, setSize] = useState(initial)
  const dragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startPos.current = direction === "horizontal" ? e.clientX : e.clientY
    startSize.current = size

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = (direction === "horizontal" ? ev.clientX : ev.clientY) - startPos.current
      setSize(Math.max(min, Math.min(max, startSize.current + delta)))
    }
    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }, [size, min, max, direction])

  return { size, onMouseDown, setSize }
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function OperatorEnvironment() {
  // ── Store ─────────────────────────────────────────────────────
  const connected = useStore((s) => s.connected)
  const runs = useStore((s) => s.runs) ?? []
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const steps = useStore((s) => s.steps)
  const logs = useStore((s) => s.logs)
  const audit = useStore((s) => s.audit)
  const trace = useStore((s) => s.trace)
  const liveUsage = useStore((s) => s.liveUsage)
  const notifications = useStore((s) => s.notifications)
  const unreadCount = useStore((s) => s.unreadCount)
  const markNotificationRead = useStore((s) => s.markNotificationRead)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setTrace = useStore((s) => s.setTrace)

  // ── API data ──────────────────────────────────────────────────
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [policies, setPolicies] = useState<PolicyRule[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [llm, setLlm] = useState<LlmConfig | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)

  // ── Layout state ──────────────────────────────────────────────
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("explorer")
  const [sidebarSide, setSidebarSide] = useState<PanelSide>("left")
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [bottomVisible, setBottomVisible] = useState(true)
  const [editorTab, setEditorTab] = useState<EditorTab>("trace")
  const [bottomTab, setBottomTab] = useState<BottomTab>("output")

  // ── Resizable panels ──────────────────────────────────────────
  const sidebar = useResizable(240, 160, 480, "horizontal")
  const bottom = useResizable(200, 100, 500, "vertical")

  // ── Operational state ─────────────────────────────────────────
  const [goalInput, setGoalInput] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null)
  const [expandedDag, setExpandedDag] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // ── Fetch system data ─────────────────────────────────────────
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
    api.listTools().then(setTools).catch(() => {})
    api.listPolicies().then(setPolicies).catch(() => {})
    api.getUsage().then(setUsage).catch(() => {})
    api.getLlmConfig().then(setLlm).catch(() => {})
    api.health().then(setHealth).catch(() => {})
  }, [runs.length])

  // ── Auto-scroll logs ──────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs.length])

  // ── Derived data ──────────────────────────────────────────────
  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === "running"
  const isFailed = activeRun?.status === "failed"

  const currentIteration = useMemo(() => {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].kind === "iteration") return trace[i] as Extract<TraceEntry, { kind: "iteration" }>
    }
    return null
  }, [trace])

  const toolStats = useMemo(() => {
    const stats = new Map<string, { calls: number; errors: number; totalMs: number }>()
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      const existing = stats.get(s.name) ?? { calls: 0, errors: 0, totalMs: 0 }
      existing.calls++
      if (s.status === "failed") existing.errors++
      if (s.startedAt && s.completedAt) {
        existing.totalMs += new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
      }
      stats.set(s.name, existing)
    }
    return stats
  }, [steps])

  // DAG: build from trace
  const dagNodes = useMemo(() => {
    const nodes: Array<{
      id: string; type: string; label: string; detail: string
      expanded: string; status: string; depth: number; resultText?: string
    }> = []
    let iterIdx = 0
    let lastToolId: string | null = null
    let delegationDepth = 0

    for (let i = 0; i < trace.length; i++) {
      const e = trace[i]
      if (e.kind === "delegation-start") {
        nodes.push({
          id: `deleg-${i}`, type: "iteration", label: `D${e.depth}`,
          detail: `${e.goal.slice(0, 80)}${e.agentName ? ` [${e.agentName}]` : ""}`,
          expanded: `Delegated sub-task (depth ${e.depth})\nGoal: ${e.goal}\nTools: ${e.tools.join(", ")}`,
          status: "running", depth: delegationDepth + 1,
        })
        delegationDepth++
        continue
      }
      if (e.kind === "delegation-end") {
        for (let j = nodes.length - 1; j >= 0; j--) {
          if (nodes[j].id.startsWith("deleg-") && nodes[j].status === "running") {
            nodes[j].status = e.status === "done" ? "done" : "error"
            nodes[j].resultText = e.answer ?? e.error
            break
          }
        }
        delegationDepth = Math.max(0, delegationDepth - 1)
        continue
      }
      if (e.kind === "delegation-iteration") continue

      if (e.kind === "iteration") {
        iterIdx++
        let status = "running"
        let hasError = false, hasDone = false
        for (let j = i + 1; j < trace.length; j++) {
          if (trace[j].kind === "iteration") break
          if (trace[j].kind === "tool-error" || trace[j].kind === "error") hasError = true
          if (trace[j].kind === "tool-result" || trace[j].kind === "answer") hasDone = true
        }
        const nextIter = trace.findIndex((t, idx) => idx > i && t.kind === "iteration")
        if (nextIter !== -1) status = hasDone ? "done" : hasError ? "error" : "done"
        else if (hasError && hasDone) status = "partial"
        else if (hasError) status = "error"
        else if (hasDone) status = "done"

        nodes.push({
          id: `iter-${iterIdx}`, type: "iteration", label: `${iterIdx}A`,
          detail: `iteration ${e.current}/${e.max}`,
          expanded: `Iteration ${e.current} of ${e.max}`,
          status, depth: delegationDepth,
        })
      } else if (e.kind === "tool-call") {
        lastToolId = `tc-${i}`
        nodes.push({
          id: lastToolId, type: "tool-call",
          label: `${nodes.filter(n => n.type === "tool-call").length + 1}T`,
          detail: `${e.tool}(${e.argsSummary || "..."})`,
          expanded: `tool: ${e.tool}\n${e.argsFormatted}`,
          status: "running", depth: delegationDepth + 1,
        })
      } else if (e.kind === "tool-result" && lastToolId) {
        const tc = nodes.find(n => n.id === lastToolId)
        if (tc) { tc.status = "done"; tc.resultText = e.text }
        lastToolId = null
      } else if (e.kind === "tool-error" && lastToolId) {
        const tc = nodes.find(n => n.id === lastToolId)
        if (tc) { tc.status = "error"; tc.resultText = e.text }
        lastToolId = null
      } else if (e.kind === "thinking") {
        nodes.push({
          id: `think-${i}`, type: "thinking", label: "T",
          detail: e.text.slice(0, 80), expanded: e.text.slice(0, 800),
          status: "done", depth: delegationDepth + 1,
        })
      } else if (e.kind === "answer") {
        nodes.push({
          id: `ans-${i}`, type: "answer", label: "R",
          detail: e.text.slice(0, 80), expanded: e.text.slice(0, 800),
          status: "done", depth: delegationDepth + 1,
        })
      }
    }
    return nodes
  }, [trace])

  // Feed items from trace
  const feedItems = useMemo(() => {
    const items: Array<{ text: string; color: string }> = []
    for (let i = Math.max(0, trace.length - 50); i < trace.length; i++) {
      const e = trace[i]
      if (e.kind === "tool-call") items.push({ text: `CALL ${e.tool}(${e.argsSummary || "..."})`, color: C.warning })
      else if (e.kind === "tool-result") items.push({ text: `RET  ${e.text.slice(0, 120)}`, color: C.success })
      else if (e.kind === "tool-error") items.push({ text: `ERR  ${e.text.slice(0, 120)}`, color: C.coral })
      else if (e.kind === "thinking") items.push({ text: `THINK ${e.text.slice(0, 80)}`, color: C.accent })
      else if (e.kind === "answer") items.push({ text: `ANS  ${e.text.slice(0, 120)}`, color: C.success })
      else if (e.kind === "iteration") items.push({ text: `ITER ${e.current}/${e.max}`, color: C.dim })
      else if (e.kind === "goal") items.push({ text: `GOAL ${(e.text ?? "").slice(0, 100)}`, color: C.accent })
      else if (e.kind === "delegation-start") items.push({ text: `DELEG ▶ ${e.agentName ? `[${e.agentName}] ` : ""}${e.goal.slice(0, 80)}`, color: C.plum })
      else if (e.kind === "delegation-end") items.push({ text: `DELEG ◀ ${e.status}`, color: e.status === "done" ? C.success : C.coral })
    }
    return items
  }, [trace])

  // Problems: errors from trace + failed steps
  const problems = useMemo(() => {
    const items: Array<{ text: string; source: string; time?: string }> = []
    for (const e of trace) {
      if (e.kind === "error") items.push({ text: e.text, source: "run" })
      else if (e.kind === "tool-error") items.push({ text: e.text.slice(0, 200), source: "tool" })
    }
    for (const s of steps) {
      if (s.status === "failed" && s.error) items.push({ text: s.error, source: s.name, time: s.completedAt ?? undefined })
    }
    return items
  }, [trace, steps])

  // Search filter
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null
    const q = searchQuery.toLowerCase()
    const results: Array<{ type: string; text: string; detail?: string }> = []
    for (const r of runs) {
      if (r.goal.toLowerCase().includes(q)) results.push({ type: "run", text: r.goal, detail: r.id.slice(0, 8) })
    }
    for (const e of trace) {
      if (e.kind === "tool-call" && (e.tool.toLowerCase().includes(q) || e.argsSummary.toLowerCase().includes(q))) {
        results.push({ type: "trace", text: `${e.tool}(${e.argsSummary})` })
      }
      if (e.kind === "thinking" && e.text.toLowerCase().includes(q)) {
        results.push({ type: "trace", text: truncate(e.text, 100) })
      }
    }
    for (const a of audit) {
      if (a.action.toLowerCase().includes(q) || a.actor.toLowerCase().includes(q)) {
        results.push({ type: "audit", text: `${a.actor}: ${a.action}`, detail: ts(a.timestamp) })
      }
    }
    return results.slice(0, 50)
  }, [searchQuery, runs, trace, audit])

  // ── Actions ───────────────────────────────────────────────────
  const handleSubmitGoal = useCallback(async () => {
    const goal = goalInput.trim()
    if (!goal || submitting) return
    setSubmitting(true)
    try {
      const agentId = selectedAgentId ?? agents[0]?.id
      const { runId } = await api.startRun(goal, agentId || undefined)
      setActiveRun(runId)
      setGoalInput("")
    } catch { /* swallow */ }
    setSubmitting(false)
  }, [goalInput, submitting, selectedAgentId, agents, setActiveRun])

  const handleCancel = useCallback(async () => {
    if (activeRun) await api.cancelRun(activeRun.id).catch(() => {})
  }, [activeRun])

  const handleResume = useCallback(async () => {
    if (!activeRun) return
    try {
      const { runId } = await api.resumeRun(activeRun.id)
      if (runId) { setTrace([]); setActiveRun(runId) }
    } catch { /* swallow */ }
  }, [activeRun, setActiveRun, setTrace])

  const handleRollback = useCallback(async () => {
    if (!activeRun) return
    setRollbackMsg(null)
    try {
      const preview = await api.previewRollback(activeRun.id)
      if (preview.wouldCompensate.length === 0) { setRollbackMsg("nothing to rollback"); return }
      if (preview.wouldFail.length > 0) { setRollbackMsg(`blocked: ${preview.wouldFail[0].reason}`); return }
      const result = await api.rollbackRun(activeRun.id)
      setRollbackMsg(`rolled back ${result.compensated} effects`)
    } catch { setRollbackMsg("rollback failed") }
  }, [activeRun])

  // ── Activity bar items ────────────────────────────────────────
  const activityItems: Array<{ id: SidebarSection; Icon: LucideIcon; label: string; badge?: number }> = [
    { id: "explorer", Icon: FolderTree, label: "Explorer" },
    { id: "runs", Icon: History, label: "Run History" },
    { id: "agents", Icon: Bot, label: "Agents & Tools" },
    { id: "notifications", Icon: Bell, label: "Notifications", badge: unreadCount },
    { id: "search", Icon: Search, label: "Search" },
  ]

  // ═════════════════════════════════════════════════════════════════
  //  RENDER
  // ═════════════════════════════════════════════════════════════════

  const sidebarContent = sidebarVisible ? (
    <div
      className="flex flex-col h-full overflow-hidden shrink-0"
      style={{ width: sidebar.size, borderRight: sidebarSide === "left" ? `1px solid ${C.borderSolid}` : undefined, borderLeft: sidebarSide === "right" ? `1px solid ${C.borderSolid}` : undefined, background: C.surface }}
    >
      {/* Section header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 text-[11px] uppercase tracking-wider shrink-0 select-none"
        style={{ color: C.muted, borderBottom: `1px solid ${C.border}` }}
      >
        <span>{sidebarSection}</span>
        <button
          className="p-0.5 rounded hover:bg-white/5 transition-colors"
          style={{ color: C.muted }}
          onClick={() => setSidebarSide(s => s === "left" ? "right" : "left")}
          title={`Move to ${sidebarSide === "left" ? "right" : "left"}`}
        >
          {sidebarSide === "left" ? <PanelRight size={13} /> : <PanelLeft size={13} />}
        </button>
      </div>

      {/* Section content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {sidebarSection === "explorer" && <ExplorerPanel run={activeRun} agents={agents} tools={tools} policies={policies} llm={llm} health={health} usage={usage} />}
        {sidebarSection === "runs" && <RunsPanel runs={runs} activeRunId={activeRunId} onSelect={setActiveRun} />}
        {sidebarSection === "agents" && <AgentsToolsPanel agents={agents} tools={tools} policies={policies} />}
        {sidebarSection === "notifications" && <NotificationsPanel notifications={notifications} onRead={markNotificationRead} />}
        {sidebarSection === "search" && (
          <div className="p-2">
            <input
              className="w-full px-2 py-1.5 rounded text-xs outline-none"
              style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}` }}
              placeholder="Search runs, trace, audit..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchResults && (
              <div className="mt-2 flex flex-col gap-0.5">
                {searchResults.length === 0 && <div className="text-xs px-1" style={{ color: C.muted }}>No results</div>}
                {searchResults.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-white/5 cursor-default" style={{ color: C.textSecondary }}>
                    <span className="text-[10px] uppercase shrink-0 w-8" style={{ color: C.dim }}>{r.type}</span>
                    <span className="truncate">{r.text}</span>
                    {r.detail && <span className="ml-auto shrink-0 text-[10px]" style={{ color: C.dim }}>{r.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  ) : null

  const sidebarResize = sidebarVisible ? (
    <div
      className="w-1 cursor-col-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
      onMouseDown={sidebar.onMouseDown}
    />
  ) : null

  return (
    <div className="flex flex-col h-full overflow-hidden select-none" style={{ background: C.base, color: C.text, fontFamily: "var(--font-sans)" }}>

      {/* ── Main body (activity bar + sidebar + editor + bottom) ── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Activity Bar ─────────────────────────────────── */}
        <div
          className="flex flex-col items-center py-1 shrink-0"
          style={{ width: 40, background: C.surface, borderRight: `1px solid ${C.borderSolid}` }}
        >
          {activityItems.map((item) => {
            const active = sidebarVisible && sidebarSection === item.id
            return (
              <button
                key={item.id}
                className="relative flex items-center justify-center w-10 h-10 transition-colors"
                style={{
                  color: active ? C.text : C.muted,
                  borderLeft: active ? `2px solid ${C.accent}` : "2px solid transparent",
                }}
                onClick={() => {
                  if (sidebarSection === item.id && sidebarVisible) setSidebarVisible(false)
                  else { setSidebarSection(item.id); setSidebarVisible(true) }
                }}
                title={item.label}
              >
                <item.Icon size={18} />
                {item.badge != null && item.badge > 0 && (
                  <span
                    className="absolute top-1 right-1.5 min-w-[14px] h-3.5 rounded-full text-[9px] font-semibold flex items-center justify-center px-1"
                    style={{ background: C.accent, color: C.text }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            )
          })}

          <div className="flex-1" />

          {/* Bottom controls */}
          <button
            className="flex items-center justify-center w-10 h-8 transition-colors"
            style={{ color: bottomVisible ? C.text : C.muted }}
            onClick={() => setBottomVisible(v => !v)}
            title="Toggle bottom panel"
          >
            <PanelBottom size={16} />
          </button>
          <button
            className="flex items-center justify-center w-10 h-8 transition-colors"
            style={{ color: C.muted }}
            onClick={() => setSidebarSide(s => s === "left" ? "right" : "left")}
            title="Switch sidebar side"
          >
            <Settings size={16} />
          </button>
        </div>

        {/* ── Left sidebar ─────────────────────────────────── */}
        {sidebarSide === "left" && sidebarContent}
        {sidebarSide === "left" && sidebarResize}

        {/* ── Editor + Bottom ──────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">

          {/* ── Objective bar ─────────────────────────────── */}
          <div
            className="flex items-center gap-2 px-3 py-1 shrink-0 text-xs"
            style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
          >
            <CircleDot size={12} style={{ color: activeRun ? statusDot(activeRun.status) : C.dim }} />
            <span className="truncate flex-1" style={{ color: activeRun ? C.text : C.muted }}>
              {activeRun ? activeRun.goal : "No active run — submit a goal below"}
            </span>
            {currentIteration && (
              <span className="shrink-0" style={{ color: C.dim }}>
                iter {currentIteration.current}/{currentIteration.max}
              </span>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {isRunning && (
                <ActionBtn label="CANCEL" color={C.coral} onClick={handleCancel} />
              )}
              {isFailed && (
                <ActionBtn label="RESUME" color={C.peach} onClick={handleResume} />
              )}
              {(activeRun?.status === "completed" || isFailed) && (
                <ActionBtn label="ROLLBACK" color={C.warning} onClick={handleRollback} />
              )}
              {rollbackMsg && <span className="text-[10px] ml-1" style={{ color: C.warning }}>{rollbackMsg}</span>}
            </div>
          </div>

          {/* ── Editor tabs ───────────────────────────────── */}
          <EditorTabs current={editorTab} onChange={setEditorTab} trace={trace} dagNodes={dagNodes} steps={steps} />

          {/* ── Editor content ────────────────────────────── */}
          <div className="flex-1 overflow-y-auto min-h-0" style={{ background: C.base }}>
            {editorTab === "trace" && <TracePanel trace={trace} />}
            {editorTab === "dag" && <DagPanel nodes={dagNodes} expanded={expandedDag} onToggle={setExpandedDag} />}
            {editorTab === "timeline" && <TimelinePanel steps={steps} expanded={expandedSteps} onToggle={(id) => setExpandedSteps(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })} />}
            {editorTab === "details" && <DetailsPanel run={activeRun} toolStats={toolStats} liveUsage={liveUsage} usage={usage} />}
          </div>

          {/* ── Bottom panel resize handle ────────────────── */}
          {bottomVisible && (
            <div
              className="h-1 cursor-row-resize shrink-0 hover:bg-accent/30 active:bg-accent/50 transition-colors"
              onMouseDown={bottom.onMouseDown}
            />
          )}

          {/* ── Bottom panel ──────────────────────────────── */}
          {bottomVisible && (
            <div className="shrink-0 flex flex-col" style={{ height: bottom.size, borderTop: `1px solid ${C.borderSolid}` }}>
              {/* Bottom tabs */}
              <div className="flex items-center shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
                {(["output", "audit", "feed", "problems"] as BottomTab[]).map((tab) => (
                  <button
                    key={tab}
                    className="px-3 py-1 text-[11px] uppercase tracking-wide transition-colors"
                    style={{
                      color: bottomTab === tab ? C.text : C.muted,
                      borderBottom: bottomTab === tab ? `1px solid ${C.accent}` : "1px solid transparent",
                    }}
                    onClick={() => setBottomTab(tab)}
                  >
                    {tab}
                    {tab === "problems" && problems.length > 0 && (
                      <span className="ml-1.5 text-[9px] px-1 rounded-full" style={{ background: C.error + "30", color: C.error }}>{problems.length}</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Bottom content */}
              <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 font-mono text-[11px] leading-relaxed">
                {bottomTab === "output" && <OutputPanel logs={logs} />}
                {bottomTab === "audit" && <AuditPanel audit={audit} />}
                {bottomTab === "feed" && (
                  <div ref={feedRef} className="px-3 py-1">
                    {feedItems.length === 0
                      ? <div style={{ color: C.dim }}>Awaiting activity</div>
                      : feedItems.map((item, i) => (
                        <div key={i} className="truncate" style={{ color: item.color }}>{item.text}</div>
                      ))
                    }
                  </div>
                )}
                {bottomTab === "problems" && <ProblemsPanel problems={problems} />}
              </div>
            </div>
          )}

          {/* ── Operator prompt ───────────────────────────── */}
          <div
            className="shrink-0 flex items-center gap-2 px-3 py-1.5"
            style={{ borderTop: `1px solid ${C.borderSolid}`, background: C.surface }}
          >
            {agents.length > 0 && (
              <select
                className="text-[11px] rounded px-1.5 py-1 outline-none cursor-pointer"
                style={{ background: C.elevated, color: C.muted, border: `1px solid ${C.border}` }}
                value={selectedAgentId ?? agents[0]?.id ?? ""}
                onChange={(e) => setSelectedAgent(e.target.value || null)}
              >
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <Terminal size={13} style={{ color: C.dim }} />
            <input
              ref={inputRef}
              type="text"
              className="flex-1 bg-transparent outline-none text-xs"
              style={{ color: C.text, caretColor: C.accent }}
              placeholder={isRunning ? "agent running..." : "enter goal and press Enter"}
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmitGoal() }}
              disabled={isRunning || submitting}
            />
            {liveUsage.totalTokens > 0 && (
              <span className="text-[10px] shrink-0" style={{ color: C.dim }}>
                {fmtK(liveUsage.totalTokens)} tk
              </span>
            )}
          </div>
        </div>

        {/* ── Right sidebar ────────────────────────────────── */}
        {sidebarSide === "right" && sidebarResize}
        {sidebarSide === "right" && sidebarContent}
      </div>

      {/* ── Status Bar ─────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-3 py-0.5 text-[11px] shrink-0"
        style={{ background: isRunning ? C.accent : C.surface, borderTop: `1px solid ${isRunning ? C.accentHover : C.borderSolid}`, color: isRunning ? C.text : C.muted }}
      >
        <span className="flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: connected ? C.success : C.error }} />
          {connected ? "connected" : "offline"}
        </span>
        {activeRun && (
          <>
            <span>{activeRun.status.toUpperCase()}</span>
            <span className="opacity-60">│</span>
          </>
        )}
        {llm && <span>{llm.provider}/{llm.model}</span>}
        {health && <span>sys: {health.status}</span>}
        <span className="opacity-60">│</span>
        <span>tools: {tools.length}</span>
        <span>agents: {agents.length}</span>
        <span>policies: {policies.length}</span>
        {usage && (
          <>
            <span className="opacity-60">│</span>
            <span>{fmtTokens(usage.totals.totalTokens)} tokens total</span>
            <span>{usage.totals.runCount} runs</span>
          </>
        )}
        <div className="flex-1" />
        <span>{runs.length > 0 ? `${runs.filter(r => r.status === "completed").length}✓ ${runs.filter(r => r.status === "failed").length}✗` : ""}</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  Action button helper
// ═══════════════════════════════════════════════════════════════════

function ActionBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors"
      style={{ background: color + "18", color, border: `1px solid ${color}30` }}
      onMouseEnter={(e) => { e.currentTarget.style.background = color + "35" }}
      onMouseLeave={(e) => { e.currentTarget.style.background = color + "18" }}
    >
      {label}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  Editor Tabs
// ═══════════════════════════════════════════════════════════════════

function EditorTabs({ current, onChange, trace, dagNodes, steps }: {
  current: EditorTab
  onChange: (tab: EditorTab) => void
  trace: TraceEntry[]
  dagNodes: Array<{ id: string }>
  steps: Step[]
}) {
  const tabs: Array<{ id: EditorTab; label: string; count?: number }> = [
    { id: "trace", label: "Trace", count: trace.length },
    { id: "dag", label: "DAG", count: dagNodes.length },
    { id: "timeline", label: "Timeline", count: steps.length },
    { id: "details", label: "Details" },
  ]

  return (
    <div className="flex items-center shrink-0" style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors"
          style={{
            color: current === tab.id ? C.text : C.muted,
            background: current === tab.id ? C.base : "transparent",
            borderBottom: current === tab.id ? `1px solid ${C.accent}` : "1px solid transparent",
            borderRight: `1px solid ${C.border}`,
          }}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count != null && tab.count > 0 && (
            <span className="text-[9px] px-1 rounded" style={{ background: C.elevated, color: C.dim }}>{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  Sidebar panels
// ═══════════════════════════════════════════════════════════════════

// ── Explorer ────────────────────────────────────────────────────

function ExplorerPanel({ run, agents, tools, policies, llm, health, usage }: {
  run: Run | undefined
  agents: AgentDefinition[]
  tools: ToolInfo[]
  policies: PolicyRule[]
  llm: LlmConfig | null
  health: HealthData | null
  usage: UsageData | null
}) {
  return (
    <div className="text-xs">
      <TreeSection title="Active Run" defaultOpen>
        {run ? (
          <>
            <TreeItem label="Status" value={run.status} valueColor={statusDot(run.status)} />
            <TreeItem label="Goal" value={truncate(run.goal, 60)} />
            <TreeItem label="Steps" value={String(run.stepCount)} />
            <TreeItem label="Tokens" value={fmtTokens(run.totalTokens)} />
            <TreeItem label="LLM Calls" value={String(run.llmCalls)} />
            <TreeItem label="Started" value={timeAgo(run.createdAt)} />
            {run.completedAt && <TreeItem label="Duration" value={dur(run.createdAt, run.completedAt)} />}
            {run.answer && <TreeItem label="Answer" value={truncate(run.answer, 80)} />}
            {run.error && <TreeItem label="Error" value={truncate(run.error, 80)} valueColor={C.error} />}
          </>
        ) : (
          <div className="px-4 py-1" style={{ color: C.dim }}>No active run</div>
        )}
      </TreeSection>

      <TreeSection title="System" defaultOpen>
        {llm && (
          <>
            <TreeItem label="Provider" value={llm.provider} />
            <TreeItem label="Model" value={llm.model} />
          </>
        )}
        {health && <TreeItem label="Health" value={health.status} valueColor={health.status === "ok" ? C.success : C.error} />}
        {usage && (
          <>
            <TreeItem label="Total Tokens" value={fmtK(usage.totals.totalTokens)} />
            <TreeItem label="Total Runs" value={String(usage.totals.runCount)} />
            <TreeItem label="LLM Calls" value={String(usage.totals.llmCalls)} />
          </>
        )}
      </TreeSection>

      <TreeSection title={`Agents (${agents.length})`}>
        {agents.map((a) => (
          <TreeItem key={a.id} label={a.name} value={`${a.tools.length} tools`} />
        ))}
      </TreeSection>

      <TreeSection title={`Tools (${tools.length})`}>
        {tools.map((t) => (
          <TreeItem key={t.name} label={t.name} value={truncate(t.description, 40)} />
        ))}
      </TreeSection>

      <TreeSection title={`Policies (${policies.length})`}>
        {policies.map((p) => (
          <TreeItem
            key={p.name}
            label={p.name}
            value={p.effect}
            valueColor={p.effect === "deny" ? C.error : p.effect === "require_approval" ? C.warning : C.success}
          />
        ))}
      </TreeSection>
    </div>
  )
}

// ── Runs ─────────────────────────────────────────────────────────

function RunsPanel({ runs, activeRunId, onSelect }: { runs: Run[]; activeRunId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="text-xs">
      {runs.length === 0 ? (
        <div className="px-4 py-3" style={{ color: C.dim }}>No runs yet</div>
      ) : (
        runs.map((r) => (
          <button
            key={r.id}
            className="w-full text-left flex items-start gap-2 px-3 py-1.5 transition-colors hover:bg-white/[0.03]"
            style={{ background: r.id === activeRunId ? "rgba(123,111,199,0.08)" : "transparent" }}
            onClick={() => onSelect(r.id)}
          >
            <span className="inline-block w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: statusDot(r.status) }} />
            <div className="min-w-0 flex-1">
              <div className="truncate" style={{ color: C.text }}>{truncate(r.goal, 50)}</div>
              <div className="flex items-center gap-2 mt-0.5" style={{ color: C.dim }}>
                <span>{r.status}</span>
                <span>{timeAgo(r.createdAt)}</span>
                {r.stepCount > 0 && <span>{r.stepCount} steps</span>}
                {r.totalTokens > 0 && <span>{fmtTokens(r.totalTokens)} tk</span>}
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  )
}

// ── Agents & Tools ───────────────────────────────────────────────

function AgentsToolsPanel({ agents, tools, policies }: { agents: AgentDefinition[]; tools: ToolInfo[]; policies: PolicyRule[] }) {
  return (
    <div className="text-xs">
      <TreeSection title={`Agents (${agents.length})`} defaultOpen>
        {agents.map((a) => (
          <div key={a.id} className="px-4 py-1">
            <div style={{ color: C.text }}>{a.name}</div>
            <div style={{ color: C.dim }}>{truncate(a.description, 60)}</div>
            <div style={{ color: C.muted }}>tools: {a.tools.join(", ")}</div>
          </div>
        ))}
      </TreeSection>

      <TreeSection title={`Tools (${tools.length})`} defaultOpen>
        {tools.map((t) => (
          <div key={t.name} className="px-4 py-1">
            <div style={{ color: C.accent }}>{t.name}</div>
            <div style={{ color: C.dim }}>{truncate(t.description, 80)}</div>
          </div>
        ))}
      </TreeSection>

      <TreeSection title={`Policies (${policies.length})`}>
        {policies.map((p) => (
          <div key={p.name} className="px-4 py-1 flex items-center gap-2">
            <span style={{ color: p.effect === "deny" ? C.error : p.effect === "require_approval" ? C.warning : C.success }}>
              {p.effect}
            </span>
            <span style={{ color: C.text }}>{p.name}</span>
            <span style={{ color: C.dim }}>({p.condition})</span>
          </div>
        ))}
      </TreeSection>
    </div>
  )
}

// ── Notifications ────────────────────────────────────────────────

function NotificationsPanel({ notifications, onRead }: { notifications: Array<{ id: string; type: string; title: string; message: string; read: boolean; createdAt: string }>; onRead: (id: string) => void }) {
  return (
    <div className="text-xs">
      {notifications.length === 0 ? (
        <div className="px-4 py-3" style={{ color: C.dim }}>No notifications</div>
      ) : (
        notifications.slice(0, 50).map((n) => (
          <div
            key={n.id}
            className="px-3 py-1.5 transition-colors hover:bg-white/[0.03] cursor-default"
            style={{ opacity: n.read ? 0.5 : 1 }}
            onClick={() => { if (!n.read) onRead(n.id) }}
          >
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: n.read ? C.dim : n.type.includes("failed") ? C.error : n.type.includes("approval") ? C.warning : C.accent }} />
              <span className="truncate" style={{ color: C.text }}>{n.title}</span>
              <span className="ml-auto shrink-0 text-[10px]" style={{ color: C.dim }}>{timeAgo(n.createdAt)}</span>
            </div>
            <div className="pl-3.5 truncate mt-0.5" style={{ color: C.muted }}>{n.message}</div>
          </div>
        ))
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  Editor panels
// ═══════════════════════════════════════════════════════════════════

// ── Trace ────────────────────────────────────────────────────────

function TracePanel({ trace }: { trace: TraceEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [trace.length])

  if (trace.length === 0) {
    return <div className="flex items-center justify-center h-full text-xs" style={{ color: C.dim }}>No trace data — start a run</div>
  }

  return (
    <div ref={ref} className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
      {trace.map((e, i) => (
        <TraceRow key={i} entry={e} />
      ))}
    </div>
  )
}

function TraceRow({ entry: e }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false)

  if (e.kind === "goal") {
    return (
      <div className="py-0.5" style={{ color: C.accent }}>
        <span className="text-[10px] uppercase mr-2" style={{ color: C.dim }}>GOAL</span>
        {e.text}
      </div>
    )
  }
  if (e.kind === "iteration") {
    return (
      <div className="py-0.5 mt-1" style={{ color: C.cyan, borderTop: `1px solid ${C.border}` }}>
        ── Iteration {e.current}/{e.max} ──
      </div>
    )
  }
  if (e.kind === "thinking") {
    return (
      <div className="py-0.5 cursor-pointer hover:bg-white/[0.02] rounded" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] mr-2" style={{ color: C.plum }}>THINK</span>
        <span style={{ color: C.muted }}>{expanded ? e.text : truncate(e.text, 120)}</span>
      </div>
    )
  }
  if (e.kind === "tool-call") {
    return (
      <div className="py-0.5 cursor-pointer hover:bg-white/[0.02] rounded" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] mr-2" style={{ color: C.warning }}>CALL</span>
        <span style={{ color: C.text }}>{e.tool}</span>
        <span style={{ color: C.dim }}>({e.argsSummary || "..."})</span>
        {expanded && (
          <pre className="mt-1 ml-4 p-2 rounded text-[10px] overflow-x-auto" style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}>
            {e.argsFormatted}
          </pre>
        )}
      </div>
    )
  }
  if (e.kind === "tool-result") {
    return (
      <div className="py-0.5 cursor-pointer hover:bg-white/[0.02] rounded" onClick={() => setExpanded(!expanded)}>
        <span className="text-[10px] mr-2" style={{ color: C.success }}>RET</span>
        <span style={{ color: C.textSecondary }}>{expanded ? e.text : truncate(e.text, 120)}</span>
      </div>
    )
  }
  if (e.kind === "tool-error") {
    return (
      <div className="py-0.5">
        <span className="text-[10px] mr-2" style={{ color: C.coral }}>ERR</span>
        <span style={{ color: C.coral }}>{truncate(e.text, 200)}</span>
      </div>
    )
  }
  if (e.kind === "answer") {
    return (
      <div className="py-1 mt-1" style={{ borderTop: `1px solid ${C.border}` }}>
        <span className="text-[10px] mr-2" style={{ color: C.success }}>ANSWER</span>
        <span style={{ color: C.text }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "error") {
    return (
      <div className="py-0.5">
        <span className="text-[10px] mr-2" style={{ color: C.coral }}>ERROR</span>
        <span style={{ color: C.coral }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "usage") {
    return (
      <div className="py-0.5" style={{ color: C.dim }}>
        <span className="text-[10px] mr-2">USAGE</span>
        {fmtK(e.totalTokens)} tokens · {e.llmCalls} calls
      </div>
    )
  }
  if (e.kind === "delegation-start") {
    return (
      <div className="py-0.5 mt-0.5" style={{ color: C.plum }}>
        <span className="text-[10px] mr-2">DELEG▶</span>
        {e.agentName ? `[${e.agentName}] ` : ""}{e.goal}
        <span style={{ color: C.dim }}> (depth {e.depth})</span>
      </div>
    )
  }
  if (e.kind === "delegation-end") {
    return (
      <div className="py-0.5" style={{ color: e.status === "done" ? C.success : C.coral }}>
        <span className="text-[10px] mr-2">DELEG◀</span>
        {e.status} {e.answer ? truncate(e.answer, 100) : e.error ? truncate(e.error, 100) : ""}
      </div>
    )
  }
  if (e.kind === "delegation-iteration") {
    return (
      <div className="py-0.5 pl-4" style={{ color: C.dim }}>
        ↳ D{e.depth} iter {e.iteration}/{e.maxIterations}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-start") {
    return (
      <div className="py-0.5" style={{ color: C.plum }}>
        <span className="text-[10px] mr-2">PAR▶</span>
        {e.taskCount} tasks {e.goals.map((g, i) => <Fragment key={i}><br /><span className="pl-6" style={{ color: C.muted }}>• {truncate(g, 80)}</span></Fragment>)}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-end") {
    return (
      <div className="py-0.5" style={{ color: C.plum }}>
        <span className="text-[10px] mr-2">PAR◀</span>
        {e.fulfilled}/{e.taskCount} fulfilled, {e.rejected} rejected
      </div>
    )
  }
  return null
}

// ── DAG ──────────────────────────────────────────────────────────

function DagPanel({ nodes, expanded, onToggle }: {
  nodes: Array<{ id: string; type: string; label: string; detail: string; expanded: string; status: string; depth: number; resultText?: string }>
  expanded: string | null
  onToggle: (id: string | null) => void
}) {
  if (nodes.length === 0) {
    return <div className="flex items-center justify-center h-full text-xs" style={{ color: C.dim }}>No activity yet</div>
  }

  const toolCalls = nodes.filter(n => n.type === "tool-call").length
  const doneCount = nodes.filter(n => n.status === "done").length
  const failCount = nodes.filter(n => n.status === "error").length
  const liveCount = nodes.filter(n => n.status === "running").length

  return (
    <div className="h-full overflow-y-auto px-3 py-2 font-mono text-[11px]">
      {/* Summary */}
      <div className="flex items-center gap-3 mb-2 text-[10px]">
        <span style={{ color: C.success }}>LIVE {liveCount}</span>
        <span style={{ color: C.success }}>DONE {doneCount}</span>
        <span style={{ color: failCount > 0 ? C.coral : C.dim }}>FAIL {failCount}</span>
        <span style={{ color: C.dim }}>TOOLS {toolCalls}</span>
      </div>

      {/* Tree */}
      {nodes.map((node, i) => {
        const isExpanded = expanded === node.id
        const dotColor = node.status === "done" ? C.success : node.status === "error" ? C.coral : node.status === "partial" ? C.peach : C.accent
        const nextNode = nodes[i + 1]
        const isLast = !nextNode || nextNode.depth < node.depth
        const connector = node.depth === 0 ? (i > 0 ? "│" : " ") : (isLast ? "└─" : "├─")

        return (
          <div key={node.id}>
            <div
              className="flex items-center gap-1.5 leading-relaxed cursor-pointer rounded px-1 -mx-1 hover:bg-white/[0.03] transition-colors"
              style={{ paddingLeft: node.depth * 16 }}
              onClick={() => onToggle(isExpanded ? null : node.id)}
            >
              <span className="inline-block w-4 text-right shrink-0" style={{ color: C.dim }}>{connector}</span>
              <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
              <span className="shrink-0 w-5 text-center text-[10px]" style={{ color: node.label.startsWith("D") ? C.cyan : node.depth === 0 ? C.accent : C.muted }}>{node.label}</span>
              <span className="truncate flex-1" style={{ color: C.text }}>{node.detail}</span>
              <span className="shrink-0 text-[10px]" style={{ color: dotColor }}>{node.status === "running" ? "live" : node.status}</span>
            </div>
            {isExpanded && (
              <div
                className="mb-1 px-2 py-1 rounded text-[10px] overflow-auto"
                style={{ marginLeft: node.depth * 16 + 24, background: C.surface, border: `1px solid ${C.border}`, maxHeight: 160 }}
              >
                <pre className="whitespace-pre-wrap m-0" style={{ color: C.muted }}>{node.expanded}</pre>
                {node.resultText && (
                  <div className="mt-1 pt-1" style={{ borderTop: `1px solid ${C.border}`, color: node.status === "error" ? C.coral : C.success }}>
                    {node.resultText.slice(0, 400)}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Timeline ─────────────────────────────────────────────────────

function TimelinePanel({ steps, expanded, onToggle }: {
  steps: Step[]
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  if (steps.length === 0) {
    return <div className="flex items-center justify-center h-full text-xs" style={{ color: C.dim }}>No steps recorded</div>
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2 text-xs">
      {steps.map((step, i) => {
        const isOpen = expanded.has(step.id)
        const dotColor = statusDot(step.status)
        const duration = dur(step.startedAt, step.completedAt)

        return (
          <div key={step.id} className="relative pl-5 pb-2">
            {/* Connecting line */}
            {i < steps.length - 1 && (
              <div className="absolute left-2 top-3.5 bottom-0 w-px" style={{ background: C.borderSolid }} />
            )}
            {/* Dot */}
            <div className="absolute left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: dotColor, background: step.status === "running" ? dotColor : C.base }} />

            <div
              className="cursor-pointer hover:bg-white/[0.02] rounded px-2 py-1 transition-colors"
              onClick={() => onToggle(step.id)}
            >
              {/* Header */}
              <div className="flex items-center gap-2">
                <span style={{ color: C.text }}>{step.name}</span>
                {step.action !== step.name && <span style={{ color: C.dim }}>({step.action})</span>}
                <span className="ml-auto text-[10px]" style={{ color: C.dim }}>
                  {duration}
                </span>
                <span className="text-[10px]" style={{ color: dotColor }}>{step.status}</span>
              </div>
              {step.error && <div className="mt-0.5" style={{ color: C.error }}>{truncate(step.error, 100)}</div>}

              {/* Expanded detail */}
              {isOpen && (
                <div className="mt-1.5 space-y-1">
                  {Object.keys(step.input).length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase" style={{ color: C.dim }}>Input</span>
                      <pre className="mt-0.5 p-2 rounded text-[10px] overflow-x-auto" style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}>
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {Object.keys(step.output).length > 0 && (
                    <div>
                      <span className="text-[10px] uppercase" style={{ color: C.dim }}>Output</span>
                      <pre className="mt-0.5 p-2 rounded text-[10px] overflow-x-auto" style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}>
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Details ──────────────────────────────────────────────────────

function DetailsPanel({ run, toolStats, liveUsage, usage }: {
  run: Run | undefined
  toolStats: Map<string, { calls: number; errors: number; totalMs: number }>
  liveUsage: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number }
  usage: UsageData | null
}) {
  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-xs space-y-4">
      {/* Run usage */}
      <section>
        <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>Run Usage</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          <KV label="Prompt Tokens" value={fmtK(liveUsage.promptTokens)} />
          <KV label="Completion Tokens" value={fmtK(liveUsage.completionTokens)} />
          <KV label="Total Tokens" value={fmtK(liveUsage.totalTokens)} />
          <KV label="LLM Calls" value={String(liveUsage.llmCalls)} />
        </div>
      </section>

      {/* Overall usage */}
      {usage && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>Overall Usage</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <KV label="Total Tokens" value={fmtK(usage.totals.totalTokens)} />
            <KV label="Total Runs" value={String(usage.totals.runCount)} />
            <KV label="LLM Calls" value={String(usage.totals.llmCalls)} />
            <KV label="Prompt Tokens" value={fmtK(usage.totals.promptTokens)} />
          </div>
        </section>
      )}

      {/* Tool stats */}
      {toolStats.size > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>Tool Performance</h3>
          <div className="space-y-1.5">
            {Array.from(toolStats.entries()).map(([name, s]) => {
              const failRate = s.calls > 0 ? s.errors / s.calls : 0
              const avgMs = s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0
              return (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-24 truncate" style={{ color: C.accent }}>{name}</span>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: C.elevated }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, s.calls * 10)}%`, background: failRate > 0.3 ? C.coral : C.success }}
                    />
                  </div>
                  <span className="shrink-0 w-16 text-right" style={{ color: C.muted }}>
                    {s.calls}× {avgMs > 0 ? `${avgMs}ms` : ""}
                  </span>
                  {s.errors > 0 && (
                    <span className="shrink-0 text-[10px]" style={{ color: C.coral }}>{s.errors} err</span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Run metadata */}
      {run && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: C.cyan }}>Run Metadata</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <KV label="Run ID" value={run.id.slice(0, 12)} />
            <KV label="Status" value={run.status} />
            <KV label="Agent" value={run.agentId ?? "default"} />
            <KV label="Created" value={ts(run.createdAt)} />
            {run.completedAt && <KV label="Completed" value={ts(run.completedAt)} />}
            {run.parentRunId && <KV label="Parent Run" value={run.parentRunId.slice(0, 8)} />}
          </div>
        </section>
      )}
    </div>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ color: C.text }}>{value}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  Bottom panels
// ═══════════════════════════════════════════════════════════════════

function OutputPanel({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) {
    return <div className="px-3 py-2" style={{ color: C.dim }}>No output</div>
  }
  return (
    <div className="px-3 py-1">
      {logs.slice(-200).map((log, i) => {
        const levelColor = log.level === "error" ? C.coral : log.level === "warn" ? C.warning : C.muted
        return (
          <div key={i} className="truncate">
            <span style={{ color: C.dim }}>[{ts(log.timestamp)}]</span>{" "}
            <span style={{ color: levelColor, textTransform: "uppercase" }}>{log.level.slice(0, 3)}</span>{" "}
            <span style={{ color: C.textSecondary }}>{log.message}</span>
          </div>
        )
      })}
    </div>
  )
}

function AuditPanel({ audit }: { audit: AuditEntry[] }) {
  if (audit.length === 0) {
    return <div className="px-3 py-2" style={{ color: C.dim }}>No audit entries</div>
  }
  return (
    <div className="px-3 py-1">
      {audit.map((a, i) => {
        const actionColor = a.action.includes("blocked") || a.action.includes("denied") ? C.coral
          : a.action.includes("completed") ? C.success
          : a.action.includes("failed") ? C.warning
          : C.textSecondary
        return (
          <div key={i} className="truncate">
            <span style={{ color: C.dim }}>[{ts(a.timestamp)}]</span>{" "}
            <span style={{ color: C.accent }}>{a.actor}</span>{" "}
            <span style={{ color: actionColor }}>{a.action}</span>
            {Object.keys(a.detail).length > 0 && (
              <span style={{ color: C.dim }}> {JSON.stringify(a.detail).slice(0, 100)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ProblemsPanel({ problems }: { problems: Array<{ text: string; source: string; time?: string }> }) {
  if (problems.length === 0) {
    return <div className="px-3 py-2" style={{ color: C.success }}>No problems detected</div>
  }
  return (
    <div className="px-3 py-1">
      {problems.map((p, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" style={{ color: C.coral }} />
          <span className="text-[10px] shrink-0 uppercase w-12" style={{ color: C.dim }}>{p.source}</span>
          <span className="truncate" style={{ color: C.coral }}>{p.text}</span>
          {p.time && <span className="ml-auto shrink-0" style={{ color: C.dim }}>{ts(p.time)}</span>}
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  Tree helpers (VS Code style collapsible sections)
// ═══════════════════════════════════════════════════════════════════

function TreeSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        className="w-full flex items-center gap-1 px-2 py-1 text-[11px] uppercase tracking-wide hover:bg-white/[0.03] transition-colors font-semibold"
        style={{ color: C.muted }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && children}
    </div>
  )
}

function TreeItem({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-baseline gap-2 px-4 py-0.5 text-[11px]">
      <span style={{ color: C.muted }}>{label}</span>
      <span className="truncate" style={{ color: valueColor ?? C.textSecondary }}>{value}</span>
    </div>
  )
}

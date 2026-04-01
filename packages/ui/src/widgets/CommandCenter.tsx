/**
 * CommandCenter — comprehensive operational dashboard widget.
 *
 * Inspired by agenC's terminal/UI layout: a single pane of glass showing
 * all critical system data with full operational controls.
 *
 * Sections:
 *   1. Status bar — run state, provider, model, queue, runtime, WS
 *   2. Objective + operational controls (cancel, resume, submit goal)
 *   3. LIVE DAG — cascading tree of iterations → tool calls with status
 *   4. Panels row — TOOLS, GUARD, AGENTS
 *   5. Usage bar — token counts, LLM calls
 *   6. Recent alerts + live feed
 *   7. Operator prompt — submit new goals inline
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition, PolicyRule, ToolInfo, TraceEntry } from "../types"

// ── Palette ───────────────────────────────────────────────────────

const C = {
  accent:   "#7B6FC7",
  success:  "#5db078",
  coral:    "#EA6248",
  peach:    "#F49D6C",
  cyan:     "#6CB4EE",
  text:     "#f4f4f5",
  muted:    "#a1a1aa",
  dim:      "#52525b",
  surface:  "#121214",
  base:     "#09090b",
  border:   "rgba(255,255,255,0.08)",
}

// ── Helpers ───────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function ts(date: string): string {
  return new Date(date).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

// ── DAG node types ────────────────────────────────────────────────

interface DagNode {
  id: string
  type: "iteration" | "tool-call" | "tool-result" | "tool-error" | "thinking" | "answer"
  label: string
  detail: string
  expanded: string   // richer text shown when node is clicked
  status: "done" | "error" | "running" | "partial"
  depth: number   // 0 = iteration, 1 = tool call / thinking / answer within iteration
  resultText?: string  // tool-result or tool-error text associated with this call
}

// ── Types for fetched data ────────────────────────────────────────

interface UsageData {
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number; runCount: number }
}

interface LlmConfig {
  provider: string
  model: string
  hasApiKey: boolean
  baseUrl: string
}

interface HealthData {
  status: string
  active: number
}

// ── Component ─────────────────────────────────────────────────────

export function CommandCenter() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const trace = useStore((s) => s.trace)
  const notifications = useStore((s) => s.notifications)
  const unreadCount = useStore((s) => s.unreadCount)
  const connected = useStore((s) => s.connected)
  const liveUsage = useStore((s) => s.liveUsage) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 }
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setActiveRun = useStore((s) => s.setActiveRun)

  // API-fetched data
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [policies, setPolicies] = useState<PolicyRule[]>([])
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [llm, setLlm] = useState<LlmConfig | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)

  const setTrace = useStore((s) => s.setTrace)

  // Operational state
  const [goalInput, setGoalInput] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [expandedDag, setExpandedDag] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const feedRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch data on mount + when runs change
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
    api.listTools().then(setTools).catch(() => {})
    api.listPolicies().then(setPolicies).catch(() => {})
    api.getUsage().then(setUsage).catch(() => {})
    api.getLlmConfig().then(setLlm).catch(() => {})
    api.health().then(setHealth).catch(() => {})
  }, [runs.length])

  // Auto-scroll feed
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [trace.length])

  // Derived data
  const activeRun = runs.find((r) => r.id === activeRunId)
  const runningRuns = runs.filter((r) => r.status === "running")
  const queuedRuns = runs.filter((r) => r.status === "pending" || r.status === "planning")
  const completedRuns = runs.filter((r) => r.status === "completed")
  const failedRuns = runs.filter((r) => r.status === "failed")
  const isRunning = activeRun?.status === "running"
  const isFailed = activeRun?.status === "failed"

  const activeAgent = activeRun?.agentId ? agents.find((a) => a.id === activeRun.agentId) : null

  // ── Operational actions ─────────────────────────────────────────

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
    setResumeError(null)
    try {
      const { runId } = await api.resumeRun(activeRun.id)
      if (runId) {
        setTrace([])  // clear stale trace so new run starts fresh
        setActiveRun(runId)
      } else {
        setResumeError("no checkpoint")
      }
    } catch {
      setResumeError("resume failed — no checkpoint available")
    }
  }, [activeRun, setActiveRun, setTrace])

  // ── LIVE DAG ────────────────────────────────────────────────────

  const dagNodes = useMemo(() => {
    const nodes: DagNode[] = []
    let iterIdx = 0
    let lastToolId: string | null = null
    let delegationDepth = 0  // tracks nesting from delegation-start/end

    for (let i = 0; i < trace.length; i++) {
      const e = trace[i]

      // Delegation nesting
      if (e.kind === "delegation-start") {
        const agentLabel = e.agentName ? ` [${e.agentName}]` : ""
        nodes.push({
          id: `deleg-${i}`,
          type: "iteration",
          label: `D${e.depth}`,
          detail: `${e.goal.slice(0, 80)}${agentLabel}`,
          expanded: `Delegated sub-task (depth ${e.depth})${e.agentName ? `\nAgent: ${e.agentName} (${e.agentId})` : ""}\nGoal: ${e.goal}\nTools: ${e.tools.join(", ")}`,
          status: "running",
          depth: delegationDepth + 1,
        })
        delegationDepth++
        continue
      }
      if (e.kind === "delegation-end") {
        // Find the matching delegation-start node and update its status
        for (let j = nodes.length - 1; j >= 0; j--) {
          if (nodes[j].id.startsWith("deleg-") && nodes[j].status === "running") {
            nodes[j].status = e.status === "done" ? "done" : "error"
            nodes[j].resultText = e.answer ?? e.error
            nodes[j].expanded += `\n\n${e.status === "done" ? "result" : "error"}:\n${(e.answer ?? e.error ?? "").slice(0, 500)}`
            break
          }
        }
        delegationDepth = Math.max(0, delegationDepth - 1)
        continue
      }
      if (e.kind === "delegation-iteration") {
        // Silent — delegation iterations don't need their own DAG nodes
        continue
      }

      if (e.kind === "iteration") {
        iterIdx++
        // Look ahead to determine iteration status
        let status: DagNode["status"] = "running"
        let hasError = false
        let hasDone = false
        for (let j = i + 1; j < trace.length; j++) {
          if (trace[j].kind === "iteration") break
          if (trace[j].kind === "tool-error" || trace[j].kind === "error") hasError = true
          if (trace[j].kind === "tool-result" || trace[j].kind === "answer") hasDone = true
        }
        if (hasError && hasDone) status = "partial"
        else if (hasError) status = "error"
        else if (hasDone) status = "done"
        // If this is NOT the last iteration, it's done
        const nextIter = trace.findIndex((t, idx) => idx > i && t.kind === "iteration")
        if (nextIter !== -1) status = hasDone ? "done" : hasError ? "error" : "done"

        nodes.push({
          id: `iter-${iterIdx}`,
          type: "iteration",
          label: `${iterIdx}A`,
          detail: `iteration ${e.current}/${e.max}`,
          expanded: `Iteration ${e.current} of ${e.max}\nStatus: ${status}`,
          status,
          depth: delegationDepth,
        })
      } else if (e.kind === "tool-call") {
        lastToolId = `tc-${i}`
        nodes.push({
          id: lastToolId,
          type: "tool-call",
          label: `${nodes.filter(n => n.type === "tool-call").length + 1}T`,
          detail: `${e.tool}(${e.argsSummary || "..."})`,
          expanded: `tool: ${e.tool}\nargs:\n${e.argsFormatted}`,
          status: "running",
          depth: delegationDepth + 1,
        })
      } else if (e.kind === "tool-result") {
        if (lastToolId) {
          const tc = nodes.find(n => n.id === lastToolId)
          if (tc) {
            tc.status = "done"
            tc.resultText = e.text
            tc.expanded += `\n\nresult:\n${e.text.slice(0, 500)}`
          }
        }
        lastToolId = null
      } else if (e.kind === "tool-error") {
        if (lastToolId) {
          const tc = nodes.find(n => n.id === lastToolId)
          if (tc) {
            tc.status = "error"
            tc.resultText = e.text
            tc.expanded += `\n\nerror:\n${e.text.slice(0, 500)}`
          }
        }
        lastToolId = null
      } else if (e.kind === "thinking") {
        nodes.push({
          id: `think-${i}`,
          type: "thinking",
          label: "T",
          detail: e.text.slice(0, 80),
          expanded: e.text.slice(0, 800),
          status: "done",
          depth: delegationDepth + 1,
        })
      } else if (e.kind === "answer") {
        nodes.push({
          id: `ans-${i}`,
          type: "answer",
          label: "R",
          detail: e.text.slice(0, 80),
          expanded: e.text.slice(0, 800),
          status: "done",
          depth: delegationDepth + 1,
        })
      }
    }
    return nodes
  }, [trace])

  const dagToolCallCount = dagNodes.filter(n => n.type === "tool-call").length
  const dagDoneCount = dagNodes.filter(n => n.status === "done").length
  const dagFailCount = dagNodes.filter(n => n.status === "error").length
  const dagLiveCount = dagNodes.filter(n => n.status === "running").length

  // Tool stats from trace
  const toolActivity = useMemo(() => {
    const stats = new Map<string, { calls: number; errors: number }>()
    for (const e of trace) {
      if (e.kind === "tool-call") {
        const s = stats.get(e.tool) ?? { calls: 0, errors: 0 }
        s.calls++
        stats.set(e.tool, s)
      } else if (e.kind === "tool-error") {
        for (let i = trace.indexOf(e) - 1; i >= 0; i--) {
          if (trace[i].kind === "tool-call") {
            const t = (trace[i] as Extract<TraceEntry, { kind: "tool-call" }>).tool
            const s = stats.get(t)
            if (s) s.errors++
            break
          }
        }
      }
    }
    return stats
  }, [trace])

  const totalToolCalls = useMemo(() => {
    let n = 0
    toolActivity.forEach((s) => n += s.calls)
    return n
  }, [toolActivity])

  const totalToolErrors = useMemo(() => {
    let n = 0
    toolActivity.forEach((s) => n += s.errors)
    return n
  }, [toolActivity])

  const latestTool = useMemo(() => {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].kind === "tool-call") return (trace[i] as Extract<TraceEntry, { kind: "tool-call" }>).tool
    }
    return null
  }, [trace])

  const currentIteration = useMemo(() => {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].kind === "iteration") return (trace[i] as Extract<TraceEntry, { kind: "iteration" }>)
    }
    return null
  }, [trace])

  // Recent alerts
  const recentAlerts = useMemo(() => {
    const alerts: Array<{ text: string; time: string; color: string }> = []
    for (const n of notifications.slice(-5)) {
      if (n.type === "run.failed" || n.type === "approval.required") {
        alerts.push({ text: n.message, time: ts(n.createdAt), color: n.type === "run.failed" ? C.coral : C.peach })
      }
    }
    for (let i = trace.length - 1; i >= 0 && alerts.length < 8; i--) {
      const e = trace[i]
      if (e.kind === "error" || e.kind === "tool-error") {
        alerts.push({ text: e.text.slice(0, 120), time: "", color: C.coral })
      }
    }
    return alerts.slice(0, 5)
  }, [notifications, trace])

  // Feed items
  const feedItems = useMemo(() => {
    const items: Array<{ text: string; color: string }> = []
    for (let i = Math.max(0, trace.length - 30); i < trace.length; i++) {
      const e = trace[i]
      if (e.kind === "tool-call") items.push({ text: `CALL ${e.tool}(${e.argsSummary || "..."})`, color: C.accent })
      else if (e.kind === "tool-result") items.push({ text: `RET  ${e.text.slice(0, 100)}`, color: C.success })
      else if (e.kind === "tool-error") items.push({ text: `ERR  ${e.text.slice(0, 100)}`, color: C.coral })
      else if (e.kind === "thinking") items.push({ text: `THINK ${e.text.slice(0, 80)}`, color: C.peach })
      else if (e.kind === "answer") items.push({ text: `ANS  ${e.text.slice(0, 100)}`, color: C.success })
      else if (e.kind === "iteration") items.push({ text: `ITER ${e.current}/${e.max}`, color: C.dim })
      else if (e.kind === "goal") items.push({ text: `GOAL ${e.text.slice(0, 100)}`, color: C.cyan })
      else if (e.kind === "delegation-start") items.push({ text: `DELEG ▶ ${e.agentName ? `[${e.agentName}] ` : ""}${e.goal.slice(0, 80)} [depth ${e.depth}]`, color: C.cyan })
      else if (e.kind === "delegation-end") items.push({ text: `DELEG ◀ ${e.status} ${(e.answer ?? e.error ?? "").slice(0, 80)}`, color: e.status === "done" ? C.success : C.coral })
    }
    return items
  }, [trace])

  const denyCount = policies.filter((p) => p.effect === "deny").length
  const approvalCount = policies.filter((p) => p.effect === "require_approval").length
  const runtimeLabel = health?.status === "ok" ? "healthy" : health?.status ?? "unknown"
  const runtimeColor = runtimeLabel === "healthy" ? C.success : C.coral
  const runStatus = activeRun?.status ?? "idle"
  const runStatusColor = runStatus === "running" ? C.success : runStatus === "failed" ? C.coral : runStatus === "completed" ? C.accent : C.dim

  return (
    <div className="h-full flex flex-col font-mono text-xs overflow-hidden" style={{ color: C.text, background: C.base }}>

      {/* ── Status bar ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
        <StatusField label="RUN" value={runStatus} color={runStatusColor} />
        {llm && <StatusField label="PROVIDER" value={llm.provider} color={C.accent} />}
        {llm && <StatusField label="MODEL" value={llm.model} color={C.text} />}
        <StatusField label="QUEUE" value={String(queuedRuns.length)} color={queuedRuns.length > 0 ? C.peach : C.dim} />
        <StatusField label="RUNTIME" value={runtimeLabel} color={runtimeColor} />
        <StatusField label="WS" value={connected ? "connected" : "offline"} color={connected ? C.success : C.coral} />
      </div>

      {/* ── Objective + controls ───────────────────────────────── */}
      {activeRun && (
        <div className="flex items-start gap-2 px-3 py-1.5 shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex-1 min-w-0">
            <span style={{ color: C.cyan }}>OBJ </span>
            <span style={{ color: C.text }}>{activeRun.goal.length > 100 ? activeRun.goal.slice(0, 97) + "..." : activeRun.goal}</span>
            {currentIteration && (
              <span style={{ color: C.dim }}> · iter {currentIteration.current}/{currentIteration.max}</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isRunning && (
              <button
                onClick={handleCancel}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ background: C.coral + "20", color: C.coral, border: `1px solid ${C.coral}40` }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.coral + "40" }}
                onMouseLeave={(e) => { e.currentTarget.style.background = C.coral + "20" }}
              >
                CANCEL
              </button>
            )}
            {isFailed && (
              <button
                onClick={handleResume}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ background: C.peach + "20", color: C.peach, border: `1px solid ${C.peach}40` }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.peach + "40" }}
                onMouseLeave={(e) => { e.currentTarget.style.background = C.peach + "20" }}
              >
                RESUME
              </button>
            )}
            {resumeError && (
              <span className="text-[10px]" style={{ color: C.coral }}>{resumeError}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Scrollable body ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* ── LIVE DAG ───────────────────────────────────────── */}
        {dagNodes.length > 0 && (
          <div className="px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
            {/* Header */}
            <div className="flex items-center justify-between mb-1.5">
              <span style={{ color: C.cyan }} className="font-semibold">LIVE DAG</span>
              <span style={{ color: C.dim }}>
                {dagNodes.filter(n => n.depth === 0).length} nodes
                {currentIteration && ` · ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
              </span>
            </div>
            <div className="flex items-center gap-3 mb-2">
              <StatusField label="LIVE" value={String(dagLiveCount)} color={dagLiveCount > 0 ? C.success : C.dim} />
              <StatusField label="DONE" value={String(dagDoneCount)} color={dagDoneCount > 0 ? C.success : C.dim} />
              <StatusField label="FAIL" value={String(dagFailCount)} color={dagFailCount > 0 ? C.coral : C.dim} />
            </div>
            {/* Tree */}
            <div className="flex flex-col">
              {dagNodes.map((node, i) => {
                const isExpanded = expandedDag === node.id
                const statusDot = node.status === "done" ? C.success
                  : node.status === "error" ? C.coral
                  : node.status === "partial" ? C.peach
                  : C.accent
                const statusLabel = node.status === "done" ? "done"
                  : node.status === "error" ? "error"
                  : node.status === "partial" ? "part"
                  : "live"

                // Connector: check if this is the last node at this depth before a shallower node
                const nextNode = dagNodes[i + 1]
                const isLast = !nextNode || nextNode.depth < node.depth
                const isDelegation = node.label.startsWith("D")
                const connector = node.depth === 0
                  ? (i > 0 ? "│" : " ")
                  : (isLast ? "└─" : "├─")
                const indent = node.depth * 16

                return (
                  <div key={node.id}>
                    <div
                      className="flex items-center gap-1.5 leading-relaxed cursor-pointer rounded px-1 -mx-1 transition-colors"
                      style={{ paddingLeft: indent }}
                      onClick={() => setExpandedDag(isExpanded ? null : node.id)}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)" }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
                    >
                      {/* Connector */}
                      <span style={{ color: C.dim, width: 16, textAlign: "right", flexShrink: 0 }} className="inline-block">
                        {connector}
                      </span>
                      {/* Status dot */}
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: statusDot }}
                      />
                      {/* Label badge */}
                      <span
                        className="shrink-0 text-[10px] w-6 text-center"
                        style={{ color: isDelegation ? C.cyan : node.depth === 0 ? C.accent : C.muted }}
                      >
                        {node.label}
                      </span>
                      {/* Detail */}
                      <span className="truncate flex-1" style={{ color: C.text }}>
                        {node.detail}
                      </span>
                      {/* Status */}
                      <span className="shrink-0 text-[10px]" style={{ color: statusDot }}>
                        {statusLabel}
                      </span>
                    </div>
                    {/* Expanded detail */}
                    {isExpanded && (
                      <div
                        className="mb-1 px-2 py-1 rounded text-[10px] leading-relaxed overflow-x-auto"
                        style={{ marginLeft: indent + 24, background: C.surface, border: `1px solid ${C.border}`, maxHeight: 160, overflowY: "auto" }}
                      >
                        <pre className="whitespace-pre-wrap" style={{ color: C.muted, margin: 0 }}>{node.expanded}</pre>
                        {node.resultText && (
                          <div className="mt-1 pt-1" style={{ borderTop: `1px solid ${C.border}`, color: node.status === "error" ? C.coral : C.success }}>
                            {node.resultText.slice(0, 300)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="mt-1" style={{ color: C.dim }}>tool calls {dagToolCallCount}</div>
          </div>
        )}

        {/* ── Panels row ───────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
          <Panel title="TOOLS" badge={`${totalToolCalls} recent`}>
            <PanelRow label="LATEST" value={latestTool ?? "idle"} color={latestTool ? C.accent : C.dim} />
            <PanelRow label="ERRORS" value={String(totalToolErrors)} color={totalToolErrors > 0 ? C.coral : C.dim} />
            <PanelRow label="AGENTS" value={String(agents.length)} color={C.text} />
            <PanelRow label="RUNTIME" value={runtimeLabel} color={runtimeColor} />
          </Panel>
          <Panel title="GUARD" badge={`${policies.length} rules`}>
            <PanelRow label="DENY" value={String(denyCount)} color={denyCount > 0 ? C.coral : C.dim} />
            <PanelRow label="APPROVE" value={String(approvalCount)} color={approvalCount > 0 ? C.peach : C.dim} />
            <PanelRow label="ALERTS" value={String(unreadCount)} color={unreadCount > 0 ? C.coral : C.dim} />
            <PanelRow label="TOOLS" value={String(tools.length)} color={C.text} />
          </Panel>
          <Panel title="AGENTS" badge={`${runningRuns.length} active`}>
            <PanelRow label="ACTIVE" value={String(runningRuns.length)} color={runningRuns.length > 0 ? C.success : C.dim} />
            <PanelRow label="DONE" value={String(completedRuns.length)} color={completedRuns.length > 0 ? C.success : C.dim} />
            <PanelRow label="FAIL" value={String(failedRuns.length)} color={failedRuns.length > 0 ? C.coral : C.dim} />
            <PanelRow label="QUEUE" value={String(queuedRuns.length)} color={queuedRuns.length > 0 ? C.peach : C.dim} />
          </Panel>
        </div>

        {/* ── Usage bar ────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1" style={{ borderBottom: `1px solid ${C.border}` }}>
          <StatusField label="CALLS" value={String(liveUsage.llmCalls)} color={liveUsage.llmCalls > 0 ? C.peach : C.dim} />
          <StatusField label="TK(run)" value={fmtK(liveUsage.totalTokens)} color={liveUsage.totalTokens > 0 ? C.text : C.dim} />
          {usage && <>
            <span style={{ color: C.dim }}>│</span>
            <StatusField label="TOKENS" value={fmtK(usage.totals.totalTokens)} color={C.text} />
            <StatusField label="LLM" value={String(usage.totals.llmCalls)} color={C.accent} />
            <StatusField label="RUNS" value={String(usage.totals.runCount)} color={C.text} />
          </>}
        </div>

        {/* ── Recent alerts ────────────────────────────────────── */}
        {recentAlerts.length > 0 && (
          <div className="px-3 py-1.5" style={{ borderBottom: `1px solid ${C.border}` }}>
            <div className="mb-0.5" style={{ color: C.coral }}>RECENT ALERTS</div>
            {recentAlerts.map((a, i) => (
              <div key={i} className="flex gap-2 leading-relaxed" style={{ color: a.color }}>
                {a.time && <span style={{ color: C.dim }}>{a.time}</span>}
                <span className="truncate">{a.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Live feed ────────────────────────────────────────── */}
        <div ref={feedRef} className="px-3 py-1">
          {feedItems.length === 0 ? (
            <div style={{ color: C.dim }} className="pt-1">Awaiting activity</div>
          ) : (
            feedItems.map((item, i) => (
              <div key={i} className="leading-relaxed truncate" style={{ color: item.color }}>
                {item.text}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Operator prompt ────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-1.5 flex items-center gap-2" style={{ borderTop: `1px solid ${C.border}` }}>
        {/* Agent selector */}
        {agents.length > 1 && (
          <select
            className="text-[10px] rounded px-1.5 py-1 outline-none cursor-pointer"
            style={{ background: C.surface, color: C.muted, border: `1px solid ${C.border}` }}
            value={selectedAgentId ?? agents[0]?.id ?? ""}
            onChange={(e) => setSelectedAgent(e.target.value || null)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
        {/* Goal input */}
        <div className="flex-1 flex items-center gap-1">
          <span style={{ color: C.dim }}>{">"}</span>
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent outline-none text-xs"
            style={{ color: C.text, caretColor: C.accent }}
            placeholder={isRunning ? "running..." : "enter goal"}
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmitGoal() }}
            disabled={isRunning || submitting}
          />
        </div>
        {/* Status indicator */}
        <span style={{ color: C.dim }} className="text-[10px] shrink-0">
          {activeAgent ? activeAgent.name : agents[0]?.name ?? "no agent"}
          {" · "}
          {connected ? "live" : "offline"}
        </span>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────

function StatusField({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: C.dim }}>{label}:</span>{" "}
      <span style={{ color }}>{value}</span>
    </span>
  )
}

function Panel({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-2" style={{ border: `1px solid ${C.border}`, background: C.surface }}>
      <div className="flex items-center justify-between mb-1">
        <span style={{ color: C.accent }} className="font-semibold">{title}</span>
        <span style={{ color: C.dim }} className="text-[10px]">{badge}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {children}
      </div>
    </div>
  )
}

function PanelRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: C.dim }}>{label}:</span>
      <span style={{ color }} className="font-medium">{value}</span>
    </div>
  )
}

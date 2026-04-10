/**
 * IOE editor-area panels — Trace (DAG-style), LLM Calls, Map, EditorTabs.
 */

import { CheckCircle2, Circle, Loader2, RotateCcw, XCircle } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AgentDefinition, Run, Step, TraceEntry } from "../../types"
import { fmtTokens, formatMs, remediationHintForValidationCode, truncate } from "../../util"
import {
  C,
  fmtK,
  statusDot,
  type EditorTab,
} from "./constants"

// ═══════════════════════════════════════════════════════════════════
//  Export: format Agent Loop trace as plain text
// ═══════════════════════════════════════════════════════════════════

/** Format the entire Agent Loop trace as nicely-indented plain text. */
export function formatTraceAsText(trace: TraceEntry[]): string {
  if (trace.length === 0) return "(empty trace)"

  if (isPlannerRun(trace)) {
    const g = groupTraceForPlanner(trace)
    const lines: string[] = []
    for (const e of g.preamble) lines.push(fmtEvent(e, 0))
    for (const p of g.pipelines) fmtPipeline(p, lines)
    for (const e of g.trailing) lines.push(fmtEvent(e, 0))
    return lines.join("\n")
  }

  // Chat mode
  const g = groupTraceIntoLlmCalls(trace)
  const lines: string[] = []
  for (const call of g.calls) fmtLlmCall(call, lines)
  for (const e of g.trailing.events) lines.push(fmtEvent(e, 0))
  return lines.join("\n")
}

/** Trigger a file download in the browser. */
export function exportAgentLoop(trace: TraceEntry[]): void {
  const text = formatTraceAsText(trace)
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `agent-loop-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

/* ── Text formatting helpers ─────────────────────────────────────── */

const INDENT = "  "

function indent(depth: number): string { return INDENT.repeat(depth) }

function fmtEvent(e: TraceEntry, depth: number): string {
  const p = indent(depth)
  switch (e.kind) {
    case "goal": return `${p}GOAL  ${e.text}`
    case "system-prompt": return `${p}SYSTEM PROMPT\n${p}${e.text}`
    case "tools-resolved": return `${p}TOOLS  ${e.tools.length}: ${e.tools.map(t => t.name).join(", ")}`
    case "iteration": return `${p}ITERATION ${e.current}/${e.max}`
    case "tool-call": return `${p}TOOL CALL  ${e.tool}  ${e.argsSummary}\n${p}${e.argsFormatted}`
    case "tool-result": return `${p}TOOL RESULT\n${p}${e.text}`
    case "tool-error": return `${p}TOOL ERROR\n${p}${e.text}`
    case "thinking": return `${p}THINKING\n${p}${e.text}`
    case "answer": return `${p}ANSWER\n${p}${e.text}`
    case "error": return `${p}ERROR\n${p}${e.text}`
    case "usage": return `${p}USAGE  +${fmtK(e.iterationTokens)} tk · total ${fmtK(e.totalTokens)} · ${e.llmCalls} calls`

    case "planning_preflight": return `${p}PLANNER PREFLIGHT  ${e.mode}`
    case "planner-decision": return `${p}PLANNER  ${e.shouldPlan ? "activated" : "skipped"}  score ${e.score.toFixed(2)}`
    case "planner-generating": return `${p}GENERATING PLAN...`
    case "planner-plan-generated":
      return `${p}PLAN  ${e.stepCount} steps\n${p}  ${e.reason}\n` +
        e.steps.map((s, i) => `${p}  ${i + 1}. ${s.name} (${s.type})`).join("\n")
    case "planner-generation-failed": return `${p}GENERATION FAILED`
    case "planner-output-root-forced": return `${p}OUTPUT ROOT FORCED  ${e.outputRoot}`
    case "planner-validation-failed": return `${p}VALIDATION FAILED`
    case "planner-validation-remediated": return `${p}VALIDATION AUTO-REMEDIATED`
    case "planner-validation-warnings": return `${p}VALIDATION WARNINGS  ${e.warningCount}`
    case "direct_loop_fallback": return `${p}DIRECT LOOP FALLBACK  ${e.source}  ${e.reason}`
    case "planner-delegation-decision":
      return `${p}DELEGATION GATE  ${e.shouldDelegate ? "delegate" : "local"}  ${e.reason}`
    case "planner-pipeline-start": return `${p}PIPELINE START  attempt ${e.attempt}/${e.maxRetries}`
    case "planner-pipeline-end": return `${p}PIPELINE END  ${e.status}  ${e.completedSteps}/${e.totalSteps} steps`
    case "planner-step-start": return `${p}STEP  ${e.stepName}  ${e.stepType}`
    case "planner-step-end":
      return `${p}STEP END  ${e.stepName}  ${e.status}${e.validationCode ? ` [${e.validationCode}]` : ""}  ${e.durationMs}ms${
        e.status !== "completed" ? `\n${p}  fix: ${remediationHintForValidationCode(e.validationCode)}` : ""
      }`
    case "planner-verification":
      return `${p}VERIFY  ${e.overall}  ${(e.confidence * 100).toFixed(0)}% confidence\n` +
        e.steps.map(s => `${p}  ${s.stepName}: ${s.outcome}${s.issues.length ? " — " + s.issues.join("; ") : ""}`).join("\n")
    case "planner-retry": return `${p}RETRY  attempt ${e.attempt}  ${e.reason}`
    case "planner-retry-skipped": return `${p}RETRY SKIPPED  ${e.reason}`
    case "planner-budget-extended": return `${p}BUDGET EXTENDED  completed ${e.completedSteps}  budget ${e.effectiveBudget}  ext ${e.extensions}`
    case "planner-escalation": return `${p}ESCALATION  ${e.action}  ${e.reason}`
    case "planner-retry-abort": return `${p}RETRY ABORT  ${e.reason}`
    case "planner-retry-skip": return `${p}RETRY SKIP  ${e.stepName}  ${e.reason}`

    case "planner-delegation-start":
      return `${p}CHILD AGENT  ${e.stepName}  budget ${e.budget.computedMaxIterations} (hint ${e.budget.parsedHint} + boost ${e.budget.complexityBoost})\n${p}  ${e.goal}`
    case "planner-delegation-iteration": return `${p}${e.stepName}  ITER ${e.iteration}/${e.maxIterations}`
    case "planner-delegation-end": return `${p}CHILD DONE  ${e.stepName}  ${e.status}\n${p}  ${e.answer || e.error || ""}`

    case "delegation-start": return `${p}DELEGATE${e.agentName ? ` [${e.agentName}]` : ""}\n${p}  ${e.goal}`
    case "delegation-iteration": return `${p}DELEGATE ITER ${e.iteration}/${e.maxIterations}`
    case "delegation-end": return `${p}DELEGATE END  ${e.status}\n${p}  ${e.answer || e.error || ""}`
    case "delegation-parallel-start": return `${p}PARALLEL  ${e.taskCount} tasks`
    case "delegation-parallel-end": return `${p}PARALLEL END  ${e.fulfilled}/${e.taskCount} ok`

    case "user-input-request": return `${p}ASK USER  ${e.question}`
    case "user-input-response": return `${p}USER REPLY  ${e.text}`

    case "llm-request": return `${p}LLM REQUEST  ${e.messageCount} msgs · ${e.toolCount} tools`
    case "llm-response": {
      const tc = e.toolCalls?.length ?? 0
      return `${p}LLM RESPONSE  ${tc} tool call${tc !== 1 ? "s" : ""} · ${e.durationMs}ms`
    }
    case "workspace_diff": {
      const total = e.diff.added.length + e.diff.modified.length + e.diff.deleted.length
      return `${p}WORKSPACE DIFF  pending ${total}  (+${e.diff.added.length} ~${e.diff.modified.length} -${e.diff.deleted.length})`
    }
    case "workspace_diff_applied": {
      const total = e.summary.added + e.summary.modified + e.summary.deleted
      return `${p}WORKSPACE APPLY  moved ${total} changes  (+${e.summary.added} ~${e.summary.modified} -${e.summary.deleted})`
    }
    case "nudge": return `${p}NUDGE [${e.tag}]  ${e.message}`
    default: return `${p}${(e as { kind: string }).kind}`
  }
}

function fmtLlmCall(call: LlmCall, lines: string[]): void {
  const { callNumber, iteration, request: req, response: resp, execution, usage } = call

  const parts: string[] = [`LLM Call #${callNumber}`]
  if (iteration) parts.push(`iteration ${iteration.current}/${iteration.max}`)
  parts.push(`${req.messageCount} msgs`)
  const tc = resp?.toolCalls.length ?? 0
  parts.push(`→ ${tc} tool call${tc !== 1 ? "s" : ""}`)
  if (resp?.durationMs != null) parts.push(`${resp.durationMs}ms`)
  lines.push(parts.join("  "))

  // Preamble
  for (const p of call.preamble) lines.push(fmtEvent(p.entry, 1))

  // Request messages
  for (const msg of req.messages) {
    const role = msg.role.toUpperCase()
    const charCount = msg.content?.length ?? 0
    lines.push(`${INDENT}[${role}] ${charCount} chars${msg.toolCallId ? ` ← ${msg.toolCallId}` : ""}`)
    if (msg.content) lines.push(`${INDENT}${INDENT}${msg.content}`)
    for (const t of msg.toolCalls) {
      lines.push(`${INDENT}${INDENT}tool_call: ${t.name}(${JSON.stringify(t.arguments)})`)
    }
  }

  // Response
  if (resp) {
    const u = resp.usage
    lines.push(`${INDENT}RESPONSE  ${resp.durationMs}ms${u ? `  ${u.promptTokens}+${u.completionTokens}=${u.totalTokens} tk` : ""}`)
    if (resp.content) lines.push(`${INDENT}${INDENT}${resp.content}`)
    for (const t of resp.toolCalls) {
      lines.push(`${INDENT}${INDENT}tool_call: ${t.name}(${JSON.stringify(t.arguments)})`)
    }
  }

  // Execution
  for (const ev of execution) lines.push(fmtEvent(ev, 1))

  // Usage
  if (usage) lines.push(fmtEvent(usage, 1))
  lines.push("")
}

function fmtPipeline(p: PipelineGroup, lines: string[]): void {
  lines.push(`PIPELINE  attempt ${p.start.attempt}/${p.start.maxRetries}`)
  for (const [si, step] of p.steps.entries()) fmtStep(step, si + 1, lines)
  if (p.end) lines.push(`${INDENT}${p.end.status}  ${p.end.completedSteps}/${p.end.totalSteps} steps`)
  if (p.verification) {
    lines.push(`${INDENT}VERIFICATION`)
    for (const e of p.verification.probes) lines.push(fmtEvent(e, 2))
    if (p.verification.result) lines.push(fmtEvent(p.verification.result, 2))
  }
  for (const e of p.aftermath) lines.push(fmtEvent(e, 1))
  lines.push("")
}

function fmtStep(s: StepGroup, idx: number, lines: string[]): void {
  const status = s.end?.status ?? "running"
  const dur = s.end?.durationMs
  lines.push(`${INDENT}STEP ${idx} · ${s.start.stepName}  ${s.start.stepType}  ${status}${dur != null ? `  ${dur}ms` : ""}`)
  if (s.childStart) {
    lines.push(`${INDENT}${INDENT}CHILD AGENT  ${s.childStart.goal}`)
    for (const iter of s.iterations) {
      const iterToolCalls = iter.events.filter(e => e.kind === "tool-call").length
      lines.push(`${INDENT}${INDENT}${INDENT}ITER ${iter.marker.iteration}/${iter.marker.maxIterations}${iterToolCalls === 0 ? "  (no tools)" : ""}`)
      for (const ev of iter.events) lines.push(fmtEvent(ev, 4))
    }
    if (s.childEnd) {
      lines.push(`${INDENT}${INDENT}${INDENT}${s.childEnd.status}  ${s.childEnd.answer || s.childEnd.error || ""}`)
    }
  }
  for (const ev of s.events) lines.push(fmtEvent(ev, 2))
}

// ═══════════════════════════════════════════════════════════════════
//  EditorTabs — tab bar for the editor area
// ═══════════════════════════════════════════════════════════════════

export function EditorTabs({
  current,
  onChange,
  trace,
  stepCount,
}: {
  current: EditorTab
  onChange: (tab: EditorTab) => void
  trace: TraceEntry[]
  stepCount?: number
}) {
  const llmCallCount = useMemo(() => {
    // Show total meaningful events count — covers both chat and planner modes
    return trace.length
  }, [trace])

  const tabs: Array<{ id: EditorTab; label: string; count?: number }> = [
    { id: "llm-calls", label: "Trace", count: llmCallCount },
    { id: "tool-timeline", label: "Tool Timeline", count: stepCount },
    { id: "map", label: "Map" },
  ]

  return (
    <>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] transition-colors cursor-pointer"
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
            <span className="text-[13px] px-1 rounded" style={{ background: C.elevated, color: C.dim }}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
//  ToolTimelinePanel — vertical timeline of tool calls (live)
// ═══════════════════════════════════════════════════════════════════

export function ToolTimelinePanel({ steps }: { steps: Step[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const stepKey = (step: Step, index: number) => step.id || `${step.order}:${step.name}:${index}`

  const hasDetail = (value: unknown) => {
    if (value == null) return false
    if (typeof value === "string") return value.length > 0
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0
    return true
  }

  const formatDetail = (value: unknown) => {
    if (typeof value === "string") return value
    if (value == null) return ""
    return JSON.stringify(value, null, 2)
  }

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [steps.length])

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        No steps yet
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full overflow-y-auto p-3 space-y-0">
      {steps.map((step, i) => {
        const key = stepKey(step, i)
        const isLast = i === steps.length - 1
        const isRunning = step.status === "running"
        const isExpanded = expanded === key
        const duration = step.startedAt && step.completedAt
          ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
          : null

        const StatusIcon = isRunning
          ? Loader2
          : step.status === "completed"
          ? CheckCircle2
          : step.status === "failed"
          ? XCircle
          : Circle

        const iconColor = isRunning
          ? C.accent
          : step.status === "completed"
          ? C.success
          : step.status === "failed"
          ? C.error
          : C.dim

        return (
          <div key={key} className="flex gap-3">
            {/* Timeline line + icon */}
            <div className="flex flex-col items-center shrink-0">
              <StatusIcon
                size={18}
                className={`mt-0.5 ${isRunning ? "animate-spin" : ""}`}
                style={{ color: iconColor }}
              />
              {!isLast && (
                <div className="w-px flex-1 my-1" style={{ background: C.elevated }} />
              )}
            </div>

            {/* Content */}
            <div
              className="flex-1 pb-3 cursor-pointer select-none"
              onClick={() => setExpanded(isExpanded ? null : key)}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium" style={{ color: C.text }}>{step.name}</span>
                {duration !== null && (
                  <span className="text-[13px] font-mono" style={{ color: C.dim }}>
                    {formatMs(duration)}
                  </span>
                )}
                <button
                  type="button"
                  className="ml-auto text-[13px] px-1.5 py-0.5 rounded border cursor-pointer"
                  style={{
                    color: isExpanded ? C.text : C.dim,
                    borderColor: C.border,
                    background: isExpanded ? C.elevated : "transparent",
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    setExpanded(current => current === key ? null : key)
                  }}
                >
                  {isExpanded ? "Hide details" : "Show details"}
                </button>
              </div>
              <div className="text-[13px] mt-0.5" style={{ color: C.dim }}>
                {step.action}
                {step.error && (
                  <span className="ml-2" style={{ color: C.error }}>{String(step.error)}</span>
                )}
                {(() => {
                  const attempts = step.output && Number((step.output as Record<string, unknown>)["attempts"]);
                  return attempts && attempts > 1 ? (
                    <span className="ml-2 text-[13px] px-1.5 py-0.5 rounded" style={{ background: `${C.warning}19`, color: C.warning }}>
                      <RotateCcw size={10} className="inline mr-0.5 -mt-0.5" />
                      {attempts} attempts
                    </span>
                  ) : null;
                })()}
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="mt-2 space-y-2">
                  {hasDetail(step.input) && (
                    <div>
                      <span className="text-[13px] uppercase tracking-wide" style={{ color: C.dim }}>Input</span>
                      <pre className="text-[13px] font-mono rounded-lg p-2 mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-all"
                        style={{ color: C.textSecondary, background: C.base }}>
                        {formatDetail(step.input)}
                      </pre>
                    </div>
                  )}
                  {hasDetail(step.output) && (
                    <div>
                      <span className="text-[13px] uppercase tracking-wide" style={{ color: C.dim }}>Output</span>
                      <pre className="text-[13px] font-mono rounded-lg p-2 mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-all"
                        style={{ color: C.textSecondary, background: C.base }}>
                        {formatDetail(step.output)}
                      </pre>
                    </div>
                  )}
                  {step.error && (
                    <div>
                      <span className="text-[13px] uppercase tracking-wide" style={{ color: C.dim }}>Error</span>
                      <pre className="text-[13px] font-mono rounded-lg p-2 mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all"
                        style={{ color: C.error, background: C.base }}>
                        {step.error}
                      </pre>
                    </div>
                  )}
                  {!hasDetail(step.input) && !hasDetail(step.output) && !step.error && (
                    <div className="text-[13px] px-2 py-1.5 rounded" style={{ color: C.dim, background: C.base }}>
                      No input/output payload captured for this step.
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

// ═══════════════════════════════════════════════════════════════════
//  TracePanel — DAG-style hierarchical trace view
// ═══════════════════════════════════════════════════════════════════

export function TracePanel({ trace }: { trace: TraceEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [trace.length])

  if (trace.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        No trace data — start a run
      </div>
    )
  }

  // Group trace into iterations for DAG-like structure
  const groups = groupTraceByIteration(trace)

  return (
    <div ref={ref} className="h-full overflow-y-auto px-3 py-2 font-mono text-[13px] leading-relaxed">
      {groups.map((g, gi) => (
        <TraceGroup key={gi} group={g} isLast={gi === groups.length - 1} />
      ))}
    </div>
  )
}

interface TraceGroupData {
  type: "goal" | "iteration" | "answer" | "error"
  header: TraceEntry
  children: TraceEntry[]
  delegationDepth: number
}

function groupTraceByIteration(trace: TraceEntry[]): TraceGroupData[] {
  const groups: TraceGroupData[] = []
  let current: TraceGroupData | null = null
  let delegDepth = 0

  for (const e of trace) {
    if (e.kind === "goal") {
      current = { type: "goal", header: e, children: [], delegationDepth: 0 }
      groups.push(current)
    } else if (e.kind === "iteration") {
      current = { type: "iteration", header: e, children: [], delegationDepth: delegDepth }
      groups.push(current)
    } else if (e.kind === "answer") {
      groups.push({ type: "answer", header: e, children: [], delegationDepth: delegDepth })
      current = null
    } else if (e.kind === "error") {
      groups.push({ type: "error", header: e, children: [], delegationDepth: delegDepth })
      current = null
    } else if (
      e.kind === "planning_preflight"
      || e.kind === "planner-decision"
      || e.kind === "planner-pipeline-start"
      || e.kind === "direct_loop_fallback"
    ) {
      // Planner phases get their own group so they appear at top level
      current = { type: "iteration", header: e, children: [], delegationDepth: 0 }
      groups.push(current)
    } else {
      if (e.kind === "delegation-start") delegDepth++
      if (e.kind === "delegation-end") delegDepth = Math.max(0, delegDepth - 1)
      if (current) current.children.push(e)
      // If no current group (orphan planner events before first iteration), create one
      else {
        current = { type: "iteration", header: e, children: [], delegationDepth: 0 }
        groups.push(current)
      }
    }
  }
  return groups
}

function TraceGroup({ group: g, isLast }: { group: TraceGroupData; isLast: boolean }) {
  // Goal node
  if (g.type === "goal") {
    const goalEntry = g.header as Extract<TraceEntry, { kind: "goal" }>
    return (
      <div className="relative pl-6 pb-2">
        {/* Vertical connector line */}
        <div className="absolute left-[11px] top-5 bottom-0 w-px" style={{ background: C.accent + "30" }} />
        {/* Node dot */}
        <div className="absolute left-[7px] top-1.5 w-2.5 h-2.5 rounded-full" style={{ background: C.accent }} />
        <div className="pb-1">
          <span className="text-[13px] font-mono font-semibold mr-2" style={{ color: C.accent }}>GOAL</span>
          <span className="text-[13px]" style={{ color: C.text }}>{goalEntry.text}</span>
        </div>
      </div>
    )
  }

  // Answer node
  if (g.type === "answer") {
    const ansEntry = g.header as Extract<TraceEntry, { kind: "answer" }>
    return (
      <div className="relative pl-6 pt-1 pb-2">
        <div className="absolute left-[7px] top-2.5 w-2.5 h-2.5 rounded-full" style={{ background: C.success }} />
        <div className="pt-1" style={{ borderTop: `1px dashed ${C.border}` }}>
          <span className="text-[13px] font-mono font-semibold mr-2" style={{ color: C.success }}>DONE</span>
          <div className="text-[13px] whitespace-pre-wrap leading-relaxed mt-1" style={{ color: C.textSecondary }}>{ansEntry.text}</div>
        </div>
      </div>
    )
  }

  // Error node
  if (g.type === "error") {
    const errEntry = g.header as Extract<TraceEntry, { kind: "error" }>
    return (
      <div className="relative pl-6 pt-1 pb-2">
        <div className="absolute left-[7px] top-2.5 w-2.5 h-2.5 rounded-full" style={{ background: C.coral }} />
        <div className="pt-1" style={{ borderTop: `1px dashed ${C.border}` }}>
          <span className="text-[13px] font-mono font-semibold mr-2" style={{ color: C.coral }}>FAIL</span>
          <span className="text-[13px]" style={{ color: C.coral, opacity: 0.8 }}>{errEntry.text}</span>
        </div>
      </div>
    )
  }

  // Iteration group — collapsible with children indented
  return <IterationGroup group={g} isLast={isLast} />
}

function IterationGroup({ group: g, isLast }: { group: TraceGroupData; isLast: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const indent = g.delegationDepth * 16

  // Determine header text based on entry kind
  const isPlannerHeader = g.header.kind === "planning_preflight"
    || g.header.kind === "planner-decision"
    || g.header.kind === "planner-pipeline-start"
    || g.header.kind === "direct_loop_fallback"
  const headerColor = isPlannerHeader ? "#C084FC" : C.accent

  let headerLabel: string
  let headerBadge: string
  if (g.header.kind === "planning_preflight") {
    headerLabel = "PLANNER PREFLIGHT"
    headerBadge = "P0"
  } else if (g.header.kind === "planner-decision") {
    const pd = g.header as Extract<TraceEntry, { kind: "planner-decision" }>
    headerLabel = pd.shouldPlan ? `PLAN ▶ score ${pd.score.toFixed(2)}` : `PLAN ▷ skipped`
    headerBadge = "P"
  } else if (g.header.kind === "direct_loop_fallback") {
    const fallback = g.header as Extract<TraceEntry, { kind: "direct_loop_fallback" }>
    headerLabel = fallback.source === "planner_verifier_low_complexity"
      ? "DIRECT LOOP FALLBACK · low-complexity repair"
      : "DIRECT LOOP FALLBACK · planner declined"
    headerBadge = "D"
  } else if (g.header.kind === "planner-pipeline-start") {
    const ps = g.header as Extract<TraceEntry, { kind: "planner-pipeline-start" }>
    headerLabel = `PIPELINE attempt ${ps.attempt}/${ps.maxRetries}`
    headerBadge = "⚙"
  } else if (g.header.kind === "iteration") {
    const iterEntry = g.header as Extract<TraceEntry, { kind: "iteration" }>
    headerLabel = `ITER ${iterEntry.current}/${iterEntry.max}`
    headerBadge = String(iterEntry.current)
  } else {
    headerLabel = g.header.kind
    headerBadge = "?"
  }

  // Count children by type for summary
  const toolCalls = g.children.filter((e) => e.kind === "tool-call").length
  const hasErrors = g.children.some((e) => e.kind === "tool-error" || e.kind === "planner-validation-failed" || e.kind === "planner-generation-failed")
  const hasRemediations = g.children.some((e) => e.kind === "planner-validation-remediated")
  const usage = g.children.find((e) => e.kind === "usage") as Extract<TraceEntry, { kind: "usage" }> | undefined

  return (
    <div className="relative" style={{ marginLeft: indent }}>
      {/* Vertical line */}
      {!isLast && (
        <div className="absolute left-[11px] top-5 bottom-0 w-px" style={{ background: headerColor + "20" }} />
      )}

      {/* Iteration header node */}
      <div
        className="relative pl-6 pb-0.5 flex items-center gap-2 cursor-pointer hover:bg-white/[0.02] rounded transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div
          className="absolute left-[5px] top-1 w-3.5 h-3.5 rounded-sm flex items-center justify-center"
          style={{ background: hasErrors ? C.coral + "20" : headerColor + "15", border: `1px solid ${hasErrors ? C.coral + "40" : headerColor + "30"}` }}
        >
          <span className="text-[9px] font-bold" style={{ color: hasErrors ? C.coral : hasRemediations ? C.warning : headerColor }}>
            {headerBadge}
          </span>
        </div>
        <span className="text-[13px] font-mono" style={{ color: C.muted }}>
          {headerLabel}
        </span>
        {toolCalls > 0 && (
          <span className="text-[13px] font-mono" style={{ color: C.warning }}>{toolCalls} tool{toolCalls > 1 ? "s" : ""}</span>
        )}
        {usage && (
          <span className="text-[13px] font-mono" style={{ color: C.dim }}>+{fmtK(usage.iterationTokens)} tk</span>
        )}
        <span className="text-[10px] ml-auto" style={{ color: C.dim }}>
          {collapsed ? "▸" : "▾"}
        </span>
      </div>

      {/* Children — tool calls, thinking, results, delegation — indented under the iteration  */}
      {!collapsed && (
        <div className="pl-6 ml-0.5" style={{ borderLeft: `1px solid ${C.accent}15`, marginLeft: 10 }}>
          {g.children.map((e, i) => (
            <TraceChild key={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function TraceChild({ entry: e }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false)

  if (e.kind === "thinking") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.accent}30` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: C.accent }}>LLM</span>
        <span className="text-[13px] whitespace-pre-wrap" style={{ color: C.textSecondary }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "tool-call") {
    return (
      <div className="py-0.5">
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: C.warning }} />
          <span className="text-[13px] font-mono font-semibold" style={{ color: C.warning }}>CALL</span>
          <span className="text-[13px] font-mono" style={{ color: C.warning }}>{e.tool}</span>
          {!expanded && e.argsSummary && (
            <span className="text-[13px] truncate" style={{ color: C.dim }}>{e.argsSummary}</span>
          )}
          <span className="text-[10px] ml-auto" style={{ color: C.dim }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre
            className="text-[13px] rounded-lg p-2 mt-1 ml-3 max-h-40 overflow-auto whitespace-pre-wrap"
            style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
          >
            {e.argsFormatted}
          </pre>
        )}
      </div>
    )
  }
  if (e.kind === "tool-result") {
    return (
      <div className="py-0.5 pl-3">
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="w-1 h-1 rounded-full shrink-0" style={{ background: C.success + "80" }} />
          <span className="text-[13px] font-mono font-semibold" style={{ color: C.success }}>RSLT</span>
          {!expanded && (
            <span className="text-[13px] truncate" style={{ color: C.muted }}>
              {e.text.length > 100 ? e.text.slice(0, 100) + "..." : e.text}
            </span>
          )}
        </div>
        {expanded && (
          <pre
            className="text-[13px] rounded-lg p-2 mt-1 ml-3 max-h-40 overflow-auto whitespace-pre-wrap"
            style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
          >
            {e.text}
          </pre>
        )}
      </div>
    )
  }
  if (e.kind === "tool-error") {
    return (
      <div className="py-0.5 pl-3">
        <span className="w-1 h-1 rounded-full inline-block mr-1.5" style={{ background: C.coral }} />
        <span className="text-[13px] font-mono font-semibold mr-1" style={{ color: C.coral }}>ERR</span>
        <span className="text-[13px]" style={{ color: C.coral, opacity: 0.8 }}>{e.text}</span>
      </div>
    )
  }
  if (e.kind === "usage") {
    return (
      <div className="flex items-center gap-3 py-0.5 text-[13px] font-mono" style={{ color: C.dim }}>
        <span>+{fmtK(e.iterationTokens)} tk (total {fmtK(e.totalTokens)})</span>
        <span>{e.llmCalls} calls</span>
      </div>
    )
  }
  if (e.kind === "delegation-start") {
    return (
      <div className="py-1 pl-2 mt-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#6CB4EE" }}>DELEG ▶</span>
          {e.agentName && <span className="text-[13px]" style={{ color: C.textSecondary }}>[{e.agentName}]</span>}
          <span className="text-[13px] font-mono" style={{ color: C.dim }}>d{e.depth}</span>
        </div>
        <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.textSecondary }}>
          {e.goal.length > 200 ? e.goal.slice(0, 200) + "..." : e.goal}
        </div>
        <div className="text-[13px] font-mono mt-0.5 pl-2" style={{ color: C.dim }}>
          tools: {e.tools.slice(0, 6).join(", ")}{e.tools.length > 6 ? ` +${e.tools.length - 6}` : ""}
        </div>
      </div>
    )
  }
  if (e.kind === "delegation-end") {
    return (
      <div className="py-1 pl-2 mb-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: "#6CB4EE" }}>DELEG ◀</span>
        <span className="text-[13px] font-mono" style={{ color: e.status === "done" ? C.success : C.coral }}>{e.status}</span>
        {e.answer && (
          <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.textSecondary }}>
            {e.answer.length > 150 ? e.answer.slice(0, 150) + "..." : e.answer}
          </div>
        )}
        {e.error && (
          <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.coral }}>{e.error}</div>
        )}
      </div>
    )
  }
  if (e.kind === "delegation-iteration") {
    return (
      <div className="text-[13px] font-mono pl-4 py-0.5" style={{ color: C.dim }}>
        ↳ ITER {e.iteration}/{e.maxIterations}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-start") {
    return (
      <div className="py-1 pl-2 mt-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: "#6CB4EE" }}>PARLL ▶</span>
        <span className="text-[13px] font-mono" style={{ color: C.muted }}>{e.taskCount} tasks</span>
        {e.goals.map((goal, i) => (
          <div key={i} className="pl-4 text-[13px]" style={{ color: C.muted }}>• {truncate(goal, 80)}</div>
        ))}
      </div>
    )
  }
  if (e.kind === "delegation-parallel-end") {
    return (
      <div className="py-0.5 pl-2 mb-0.5" style={{ borderLeft: `2px solid #6CB4EE40` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: "#6CB4EE" }}>PARLL ◀</span>
        <span className="text-[13px] font-mono" style={{ color: C.muted }}>{e.fulfilled}/{e.taskCount} ok, {e.rejected} failed</span>
      </div>
    )
  }
  if (e.kind === "user-input-request") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.warning}40` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: C.warning }}>ASK</span>
        <span className="text-[13px]" style={{ color: C.text }}>{e.question}</span>
      </div>
    )
  }
  if (e.kind === "user-input-response") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.warning}40` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: C.success }}>REPLY</span>
        <span className="text-[13px]" style={{ color: C.textSecondary }}>{e.text}</span>
      </div>
    )
  }
  // ── System prompt ──
  if (e.kind === "system-prompt") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${C.dim}30` }}>
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-[13px] font-mono font-semibold" style={{ color: C.dim }}>?</span>
          <span className="text-[13px] font-mono" style={{ color: C.muted }}>system-prompt</span>
          {!expanded && (
            <span className="text-[13px] truncate" style={{ color: C.dim }}>
              {e.text.length > 80 ? e.text.slice(0, 80) + "…" : e.text}
            </span>
          )}
          <span className="text-[10px] ml-auto" style={{ color: C.dim }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre
            className="text-[13px] rounded-lg p-2 mt-1 ml-3 max-h-60 overflow-auto whitespace-pre-wrap"
            style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
          >
            {e.text}
          </pre>
        )}
      </div>
    )
  }
  // ── Planner events ──
  if (e.kind === "planning_preflight") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid #C084FC40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#C084FC" }}>PREFLIGHT</span>
          <span className="text-[13px] font-mono" style={{ color: "#C084FC" }}>{e.mode}</span>
        </div>
        <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.muted }}>
          Planner routing is evaluated before direct-loop iteration numbering begins.
        </div>
      </div>
    )
  }
  if (e.kind === "planner-decision") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid #C084FC40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#C084FC" }}>PLAN</span>
          <span className="text-[13px] font-mono" style={{ color: e.shouldPlan ? "#C084FC" : C.dim }}>
            {e.shouldPlan ? "▶ activated" : "▷ skipped"}
          </span>
          <span className="text-[13px] font-mono" style={{ color: C.dim }}>score {e.score.toFixed(2)}</span>
        </div>
        <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.muted }}>{e.reason}</div>
      </div>
    )
  }
  if (e.kind === "planner-generating") {
    return (
      <div className="py-0.5 pl-4 text-[13px] font-mono" style={{ color: "#C084FC80" }}>
        ⟳ generating plan…
      </div>
    )
  }
  if (e.kind === "planner-plan-generated") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid #C084FC40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#C084FC" }}>PLAN</span>
          <span className="text-[13px] font-mono" style={{ color: "#C084FC" }}>✓ {e.stepCount} steps</span>
        </div>
        <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.muted }}>{e.reason}</div>
        <div className="text-[13px] font-mono mt-0.5 pl-2" style={{ color: C.dim }}>
          {e.steps.map(s => s.name).join(" → ")}
        </div>
      </div>
    )
  }
  if (e.kind === "planner-generation-failed" || e.kind === "planner-validation-failed") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid ${C.coral}40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#C084FC" }}>PLAN</span>
          <span className="text-[13px] font-mono" style={{ color: C.coral }}>
            ✗ {e.kind === "planner-generation-failed" ? "generation" : "validation"} failed
          </span>
        </div>
        {e.diagnostics.map((d, i) => (
          <div key={i} className="text-[13px] mt-0.5 pl-2" style={{ color: C.coral + "B0" }}>
            [{d.code}] {d.message}
          </div>
        ))}
      </div>
    )
  }
  if (e.kind === "planner-validation-remediated") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid ${C.success}40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#C084FC" }}>PLAN</span>
          <span className="text-[13px] font-mono" style={{ color: C.success }}>
            ✓ validation auto-remediated
          </span>
        </div>
        {e.diagnostics.map((d, i) => (
          <div key={i} className="text-[13px] mt-0.5 pl-2" style={{ color: C.success + "B0" }}>
            [{d.code}] {d.message}
          </div>
        ))}
      </div>
    )
  }
  if (e.kind === "direct_loop_fallback") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid ${C.warning}40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: C.warning }}>DIRECT</span>
          <span className="text-[13px] font-mono" style={{ color: C.warning }}>
            fallback from {e.source === "planner_verifier_low_complexity" ? "low-complexity planner repair" : "planner decline"}
          </span>
        </div>
        <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.muted }}>{e.reason}</div>
      </div>
    )
  }
  if (e.kind === "planner-pipeline-start") {
    return (
      <div className="py-0.5 pl-4 text-[13px] font-mono" style={{ color: "#C084FC80" }}>
        ▶ pipeline attempt {e.attempt}/{e.maxRetries}
      </div>
    )
  }
  if (e.kind === "planner-step-start") {
    return (
      <div className="py-0.5 pl-4">
        <span className="text-[13px] font-mono" style={{ color: C.muted }}>⟩ {e.stepName}</span>
        <span className="text-[13px] font-mono ml-1" style={{ color: C.dim }}>({e.stepType})</span>
      </div>
    )
  }
  if (e.kind === "planner-step-end") {
    return (
      <div className="py-0.5 pl-4">
        <span className="text-[13px] font-mono" style={{ color: e.status === "completed" ? C.success : C.coral }}>
          {e.status === "completed" ? "✓" : "✗"} {e.stepName}
        </span>
        <span className="text-[13px] font-mono ml-1" style={{ color: C.dim }}>{e.durationMs}ms</span>
        {e.validationCode && (
          <span className="text-[13px] font-mono ml-1" style={{ color: C.warning }}>[{e.validationCode}]</span>
        )}
        {e.status !== "completed" && (
          <div className="text-[13px] mt-0.5 pl-2" style={{ color: C.warning }}>
            fix: {remediationHintForValidationCode(e.validationCode)}
          </div>
        )}
      </div>
    )
  }
  if (e.kind === "planner-pipeline-end") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid #C084FC40` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: "#C084FC" }}>PIPE</span>
        <span className="text-[13px] font-mono" style={{ color: e.status === "completed" ? C.success : C.coral }}>
          ◀ {e.status}
        </span>
        <span className="text-[13px] font-mono ml-1" style={{ color: C.dim }}>
          {e.completedSteps}/{e.totalSteps} steps
        </span>
      </div>
    )
  }
  if (e.kind === "planner-verification") {
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid #C084FC40` }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#C084FC" }}>VRFY</span>
          <span className="text-[13px] font-mono" style={{ color: e.overall === "pass" ? C.success : e.overall === "partial" ? C.warning : C.coral }}>
            {e.overall}
          </span>
          <span className="text-[13px] font-mono" style={{ color: C.dim }}>{(e.confidence * 100).toFixed(0)}%</span>
        </div>
        {e.steps.filter(s => s.issues.length > 0).map((s, i) => (
          <div key={i} className="text-[13px] mt-0.5 pl-2" style={{ color: C.dim }}>
            {s.stepName}: {s.issues.join("; ")}
          </div>
        ))}
      </div>
    )
  }
  if (e.kind === "planner-retry") {
    return (
      <div className="py-0.5 pl-4 text-[13px] font-mono" style={{ color: C.warning }}>
        ↻ retry attempt {e.attempt}: {e.reason}
      </div>
    )
  }
  if (e.kind === "workspace_diff") {
    const total = e.diff.added.length + e.diff.modified.length + e.diff.deleted.length
    return (
      <div className="py-1 pl-2" style={{ borderLeft: "2px solid #22d3ee66" }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: "#22d3ee" }}>DIFF</span>
        <span className="text-[13px] font-mono" style={{ color: C.textSecondary }}>
          {total} pending (+{e.diff.added.length} ~{e.diff.modified.length} -{e.diff.deleted.length})
        </span>
      </div>
    )
  }
  if (e.kind === "workspace_diff_applied") {
    const total = e.summary.added + e.summary.modified + e.summary.deleted
    return (
      <div className="py-1 pl-2" style={{ borderLeft: `2px solid ${C.success}66` }}>
        <span className="text-[13px] font-mono font-semibold mr-1.5" style={{ color: C.success }}>APPLY</span>
        <span className="text-[13px] font-mono" style={{ color: C.textSecondary }}>
          {total} repository changes applied (+{e.summary.added} ~{e.summary.modified} -{e.summary.deleted})
        </span>
      </div>
    )
  }
  if (e.kind === "nudge") {
    return (
      <div className="py-0.5 pl-2" style={{ borderLeft: `2px solid #FF6B6B40` }}>
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#FF6B6B" }}>NUDGE</span>
          <span className="text-[13px] font-mono" style={{ color: C.muted }}>{e.tag}</span>
          {!expanded && (
            <span className="text-[13px] truncate" style={{ color: C.dim }}>
              {e.message.length > 80 ? e.message.slice(0, 80) + "…" : e.message}
            </span>
          )}
          <span className="text-[10px] ml-auto" style={{ color: C.dim }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre
            className="text-[13px] rounded-lg p-2 mt-1 ml-3 max-h-40 overflow-auto whitespace-pre-wrap"
            style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
          >
            {e.message}
          </pre>
        )}
      </div>
    )
  }
  return null
}
// ═══════════════════════════════════════════════════════════════════
//  LlmCallsPanel — Agent Loop inspector (LLM-call-centric view)
//
//  EVERYTHING is grouped under LLM Calls. Pre-call events (goal,
//  system prompt, tools, planner, iteration) appear as a preamble
//  before the first call or as metadata on the call boundary.
//  Post-response events (tool-call, tool-result, tool-error, thinking)
//  appear inside the call's EXECUTION section.
// ═══════════════════════════════════════════════════════════════════

/* ── Data model ──────────────────────────────────────────────────── */

/** Events that appear before an LLM call (goal, system prompt, iteration, planner, etc.) */
interface PreCallEvent {
  entry: TraceEntry
}

interface LlmCall {
  callNumber: number
  /** Iteration N/M shown in header */
  iteration: { current: number; max: number } | null
  /** Events between previous call (or start) and this LLM request */
  preamble: PreCallEvent[]
  /** The LLM request with all messages */
  request: Extract<TraceEntry, { kind: "llm-request" }>
  /** The LLM response (null if still streaming) */
  response: Extract<TraceEntry, { kind: "llm-response" }> | null
  /** Usage event for this iteration */
  usage: Extract<TraceEntry, { kind: "usage" }> | null
  /** Tool calls + results + errors + thinking after the response */
  execution: TraceEntry[]
}

/** Trailing events after the last LLM call (answer, error, etc.) */
interface TrailingEvents {
  events: TraceEntry[]
}

interface GroupedTrace {
  calls: LlmCall[]
  trailing: TrailingEvents
}

/* ── Grouping logic ──────────────────────────────────────────────── */

function isToolExecution(kind: string): boolean {
  return kind === "tool-call" || kind === "tool-result" || kind === "tool-error" || kind === "thinking" || kind === "nudge"
}

function groupTraceIntoLlmCalls(trace: TraceEntry[]): GroupedTrace {
  const calls: LlmCall[] = []
  let preamble: PreCallEvent[] = []
  let lastIteration: { current: number; max: number } | null = null
  let callNum = 0
  let i = 0

  while (i < trace.length) {
    const e = trace[i]

    if (e.kind === "llm-request") {
      callNum++
      const req = e as Extract<TraceEntry, { kind: "llm-request" }>
      i++

      // Collect response
      let resp: Extract<TraceEntry, { kind: "llm-response" }> | null = null
      if (i < trace.length && trace[i].kind === "llm-response") {
        resp = trace[i] as Extract<TraceEntry, { kind: "llm-response" }>
        i++
      }

      // Collect execution (tool activity) — greedy
      const execution: TraceEntry[] = []
      while (i < trace.length && isToolExecution(trace[i].kind)) {
        execution.push(trace[i])
        i++
      }

      // Check if next event is a usage for this iteration
      let usage: Extract<TraceEntry, { kind: "usage" }> | null = null
      if (i < trace.length && trace[i].kind === "usage") {
        usage = trace[i] as Extract<TraceEntry, { kind: "usage" }>
        i++
      }

      calls.push({
        callNumber: callNum,
        iteration: lastIteration,
        preamble,
        request: req,
        response: resp,
        usage,
        execution,
      })
      preamble = []
      lastIteration = null
    } else {
      // Track iteration for next LLM call
      if (e.kind === "iteration") {
        lastIteration = { current: (e as Extract<TraceEntry, { kind: "iteration" }>).current, max: (e as Extract<TraceEntry, { kind: "iteration" }>).max }
      }
      preamble.push({ entry: e })
      i++
    }
  }

  // Remaining preamble events (after last LLM call) become trailing
  const trailing: TrailingEvents = { events: preamble.map((p) => p.entry) }
  return { calls, trailing }
}

/* ── Planner-mode data model ─────────────────────────────────────── */

interface PlannerGroupedTrace {
  preamble: TraceEntry[]
  pipelines: PipelineGroup[]
  trailing: TraceEntry[]
}

interface PipelineGroup {
  start: Extract<TraceEntry, { kind: "planner-pipeline-start" }>
  end: Extract<TraceEntry, { kind: "planner-pipeline-end" }> | null
  steps: StepGroup[]
  /** Verification phase: deterministic probe calls + verifier result */
  verification: VerificationGroup | null
  /** Events after verification (retry, retry-skipped, etc.) */
  aftermath: TraceEntry[]
}

/** Verification probes + result, grouped together */
interface VerificationGroup {
  /** Tool calls run by the verifier (read_file, browser_check, etc.) */
  probes: TraceEntry[]
  /** The verification decision event */
  result: Extract<TraceEntry, { kind: "planner-verification" }> | null
}

interface StepGroup {
  start: Extract<TraceEntry, { kind: "planner-step-start" }>
  end: Extract<TraceEntry, { kind: "planner-step-end" }> | null
  childStart: Extract<TraceEntry, { kind: "planner-delegation-start" }> | null
  childEnd: Extract<TraceEntry, { kind: "planner-delegation-end" }> | null
  iterations: IterGroup[]
  events: TraceEntry[]
}

interface IterGroup {
  marker: Extract<TraceEntry, { kind: "planner-delegation-iteration" }>
  events: TraceEntry[]
}

/* ── Planner-mode grouping ───────────────────────────────────────── */

function isPlannerRun(trace: TraceEntry[]): boolean {
  return trace.some((e) => e.kind === "planner-pipeline-start")
}

function groupTraceForPlanner(trace: TraceEntry[]): PlannerGroupedTrace {
  const preamble: TraceEntry[] = []
  const pipelines: PipelineGroup[] = []
  const trailing: TraceEntry[] = []

  let currentPipeline: PipelineGroup | null = null
  const stepMap = new Map<string, StepGroup>()
  let lastActiveChild: string | null = null
  let phase: "preamble" | "in-pipeline" | "verifying" | "after-verification" = "preamble"

  for (const e of trace) {
    // Pipeline start — always opens a new pipeline
    if (e.kind === "planner-pipeline-start") {
      stepMap.clear()
      lastActiveChild = null
      phase = "in-pipeline"
      currentPipeline = {
        start: e as Extract<TraceEntry, { kind: "planner-pipeline-start" }>,
        end: null, steps: [], verification: null, aftermath: [],
      }
      pipelines.push(currentPipeline)
      continue
    }

    // Pipeline end — transition to verification phase
    if (e.kind === "planner-pipeline-end" && currentPipeline) {
      currentPipeline.end = e as Extract<TraceEntry, { kind: "planner-pipeline-end" }>
      // Enter verification phase: tool calls between pipeline-end and planner-verification
      // are deterministic probes run by the verifier
      currentPipeline.verification = { probes: [], result: null }
      phase = "verifying"
      continue
    }

    // Verification result — close verification phase
    if (e.kind === "planner-verification" && currentPipeline?.verification) {
      currentPipeline.verification.result = e as Extract<TraceEntry, { kind: "planner-verification" }>
      phase = "after-verification"
      continue
    }

    // Before first pipeline
    if (phase === "preamble") { preamble.push(e); continue }

    // Inside verification phase — collect probe calls
    if (phase === "verifying" && currentPipeline?.verification) {
      currentPipeline.verification.probes.push(e)
      continue
    }

    // After verification — retry / answer / error
    if (phase === "after-verification") {
      // A new pipeline-start will be caught at the top of the loop
      if (e.kind === "answer" || e.kind === "error") {
        trailing.push(e)
      } else if (currentPipeline) {
        currentPipeline.aftermath.push(e)
      } else {
        trailing.push(e)
      }
      continue
    }

    // ── Inside a pipeline ──
    if (!currentPipeline) { trailing.push(e); continue }

    if (e.kind === "planner-step-start") {
      const step: StepGroup = {
        start: e as Extract<TraceEntry, { kind: "planner-step-start" }>,
        end: null, childStart: null, childEnd: null, iterations: [], events: [],
      }
      currentPipeline.steps.push(step)
      stepMap.set(
        (e as Extract<TraceEntry, { kind: "planner-step-start" }>).stepName,
        step,
      )
      continue
    }

    if (e.kind === "planner-step-end") {
      const name = (e as Extract<TraceEntry, { kind: "planner-step-end" }>).stepName
      const step = stepMap.get(name)
      if (step) { step.end = e as Extract<TraceEntry, { kind: "planner-step-end" }>; stepMap.delete(name) }
      if (lastActiveChild === name) lastActiveChild = null
      continue
    }

    if (e.kind === "planner-delegation-start") {
      const name = (e as Extract<TraceEntry, { kind: "planner-delegation-start" }>).stepName
      const step = stepMap.get(name)
      if (step) {
        step.childStart = e as Extract<TraceEntry, { kind: "planner-delegation-start" }>
        lastActiveChild = name
      }
      continue
    }

    if (e.kind === "planner-delegation-end") {
      const name = (e as Extract<TraceEntry, { kind: "planner-delegation-end" }>).stepName
      const step = stepMap.get(name)
      if (step) step.childEnd = e as Extract<TraceEntry, { kind: "planner-delegation-end" }>
      if (lastActiveChild === name) lastActiveChild = null
      continue
    }

    if (e.kind === "planner-delegation-iteration") {
      const name = (e as Extract<TraceEntry, { kind: "planner-delegation-iteration" }>).stepName
      const step = stepMap.get(name)
      if (step) {
        step.iterations.push({
          marker: e as Extract<TraceEntry, { kind: "planner-delegation-iteration" }>,
          events: [],
        })
        lastActiveChild = name
      }
      continue
    }

    // Generic event — attribute to last active child's latest iteration
    if (lastActiveChild) {
      const step = stepMap.get(lastActiveChild)
      if (step) {
        const lastIter = step.iterations[step.iterations.length - 1]
        if (lastIter) { lastIter.events.push(e) } else { step.events.push(e) }
        continue
      }
    }

    // Fallback — try any open step
    if (stepMap.size > 0) {
      const last = [...stepMap.values()].pop()!
      const lastIter = last.iterations[last.iterations.length - 1]
      if (lastIter) { lastIter.events.push(e) } else { last.events.push(e) }
    }
  }

  return { preamble, pipelines, trailing }
}

/* ── Main panel ──────────────────────────────────────────────────── */

export function LlmCallsPanel({ trace }: { trace: TraceEntry[] }) {
  const plannerMode = useMemo(() => isPlannerRun(trace), [trace])

  if (trace.length === 0) {
    return (
      <div className="flex items-center justify-center h-full font-mono" style={{ color: C.dim, fontSize: 13 }}>
        No trace data — start a run
      </div>
    )
  }

  return plannerMode ? <PlannerView trace={trace} /> : <ChatView trace={trace} />
}

/* ── Chat-mode view (non-planner, LLM-call-centric) ─────────────── */

function ChatView({ trace }: { trace: TraceEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [trace.length])

  const grouped = useMemo(() => groupTraceIntoLlmCalls(trace), [trace])

  return (
    <div ref={ref} className="h-full overflow-y-auto px-2 py-2 font-mono" style={{ fontSize: 13 }}>
      {grouped.calls.map((call) => (
        <LlmCallBlock key={call.callNumber} call={call} />
      ))}
      {grouped.trailing.events.length > 0 && (
        <TrailingSection events={grouped.trailing.events} />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   LLM Call Block — the main structural unit
   ═══════════════════════════════════════════════════════════════════ */

function LlmCallBlock({ call }: { call: LlmCall }) {
  const [open, setOpen] = useState(false)
  const { request: req, response: resp, execution, callNumber, iteration, usage } = call

  const toolCallCount = resp?.toolCalls.length ?? 0
  const duration = resp?.durationMs ?? null

  // Build summary line
  const parts: string[] = []
  if (iteration) parts.push(`iteration ${iteration.current}`)
  parts.push(`${req.messageCount} msgs`)
  parts.push("→ LLM →")
  if (toolCallCount > 0) parts.push(`${toolCallCount} tool call${toolCallCount > 1 ? "s" : ""}`)
  else parts.push("no tools")
  if (duration != null) parts.push(`${duration}ms`)

  // Right-aligned duration badge
  const durationBadge = duration != null ? `${duration}ms` : null

  return (
    <div className="mb-1">
      {/* ── Header row ── */}
      <div
        className="flex items-center gap-2 py-1.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.04]"
        onClick={() => setOpen(!open)}
        style={{ background: open ? "rgba(255,255,255,0.02)" : undefined }}
      >
        <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-bold" style={{ color: C.text }}>LLM Call #{callNumber}</span>
        <span style={{ color: C.dim }}>{parts.join("  ")}</span>
        {durationBadge && (
          <span className="ml-auto" style={{ color: C.dim }}>{durationBadge}</span>
        )}
      </div>

      {/* ── Preamble (above the fold — always visible context) ── */}
      {open && call.preamble.length > 0 && (
        <div className="ml-7 mb-1">
          {call.preamble.map((p, i) => (
            <PreambleRow key={i} entry={p.entry} />
          ))}
        </div>
      )}

      {/* ── Expanded contents ── */}
      {open && (
        <div className="ml-7 space-y-0.5">
          <RequestSection2 messages={req.messages} toolCount={req.toolCount} />
          {resp && <ResponseSection2 response={resp} />}
          {execution.length > 0 && <ExecutionSection events={execution} />}
          {usage && <UsageRow2 usage={usage} />}
        </div>
      )}
    </div>
  )
}

/* ── Preamble: context events before an LLM call ── */

function PreambleRow({ entry: e }: { entry: TraceEntry }) {
  const [open, setOpen] = useState(false)

  if (e.kind === "goal") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="GOAL" labelColor={C.accent}
          detail={!open ? truncate(e.text, 120) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} /></div>}
      </div>
    )
  }

  if (e.kind === "system-prompt") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="SYSTEM PROMPT" labelColor={C.dim}
          detail={`${e.text.length} chars`}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} maxH={600} /></div>}
      </div>
    )
  }

  if (e.kind === "tools-resolved") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`TOOLS · ${e.tools.length}`} labelColor={C.dim}
          detail={!open ? e.tools.map((t: { name: string }) => t.name).join(", ") : undefined}
        />
        {open && (
          <div className="ml-5 space-y-0.5 py-0.5">
            {e.tools.map((t: { name: string; description: string }, ti: number) => (
              <div key={ti}>
                <span className="font-semibold" style={{ color: C.warning }}>{t.name}</span>
                <span className="ml-2" style={{ color: C.dim }}>{t.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-decision") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`PLANNER · ${e.shouldPlan ? "activated" : "skipped"}`}
          labelColor={e.shouldPlan ? "#C084FC" : C.dim}
          detail={`score ${e.score.toFixed(2)}`}
        />
        {open && <div className="ml-5 py-0.5" style={{ color: C.muted }}>{e.reason}</div>}
      </div>
    )
  }

  if (e.kind === "planner-plan-generated") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`PLAN · ${e.stepCount} steps`} labelColor={"#C084FC"}
          detail={!open ? e.reason : undefined}
        />
        {open && (
          <div className="ml-5 space-y-0.5 py-0.5">
            <div style={{ color: C.muted }}>{e.reason}</div>
            {e.steps.map((s: { name: string; type: string }, si: number) => (
              <div key={si} style={{ color: C.dim }}>
                {si + 1}. {s.name} ({s.type})
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-pipeline-start") {
    return <FlatRow label="PIPELINE START" labelColor={"#C084FC"} detail={`attempt ${e.attempt}/${e.maxRetries}`} />
  }

  if (e.kind === "planner-pipeline-end") {
    const ok = e.status === "completed"
    return <FlatRow label={`PIPELINE END · ${e.status}`} labelColor={ok ? C.success : C.coral} detail={`${e.completedSteps}/${e.totalSteps} steps`} />
  }

  if (e.kind === "planner-step-start") {
    return <FlatRow label={`STEP · ${e.stepName}`} labelColor={"#C084FC"} detail={e.stepType} />
  }

  if (e.kind === "planner-step-end") {
    const ok = e.status === "completed"
    return <FlatRow label={`STEP END · ${e.stepName}`} labelColor={ok ? C.success : C.coral} detail={`${e.status} · ${e.durationMs}ms`} />
  }

  if (e.kind === "delegation-start") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`DELEGATE${e.agentName ? ` [${e.agentName}]` : ""}`} labelColor={"#6CB4EE"}
          detail={!open ? truncate(e.goal, 80) : `d${e.depth} · ${e.tools.length} tools`}
        />
        {open && (
          <div className="ml-5 space-y-1 py-0.5">
            <div style={{ color: C.dim }}>tools: {e.tools.join(", ")}</div>
            <Pane text={e.goal} />
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "delegation-end") {
    const ok = e.status === "done"
    return <FlatRow label={`DELEGATE END · ${e.status}`} labelColor={ok ? C.success : C.coral} detail={truncate(e.answer || e.error || "", 80)} />
  }

  if (e.kind === "delegation-iteration") {
    return <FlatRow label={`DELEGATE ITER ${e.iteration}/${e.maxIterations}`} labelColor={"#6CB4EE"} />
  }

  if (e.kind === "delegation-parallel-start") {
    return <FlatRow label={`PARALLEL · ${e.taskCount} tasks`} labelColor={"#6CB4EE"} />
  }

  if (e.kind === "delegation-parallel-end") {
    return <FlatRow label={`PARALLEL END`} labelColor={"#6CB4EE"} detail={`${e.fulfilled}/${e.taskCount} ok`} />
  }

  if (e.kind === "planner-delegation-start") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`CHILD AGENT · ${e.stepName}`} labelColor={"#E879A8"}
          detail={!open ? `budget ${e.budget.computedMaxIterations} · ${truncate(e.goal, 56)}` : `d${e.depth} · ${e.tools.length} tools · hint ${e.budget.parsedHint} · floor ${e.budget.contractFloor} · boost ${e.budget.complexityBoost}`}
        />
        {open && (
          <div className="ml-5 space-y-1 py-0.5">
            <div style={{ color: C.dim }}>
              budget: computed {e.budget.computedMaxIterations} · base {e.budget.baseBudget} · floor {e.budget.contractFloor} · boost {e.budget.complexityBoost}
            </div>
            <div style={{ color: C.dim }}>
              shape: {e.budget.acceptanceCriteriaCount} criteria · {e.budget.targetArtifactCount} targets · {e.budget.requiredSourceArtifactCount} sources · {e.budget.codeArtifactCount} code files{e.budget.hasBlueprintSource ? " · blueprint" : ""}{e.budget.hasComplexImplementation ? " · complex" : ""}
            </div>
            <div style={{ color: C.dim }}>tools: {e.tools.join(", ")}</div>
            <Pane text={e.goal} maxH={400} />
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-delegation-end") {
    const ok = e.status === "done"
    return <FlatRow label={`CHILD DONE · ${e.stepName} · ${e.status}`} labelColor={ok ? C.success : C.coral} detail={truncate(e.answer || e.error || "", 80)} />
  }

  if (e.kind === "planner-delegation-iteration") {
    return <FlatRow label={`${e.stepName} · ITER ${e.iteration}/${e.maxIterations}`} labelColor={"#E879A8"} />
  }

  if (e.kind === "planner-verification") {
    const color = e.overall === "pass" ? C.success : e.overall === "retry" ? C.warning : C.coral
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`VERIFY · ${e.overall}`} labelColor={color}
          detail={`${(e.confidence * 100).toFixed(0)}% confidence`}
        />
        {open && e.steps.length > 0 && (
          <div className="ml-5 space-y-0.5 py-0.5">
            {e.steps.map((s: { stepName: string; outcome: string; issues: string[] }, si: number) => {
              const sColor = s.outcome === "pass" ? C.success : s.outcome === "fail" ? C.coral : C.warning
              return (
                <div key={si}>
                  <span className="font-semibold" style={{ color: sColor }}>{s.outcome}</span>
                  <span className="ml-2" style={{ color: C.text }}>{s.stepName}</span>
                  {s.issues.length > 0 && (
                    <div className="ml-4 mt-1 space-y-1">
                      {s.issues.map((issue: string, ii: number) => (
                        <ExpandableMessage key={ii} label="ISSUE" text={issue} color={C.dim} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-retry") {
    const detail = e.reason ? (e.reason.length > 80 ? truncate(e.reason, 80) : e.reason) : undefined
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`RETRY · attempt ${e.attempt}`} labelColor={C.warning}
          detail={!open ? detail : undefined}
        />
        {open && (
          <div className="ml-5 py-0.5">
            {e.reason && <Pane text={e.reason} maxH={300} />}
            {((e as Record<string, unknown>).skippedSteps != null || (e as Record<string, unknown>).retrySteps != null) && (
              <div className="mt-1" style={{ color: C.dim, fontSize: 13 }}>
                {(e as Record<string, unknown>).retrySteps != null && <span>retrying {String((e as Record<string, unknown>).retrySteps)} step(s)</span>}
                {(e as Record<string, unknown>).skippedSteps != null && <span className="ml-2">· {String((e as Record<string, unknown>).skippedSteps)} skipped</span>}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-retry-skipped") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="RETRY SKIPPED" labelColor={C.dim}
          detail={!open ? truncate(e.reason, 80) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.reason} maxH={200} /></div>}
      </div>
    )
  }

  if (e.kind === "planner-escalation") {
    const actionColor = e.action === "pass" ? C.success : e.action === "escalate" ? C.coral : C.warning
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`ESCALATION · ${e.action}`} labelColor={actionColor}
          detail={!open ? `${e.reason} · attempt ${e.attempt}` : undefined}
        />
        {open && (
          <div className="ml-5 py-0.5" style={{ color: C.dim }}>
            <div>reason: {e.reason}</div>
            <div>attempt: {e.attempt}</div>
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-retry-skip") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`RETRY SKIP · ${e.stepName}`} labelColor={C.dim}
          detail={!open ? truncate(e.reason, 80) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.reason} maxH={200} /></div>}
      </div>
    )
  }

  if (e.kind === "planner-retry-abort") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="RETRY ABORT" labelColor={C.coral}
          detail={!open ? truncate(e.reason, 80) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.reason} maxH={200} /></div>}
      </div>
    )
  }

  if (e.kind === "planner-budget-extended") {
    return <FlatRow label="BUDGET EXTENDED" labelColor={C.accent} detail={`${e.completedSteps} steps done · budget → ${e.effectiveBudget} (ext #${e.extensions})`} />
  }

  if (e.kind === "planner-delegation-decision") {
    const blocked = e.hardBlockedTaskClass
    const decColor = e.shouldDelegate ? C.success : blocked ? C.coral : C.warning
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`DELEGATION GATE · ${e.shouldDelegate ? "approved" : blocked ? "BLOCKED" : "declined"}`}
          labelColor={decColor}
          detail={!open ? truncate(e.reason, 80) : undefined}
        />
        {open && (
          <div className="ml-5 py-0.5" style={{ color: C.dim }}>
            <div>{e.reason}</div>
            <div className="mt-0.5">utility: {e.utilityScore.toFixed(2)} · safety: {e.safetyRisk.toFixed(2)} · confidence: {(e.confidence * 100).toFixed(0)}%</div>
            {blocked && <div className="mt-0.5" style={{ color: C.coral }}>blocked: {blocked}</div>}
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "planner-generating") {
    return <FlatRow label="GENERATING PLAN" labelColor={"#C084FC"} />
  }

  if (e.kind === "workspace_diff") {
    const total = e.diff.added.length + e.diff.modified.length + e.diff.deleted.length
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`WORKSPACE DIFF · ${total} pending`}
          labelColor="#22d3ee"
          detail={!open ? `+${e.diff.added.length} ~${e.diff.modified.length} -${e.diff.deleted.length}` : undefined}
        />
        {open && (
          <div className="ml-5 space-y-0.5 py-0.5" style={{ color: C.dim }}>
            {e.diff.added.length > 0 && <div>added: {e.diff.added.slice(0, 8).join(", ")}{e.diff.added.length > 8 ? ` +${e.diff.added.length - 8}` : ""}</div>}
            {e.diff.modified.length > 0 && <div>modified: {e.diff.modified.slice(0, 8).join(", ")}{e.diff.modified.length > 8 ? ` +${e.diff.modified.length - 8}` : ""}</div>}
            {e.diff.deleted.length > 0 && <div>deleted: {e.diff.deleted.slice(0, 8).join(", ")}{e.diff.deleted.length > 8 ? ` +${e.diff.deleted.length - 8}` : ""}</div>}
          </div>
        )}
      </div>
    )
  }

  if (e.kind === "workspace_diff_applied") {
    const total = e.summary.added + e.summary.modified + e.summary.deleted
    return <FlatRow label="WORKSPACE APPLIED" labelColor={C.success} detail={`${total} files (+${e.summary.added} ~${e.summary.modified} -${e.summary.deleted})`} />
  }

  if (e.kind === "planner-generation-failed" || e.kind === "planner-validation-failed") {
    return <FlatRow label={e.kind === "planner-generation-failed" ? "GENERATION FAILED" : "VALIDATION FAILED"} labelColor={C.coral} />
  }

  if (e.kind === "planner-validation-remediated") {
    return <FlatRow label="VALIDATION AUTO-REMEDIATED" labelColor={C.success} />
  }

  if (e.kind === "user-input-request") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="ASK USER" labelColor={C.warning}
          detail={!open ? truncate(e.question, 100) : undefined}
        />
        {open && <div className="ml-5 py-0.5" style={{ color: C.text }}>{e.question}</div>}
      </div>
    )
  }

  if (e.kind === "user-input-response") {
    return <FlatRow label="USER REPLY" labelColor={C.success} detail={e.text} />
  }

  if (e.kind === "nudge") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label={`NUDGE · ${e.tag}`} labelColor="#FF6B6B"
          detail={!open ? truncate(e.message, 100) : `iter ${e.iteration}`}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.message} maxH={300} /></div>}
      </div>
    )
  }

  // iteration — skip (shown in header), but keep for completeness
  if (e.kind === "iteration") {
    return null
  }

  // usage — skip (shown in call block)
  if (e.kind === "usage") {
    return null
  }

  // Tool / execution events (can appear in pipeline aftermath)
  if (e.kind === "tool-call" || e.kind === "tool-result" || e.kind === "tool-error" || e.kind === "thinking") {
    return <ExecutionRow entry={e} />
  }

  if (e.kind === "answer") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="ANSWER" labelColor={C.success}
          detail={!open ? truncate(e.text, 120) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} /></div>}
      </div>
    )
  }

  if (e.kind === "error") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="ERROR" labelColor={C.coral}
          detail={!open ? truncate(e.text, 120) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} /></div>}
      </div>
    )
  }

  if (e.kind === "llm-request") {
    const req = e as Extract<TraceEntry, { kind: "llm-request" }>
    return <RequestSection2 messages={req.messages} toolCount={req.toolCount} />
  }

  if (e.kind === "llm-response") {
    const resp = e as Extract<TraceEntry, { kind: "llm-response" }>
    return <ResponseSection2 response={resp} />
  }

  // Catch-all
  const raw = e as Record<string, unknown>
  return <FlatRow label={String(raw.kind ?? "unknown")} labelColor={C.dim} />
}

/* ═══════════════════════════════════════════════════════════════════
   Planner-mode view — hierarchical pipeline / step / child / iter
   ═══════════════════════════════════════════════════════════════════ */

function PlannerView({ trace }: { trace: TraceEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [trace.length])

  const grouped = useMemo(() => groupTraceForPlanner(trace), [trace])

  return (
    <div ref={ref} className="h-full overflow-y-auto px-2 py-2 font-mono" style={{ fontSize: 13 }}>
      {grouped.preamble.map((e, i) => (
        <PreambleRow key={`pre-${i}`} entry={e} />
      ))}
      {grouped.pipelines.map((p, pi) => (
        <div key={`pipe-${pi}`}>
          <PipelineBlock pipeline={p} />
          {(p.verification || p.aftermath.length > 0) && (
            <PostPipelineBlock pipeline={p} />
          )}
        </div>
      ))}
      {grouped.trailing.length > 0 && (
        <TrailingSection events={grouped.trailing} />
      )}
    </div>
  )
}

function PipelineBlock({ pipeline: p }: { pipeline: PipelineGroup }) {
  const [open, setOpen] = useState(true)
  const en = p.end
  const statusColor = en
    ? (en.status === "completed" ? C.success : C.coral)
    : C.accent

  return (
    <div className="mb-1">
      <TreeRow onClick={() => setOpen(!open)} open={open}
        label={`PIPELINE · attempt ${p.start.attempt}/${p.start.maxRetries}`}
        labelColor="#C084FC"
      />
      {open && (
        <div className="ml-4">
          {p.steps.map((s, si) => (
            <PlannerStepBlock key={si} step={s} index={si + 1} />
          ))}
          {en && (
            <FlatRow
              label={en.status} labelColor={statusColor}
              detail={`${en.completedSteps} of ${en.totalSteps} steps completed`}
            />
          )}
        </div>
      )}
    </div>
  )
}

function PostPipelineBlock({ pipeline: p }: { pipeline: PipelineGroup }) {
  const [open, setOpen] = useState(true)

  return (
    <div className="mb-1">
      <TreeRow
        onClick={() => setOpen(!open)}
        open={open}
        label={`POST-PIPELINE · after attempt ${p.start.attempt}/${p.start.maxRetries}`}
        labelColor={C.dim}
      />
      {open && (
        <div className="ml-4">
          {p.verification && <VerificationBlock verification={p.verification} />}
          {p.aftermath.map((e, i) => (
            <PreambleRow key={`aft-${p.start.attempt}-${i}`} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function VerificationBlock({ verification: v }: { verification: VerificationGroup }) {
  const [open, setOpen] = useState(true)
  const result = v.result
  const overall = result?.overall ?? "running"
  const color = overall === "pass" ? C.success : overall === "retry" ? C.warning : overall === "running" ? C.accent : C.coral

  return (
    <div className="mb-0.5">
      <TreeRow onClick={() => setOpen(!open)} open={open}
        label="VERIFY" labelColor={color}
        detail={result
          ? `${overall} · ${(result.confidence * 100).toFixed(0)}% confidence${v.probes.length > 0 ? ` · ${v.probes.filter(e => e.kind === "tool-call").length} probes` : ""}`
          : `${v.probes.filter(e => e.kind === "tool-call").length} probes running`
        }
      />
      {open && (
        <div className="ml-4">
          {v.probes.map((e, i) => (
            <IterEventRow key={`probe-${i}`} entry={e} />
          ))}
          {result && result.steps.length > 0 && (
            <div className="mt-0.5">
              {result.steps.map((s, i) => {
                const sColor = s.outcome === "pass" ? C.success : s.outcome === "fail" ? C.coral : C.warning
                return (
                  <div key={i} className="py-0.5 pl-2" style={{ borderLeft: `2px solid ${sColor}40` }}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold" style={{ color: sColor }}>{s.outcome}</span>
                      <span style={{ color: C.text }}>{s.stepName}</span>
                    </div>
                    {s.issues.length > 0 && (
                      <div className="ml-2 mt-0.5 space-y-1">
                        {s.issues.map((issue, ii) => (
                          <ExpandableMessage key={ii} label="ISSUE" text={issue} color={C.dim} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PlannerStepBlock({ step: s, index }: { step: StepGroup; index: number }) {
  const [open, setOpen] = useState(true)
  const en = s.end
  const status = en?.status ?? "running"
  const statusColor = status === "completed" ? C.success : status === "running" ? C.accent : C.coral
  const duration = en?.durationMs

  const detail = [s.start.stepType, status !== "running" ? status : null, duration != null ? `${duration}ms` : null]
    .filter(Boolean).join(" · ")

  // Show failure reason from validation code or error
  const failReason = en && status === "failed"
    ? (en.error ?? (en.validationCode ? remediationHintForValidationCode(en.validationCode) : null))
    : null
  const failHint = en && status === "failed" && en.validationCode
    ? remediationHintForValidationCode(en.validationCode)
    : null

  // Did the child report "done" but pipeline validation rejected it?
  const childClaimedDone = s.childEnd?.status === "done"
  const overridden = childClaimedDone && status === "failed"

  return (
    <div className="mb-0.5">
      <TreeRow onClick={() => setOpen(!open)} open={open}
        label={`STEP ${index} · ${s.start.stepName}`}
        labelColor={statusColor}
        detail={detail}
      />
      {open && (
        <div className="ml-4">
          {s.childStart && (
            <PlannerChildBlock start={s.childStart} end={s.childEnd} iterations={s.iterations} />
          )}
          {overridden && failReason && (
            <div className="py-0.5 px-2 text-[13px] space-y-1" style={{ color: C.coral }}>
              <ExpandableMessage label="VALIDATION REJECTED" text={failReason} color={C.coral} />
              {failHint && failHint !== failReason && (
                <div className="pl-1" style={{ color: C.dim }}>{failHint}</div>
              )}
            </div>
          )}
          {!overridden && failReason && (
            <div className="py-0.5 px-2 text-[13px] space-y-1" style={{ color: C.coral }}>
              <ExpandableMessage label="FAIL" text={failReason} color={C.coral} />
              {failHint && failHint !== failReason && (
                <div className="pl-1" style={{ color: C.dim }}>{failHint}</div>
              )}
            </div>
          )}
          {s.events.map((e, i) => (
            <IterEventRow key={`ev-${i}`} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function PlannerChildBlock({ start, end, iterations }: {
  start: Extract<TraceEntry, { kind: "planner-delegation-start" }>
  end: Extract<TraceEntry, { kind: "planner-delegation-end" }> | null
  iterations: IterGroup[]
}) {
  const [open, setOpen] = useState(true)
  const ok = end?.status === "done"

  return (
    <div className="mb-0.5">
      <TreeRow onClick={() => setOpen(!open)} open={open}
        label="CHILD AGENT" labelColor="#E879A8"
        detail={truncate(start.goal, 80)}
      />
      {open && (
        <div className="ml-4">
          {iterations.map((iter, ii) => (
            <PlannerIterBlock key={ii} iter={iter} />
          ))}
          {end && (
            <ChildResultRow ok={ok} end={end} />
          )}
        </div>
      )}
    </div>
  )
}

/** Expandable child agent result — shows full answer/error text on click */
function ChildResultRow({ ok, end }: {
  ok: boolean
  end: Extract<TraceEntry, { kind: "planner-delegation-end" }>
}) {
  const [expanded, setExpanded] = useState(false)
  const fullText = end.answer || end.error || ""
  return (
    <div>
      <TreeRow
        onClick={() => setExpanded(!expanded)}
        open={expanded}
        label={ok ? "done" : (end.status ?? "error")}
        labelColor={ok ? C.success : C.coral}
        detail={!expanded ? truncate(fullText, 80) : undefined}
      />
      {expanded && fullText && (
        <div className="ml-5 py-0.5"><Pane text={fullText} maxH={400} /></div>
      )}
    </div>
  )
}

function PlannerIterBlock({ iter }: { iter: IterGroup }) {
  const [open, setOpen] = useState(false)
  const m = iter.marker
  const toolCalls = iter.events.filter((e) => e.kind === "tool-call").length
  const nudges = iter.events.filter((e) => e.kind === "nudge").length
  const hasLlmReq = iter.events.some((e) => e.kind === "llm-request")
  const detail = [
    toolCalls > 0 ? `${toolCalls} tool call${toolCalls > 1 ? "s" : ""}` : null,
    nudges > 0 ? `${nudges} nudge${nudges > 1 ? "s" : ""}` : null,
    !toolCalls && !hasLlmReq && iter.events.length === 0 ? "(no tools)" : null,
    !toolCalls && iter.events.length > 0 && !hasLlmReq ? `${iter.events.length} event${iter.events.length > 1 ? "s" : ""}` : null,
  ].filter(Boolean).join(" · ")

  // Color red for empty iterations (agent spun without acting)
  const iterColor = iter.events.length === 0 ? C.warning : "#E879A8"

  return (
    <div>
      <TreeRow onClick={() => setOpen(!open)} open={open}
        label={`ITER ${m.iteration}/${m.maxIterations}`}
        labelColor={iterColor} detail={detail}
      />
      {open && iter.events.length > 0 && (
        <div className="ml-4">
          {iter.events.map((e, i) => (
            <IterEventRow key={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function IterEventRow({ entry: e }: { entry: TraceEntry }) {
  if (e.kind === "tool-call" || e.kind === "tool-result" || e.kind === "tool-error" || e.kind === "thinking") {
    return <ExecutionRow entry={e} />
  }

  if (e.kind === "llm-request") {
    const req = e as Extract<TraceEntry, { kind: "llm-request" }>
    return <RequestSection2 messages={req.messages} toolCount={req.toolCount} />
  }

  if (e.kind === "llm-response") {
    const resp = e as Extract<TraceEntry, { kind: "llm-response" }>
    return <ResponseSection2 response={resp} />
  }

  if (e.kind === "nudge") {
    return <ExecutionRow entry={e} />
  }

  if (e.kind === "usage") {
    return <UsageRow2 usage={e as Extract<TraceEntry, { kind: "usage" }>} />
  }

  if (e.kind === "workspace_diff" || e.kind === "workspace_diff_applied") {
    return <PreambleRow entry={e} />
  }

  return <PreambleRow entry={e} />
}

/* ── REQUEST section — all messages sent to the LLM ── */

function RequestSection2({ messages, toolCount }: {
  messages: Array<{
    role: string
    content: string | null
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    toolCallId: string | null
  }>
  toolCount: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
        onClick={() => setOpen(!open)}
        style={{
          borderLeft: `2px solid ${C.accent}`,
          background: open ? "rgba(255,255,255,0.015)" : undefined,
        }}
      >
        <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-semibold" style={{ color: C.accent }}>REQUEST</span>
        <span style={{ color: C.dim }}>{messages.length} messages · {toolCount} tool definitions</span>
      </div>
      {open && (
        <div className="ml-3" style={{ borderLeft: `1px solid ${C.border}` }}>
          {messages.map((msg, i) => (
            <MessageRow2 key={i} msg={msg} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── RESPONSE section — what the LLM returned ── */

function ResponseSection2({ response: resp }: {
  response: Extract<TraceEntry, { kind: "llm-response" }>
}) {
  const [open, setOpen] = useState(false)
  const usage = resp.usage
  const usageStr = usage
    ? `${fmtTokens(usage.promptTokens)} prompt + ${fmtTokens(usage.completionTokens)} completion = ${fmtTokens(usage.totalTokens)} total`
    : null
  const tcCount = resp.toolCalls.length
  const tcStr = tcCount > 0 ? `→ ${tcCount} tool call${tcCount > 1 ? "s" : ""}` : null

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
        onClick={() => setOpen(!open)}
        style={{
          borderLeft: `2px solid ${C.success}`,
          background: open ? "rgba(255,255,255,0.015)" : undefined,
        }}
      >
        <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-semibold" style={{ color: C.success }}>RESPONSE</span>
        <span style={{ color: C.dim }}>{[usageStr, `${resp.durationMs}ms`, tcStr].filter(Boolean).join(" · ")}</span>
      </div>
      {open && (resp.content || resp.toolCalls.length > 0) && (
        <div className="ml-3 py-1 space-y-1" style={{ borderLeft: `1px solid ${C.border}` }}>
          {resp.content && (
            <div className="px-2">
              <div style={{ color: C.dim }} className="mb-0.5">content:</div>
              <Pane text={resp.content} />
            </div>
          )}
          {resp.toolCalls.length > 0 && (
            <div className="px-2">
              <div style={{ color: C.dim }} className="mb-0.5">tool calls:</div>
              {resp.toolCalls.map((tc, i) => (
                <ToolCallInline key={tc.id || `tc-${i}`} tc={tc} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── EXECUTION section — tool calls, results, errors ── */

function ExecutionSection({ events }: { events: TraceEntry[] }) {
  const [open, setOpen] = useState(false)
  const calls = events.filter((e) => e.kind === "tool-call").length
  const errors = events.filter((e) => e.kind === "tool-error").length
  const nudges = events.filter((e) => e.kind === "nudge").length

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
        onClick={() => setOpen(!open)}
        style={{
          borderLeft: `2px solid ${C.warning}`,
          background: open ? "rgba(255,255,255,0.015)" : undefined,
        }}
      >
        <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-semibold" style={{ color: C.warning }}>EXECUTION</span>
        <span style={{ color: C.dim }}>
          {calls} tool call{calls !== 1 ? "s" : ""}
          {errors > 0 && <span style={{ color: C.coral }}> · {errors} error{errors !== 1 ? "s" : ""}</span>}
          {nudges > 0 && <span style={{ color: "#FF6B6B" }}> · {nudges} nudge{nudges !== 1 ? "s" : ""}</span>}
        </span>
      </div>
      {open && (
        <div className="ml-3" style={{ borderLeft: `1px solid ${C.border}` }}>
          {events.map((e, i) => (
            <ExecutionRow key={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Usage summary row ── */

function UsageRow2({ usage: u }: { usage: Extract<TraceEntry, { kind: "usage" }> }) {
  return (
    <div className="flex items-center gap-2 py-0.5 px-2" style={{ color: C.dim }}>
      <span style={{ width: 10, flexShrink: 0 }} />
      <span>USAGE</span>
      <span>+{fmtK(u.iterationTokens)} tk · total {fmtK(u.totalTokens)} · {fmtTokens(u.promptTokens)} prompt + {fmtTokens(u.completionTokens)} completion · {u.llmCalls} calls</span>
    </div>
  )
}

/* ── Trailing events (after last LLM call — answer, errors) ── */

function TrailingSection({ events }: { events: TraceEntry[] }) {
  return (
    <div className="mt-1 space-y-0.5">
      {events.map((e, i) => (
        <TrailingRow key={i} entry={e} />
      ))}
    </div>
  )
}

function TrailingRow({ entry: e }: { entry: TraceEntry }) {
  const [open, setOpen] = useState(false)

  if (e.kind === "answer") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="ANSWER" labelColor={C.success}
          detail={!open ? truncate(e.text, 120) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} /></div>}
      </div>
    )
  }

  if (e.kind === "error") {
    return (
      <div>
        <TreeRow onClick={() => setOpen(!open)} open={open}
          label="ERROR" labelColor={C.coral}
          detail={!open ? truncate(e.text, 120) : undefined}
        />
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} color={C.coral} /></div>}
      </div>
    )
  }

  // Reuse PreambleRow for anything else
  return <PreambleRow entry={e} />
}

/* ═══════════════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════════════ */

/* ── Message row (inside REQUEST section) ── */

const ROLE_COLORS: Record<string, string> = {
  system: C.accent,
  user: C.success,
  assistant: C.warning,
  tool: "#6CB4EE",
}

function MessageRow2({ msg, index }: {
  msg: {
    role: string
    content: string | null
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    toolCallId: string | null
  }
  index: number
}) {
  const [open, setOpen] = useState(false)
  const roleColor = ROLE_COLORS[msg.role] ?? C.dim
  const charCount = msg.content?.length ?? 0
  const hasToolCalls = msg.toolCalls.length > 0

  const detail = [
    `#${index}`,
    charCount > 0 ? `${charCount} chars` : null,
    hasToolCalls ? `${msg.toolCalls.length} tool calls` : null,
  ].filter(Boolean).join("  ")

  return (
    <div className="px-1">
      <div
        className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
        onClick={() => setOpen(!open)}
      >
        <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-bold" style={{ color: roleColor }}>{msg.role.toUpperCase()}</span>
        <span style={{ color: C.dim }}>{detail}</span>
        {msg.toolCallId && <span style={{ color: C.dim }}>← {msg.toolCallId}</span>}
      </div>
      {open && (
        <div className="ml-5 space-y-1 py-0.5">
          {msg.content && <Pane text={msg.content} />}
          {msg.toolCalls.map((tc, tci) => (
            <ToolCallInline key={tc.id || `tc-${tci}`} tc={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Tool call inline display (in response + request messages) ── */

function ToolCallInline({ tc }: {
  tc: { id: string; name: string; arguments: Record<string, unknown> }
}) {
  const [open, setOpen] = useState(false)
  const summary = Object.entries(tc.arguments)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${truncate(v, 30)}"` : JSON.stringify(v)}`)
    .join(", ")

  return (
    <div>
      <div
        className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
        onClick={() => setOpen(!open)}
      >
        <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="font-semibold" style={{ color: C.warning }}>{tc.name}</span>
        {!open && <span className="truncate" style={{ color: C.dim }}>{summary}</span>}
        {open && <span style={{ color: C.dim }}>{tc.id}</span>}
      </div>
      {open && (
        <div className="ml-5 py-0.5">
          <Pane text={JSON.stringify(tc.arguments, null, 2)} />
        </div>
      )}
    </div>
  )
}

/* ── Execution row (tool-call / tool-result / tool-error / thinking) ── */

function ExecutionRow({ entry: e }: { entry: TraceEntry }) {
  const [open, setOpen] = useState(false)

  if (e.kind === "tool-call") {
    return (
      <div className="px-1">
        <div
          className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
          onClick={() => setOpen(!open)}
        >
          <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
            {open ? "▾" : "▸"}
          </span>
          <span className="font-semibold" style={{ color: C.warning }}>{e.tool}</span>
          {!open && <span className="truncate" style={{ color: C.dim }}>{e.argsSummary}</span>}
        </div>
        {open && <div className="ml-5 py-0.5"><Pane text={e.argsFormatted} /></div>}
      </div>
    )
  }

  if (e.kind === "tool-result") {
    return (
      <div className="px-1">
        <div
          className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
          onClick={() => setOpen(!open)}
        >
          <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
            {open ? "▾" : "▸"}
          </span>
          <span className="font-semibold" style={{ color: C.success }}>TOOL RESULT</span>
          {!open && <span className="truncate" style={{ color: C.dim }}>{truncate(e.text, 100)}</span>}
          {open && <span style={{ color: C.dim }}>{e.text.length} chars</span>}
        </div>
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} /></div>}
      </div>
    )
  }

  if (e.kind === "tool-error") {
    return (
      <div className="px-1">
        <div
          className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
          onClick={() => setOpen(!open)}
        >
          <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
            {open ? "▾" : "▸"}
          </span>
          <span className="font-semibold" style={{ color: C.coral }}>TOOL ERROR</span>
          {!open && <span className="truncate" style={{ color: C.coral }}>{truncate(e.text, 100)}</span>}
        </div>
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} color={C.coral} /></div>}
      </div>
    )
  }

  if (e.kind === "thinking") {
    return (
      <div className="px-1">
        <div
          className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
          onClick={() => setOpen(!open)}
        >
          <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
            {open ? "▾" : "▸"}
          </span>
          <span className="font-semibold" style={{ color: C.accent }}>THINKING</span>
          {!open && <span className="truncate" style={{ color: C.dim }}>{truncate(e.text, 100)}</span>}
          {open && <span style={{ color: C.dim }}>{e.text.length} chars</span>}
        </div>
        {open && <div className="ml-5 py-0.5"><Pane text={e.text} /></div>}
      </div>
    )
  }

  if (e.kind === "nudge") {
    return (
      <div className="px-1">
        <div
          className="flex items-center gap-2 py-0.5 px-2 cursor-pointer rounded transition-colors hover:bg-white/[0.03]"
          onClick={() => setOpen(!open)}
        >
          <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
            {open ? "▾" : "▸"}
          </span>
          <span className="font-semibold" style={{ color: "#FF6B6B" }}>NUDGE</span>
          <span style={{ color: "#FF6B6B", opacity: 0.7 }}>{e.tag}</span>
          {!open && <span className="truncate" style={{ color: C.dim }}>{truncate(e.message, 80)}</span>}
        </div>
        {open && <div className="ml-5 py-0.5"><Pane text={e.message} color="#FF6B6B" /></div>}
      </div>
    )
  }

  return null
}

/* ═══════════════════════════════════════════════════════════════════
   Shared primitives
   ═══════════════════════════════════════════════════════════════════ */

/** Collapsible tree row — disclosure arrow + label + detail */
function TreeRow({ onClick, open, label, labelColor, detail }: {
  onClick: () => void
  open: boolean
  label: string
  labelColor: string
  detail?: string
}) {
  return (
    <div
      className="flex items-center gap-2 py-1 px-2 cursor-pointer rounded hover:bg-white/[0.03] transition-colors"
      onClick={onClick}
      style={{ fontSize: 13 }}
    >
      <span style={{ color: C.dim, width: 10, flexShrink: 0, textAlign: "center" }}>
        {open ? "▾" : "▸"}
      </span>
      <span className="font-semibold whitespace-nowrap" style={{ color: labelColor }}>{label}</span>
      {detail && <span className="truncate" style={{ color: C.dim }}>{detail}</span>}
    </div>
  )
}

/** Non-collapsible row — spacer + label + detail */
function FlatRow({ label, labelColor, detail }: {
  label: string
  labelColor: string
  detail?: string
}) {
  return (
    <div className="flex items-center gap-2 py-1 px-2" style={{ fontSize: 13 }}>
      <span style={{ width: 10, flexShrink: 0 }} />
      <span className="font-semibold whitespace-nowrap" style={{ color: labelColor }}>{label}</span>
      {detail && <span className="truncate" style={{ color: C.dim }}>{detail}</span>}
    </div>
  )
}

function ExpandableMessage({
  label,
  text,
  color,
  preview = 140,
}: {
  label?: string
  text: string
  color: string
  preview?: number
}) {
  const compact = text.length > preview ? truncate(text, preview) : text
  return (
    <details className="rounded" style={{ border: `1px solid ${C.border}`, background: C.base }}>
      <summary className="cursor-pointer list-none px-2 py-1.5 text-[13px]" style={{ color }}>
        {label ? <span className="font-semibold mr-1.5">{label}</span> : null}
        <span>{compact}</span>
        {text.length > preview ? <span style={{ color: C.dim }}> click to expand</span> : null}
      </summary>
      <pre
        className="whitespace-pre-wrap break-words px-2 pb-2 text-[13px] overflow-auto"
        style={{ color, maxHeight: 220 }}
      >
        {text}
      </pre>
    </details>
  )
}

/** Scrollable content pane */
function Pane({ text, maxH = 400, color }: { text: string; maxH?: number; color?: string }) {
  return (
    <pre
      className="whitespace-pre-wrap break-words p-2 rounded overflow-auto"
      style={{
        fontSize: 13,
        color: color ?? C.textSecondary,
        background: C.base,
        border: `1px solid ${C.border}`,
        maxHeight: maxH,
      }}
    >
      {text}
    </pre>
  )
}

// ── MapPanel — force-directed agent/tool graph ───────────────────

import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d"
import ForceGraph2D from "react-force-graph-2d"

const AGENT_COLORS = [C.accent, "#D17877", "#F49D6C", "#EA6248", C.success, C.plum, "#6CB4EE", "#B8A9C9"]

const MAP_TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  list_directory: "List",
  run_command: "Shell",
  fetch_url: "Fetch",
  delegate: "Delegate",
  browse_web: "Browse",
  browser_check: "BrChk",
  ask_user: "Ask",
}
function mapToolLabel(id: string): string {
  return MAP_TOOL_LABELS[id] ?? id.slice(0, 8)
}

interface MapNode {
  id: string
  type: "agent" | "tool" | "delegate" | "planstep" | "planner-child"
  label: string
  color: string
  agentId?: string
  toolId?: string
  delegateDepth?: number
  delegateStatus?: "active" | "done" | "error"
  planStepType?: string
  plannerChildGoal?: string
  plannerChildTools?: string[]
  plannerChildUsedTools?: string[]
  val?: number
  x?: number
  y?: number
}

interface MapLink {
  source: string
  target: string
  agentId: string
  color: string
}

export function MapPanel({
  trace,
  run,
  agents,
}: {
  trace: TraceEntry[]
  run: Run | undefined
  agents: AgentDefinition[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraphMethods<NodeObject<MapNode>, LinkObject<MapNode, MapLink>>>(undefined)
  const [size, setSize] = useState({ w: 600, h: 400 })
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const prevTraceLen = useRef(0)
  const [zoomLevel, setZoomLevel] = useState(100)
  const zoomBaseRef = useRef(1)
  const animPhaseRef = useRef(0)
  const rafRef = useRef<number>(0)
  const autoFitTimerRef = useRef<number | null>(null)

  const isRunning = run?.status === "running"
  const activeAgentId = run?.agentId ?? null

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  // Tool stats from trace
  const toolStats = useMemo(() => {
    const stats = new Map<string, { calls: number; errors: number; lastStatus: "idle" | "running" | "done" | "error" }>()
    let currentTool: string | null = null
    for (const entry of trace) {
      if (entry.kind === "tool-call") {
        currentTool = entry.tool
        const s = stats.get(entry.tool) ?? { calls: 0, errors: 0, lastStatus: "idle" as const }
        s.calls++
        s.lastStatus = "running"
        stats.set(entry.tool, s)
      } else if (entry.kind === "tool-result" && currentTool) {
        const s = stats.get(currentTool)
        if (s) s.lastStatus = "done"
        currentTool = null
      } else if (entry.kind === "tool-error" && currentTool) {
        const s = stats.get(currentTool)
        if (s) { s.errors++; s.lastStatus = "error" }
        currentTool = null
      }
    }
    // If the run is no longer active, resolve any lingering "running" tools
    if (!isRunning) {
      for (const s of stats.values()) {
        if (s.lastStatus === "running") s.lastStatus = "done"
      }
    }
    return stats
  }, [trace, isRunning])

  // Stabilised involved tool IDs
  const prevInvolvedRef = useRef<Set<string>>(new Set())
  const involvedToolIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of trace) {
      if (entry.kind === "tool-call") ids.add(entry.tool)
    }
    const prev = prevInvolvedRef.current
    if (ids.size === prev.size && [...ids].every(id => prev.has(id))) return prev
    prevInvolvedRef.current = ids
    return ids
  }, [trace])

  // Stabilised delegations
  const prevDelegRef = useRef<Array<{ key: string; depth: number; goal: string; tools: string[]; status: "active" | "done" | "error" }>>([])
  const traceDelegations = useMemo(() => {
    const all: Array<{ key: string; depth: number; goal: string; tools: string[]; status: "active" | "done" | "error" }> = []
    const active: number[] = []
    for (const e of trace) {
      if (e.kind === "delegation-start") {
        const idx = all.length
        all.push({ key: `d${idx}`, depth: e.depth, goal: e.goal, tools: e.tools, status: "active" })
        active.push(idx)
      } else if (e.kind === "delegation-end") {
        for (let j = active.length - 1; j >= 0; j--) {
          if (all[active[j]].depth === e.depth) {
            all[active[j]].status = e.status === "error" ? "error" : "done"
            active.splice(j, 1)
            break
          }
        }
      }
    }
    const prev = prevDelegRef.current
    if (prev.length === all.length && prev.every((d, i) => d.key === all[i].key && d.status === all[i].status)) return prev
    prevDelegRef.current = all
    return all
  }, [trace])

  // Stabilised planner step nodes
  const prevPlanStepsRef = useRef<Array<{ key: string; name: string; type: string; status: "active" | "done" | "error" }>>([])
  const tracePlanSteps = useMemo(() => {
    const all: Array<{ key: string; name: string; type: string; status: "active" | "done" | "error" }> = []
    for (const e of trace) {
      if (e.kind === "planner-step-start" && e.stepType !== "subagent_task") {
        all.push({ key: `ps${all.length}`, name: e.stepName, type: e.stepType, status: "active" })
      } else if (e.kind === "planner-step-end") {
        for (let j = all.length - 1; j >= 0; j--) {
          if (all[j].name === e.stepName && all[j].status === "active") {
            all[j].status = e.status === "completed" ? "done" : "error"
            break
          }
        }
      }
    }
    const prev = prevPlanStepsRef.current
    if (prev.length === all.length && prev.every((s, i) => s.key === all[i].key && s.status === all[i].status)) return prev
    prevPlanStepsRef.current = all
    return all
  }, [trace])

  // Stabilised planner child agents (subagent_task delegations)
  const prevPlanChildRef = useRef<Array<{
    key: string; name: string; goal: string; tools: string[];
    usedTools: string[]; status: "active" | "done" | "error"
  }>>([])
  const tracePlannerChildren = useMemo(() => {
    const all: Array<{
      key: string; name: string; goal: string; tools: string[];
      usedTools: string[]; status: "active" | "done" | "error"
    }> = []
    const activeByStep = new Map<string, number>()
    let lastActiveStep: string | null = null
    for (const e of trace) {
      if (e.kind === "planner-delegation-start") {
        const idx = all.length
        all.push({
          key: `pc${idx}`, name: e.stepName, goal: e.goal,
          tools: e.tools, usedTools: [], status: "active",
        })
        activeByStep.set(e.stepName, idx)
        lastActiveStep = e.stepName
      } else if (e.kind === "planner-delegation-end") {
        const idx = activeByStep.get(e.stepName)
        if (idx != null) {
          all[idx].status = e.status === "done" ? "done" : "error"
          activeByStep.delete(e.stepName)
          if (lastActiveStep === e.stepName) lastActiveStep = null
        }
      } else if (e.kind === "planner-delegation-iteration") {
        lastActiveStep = e.stepName
      } else if (e.kind === "llm-response" && lastActiveStep != null) {
        const idx = activeByStep.get(lastActiveStep)
        if (idx != null && e.toolCalls) {
          for (const tc of e.toolCalls) {
            if (!all[idx].usedTools.includes(tc.name)) {
              all[idx].usedTools.push(tc.name)
            }
          }
        }
      }
    }
    const prev = prevPlanChildRef.current
    if (prev.length === all.length && prev.every((c, i) =>
      c.key === all[i].key && c.status === all[i].status &&
      c.usedTools.length === all[i].usedTools.length
    )) return prev
    prevPlanChildRef.current = all
    return all
  }, [trace])

  // Extract plan DAG from trace (if planner generated a plan)
  const planDag = useMemo(() => {
    for (const e of trace) {
      if (e.kind === "planner-plan-generated") {
        const edges: Array<{ from: string; to: string }> = e.edges ?? []
        // Fallback: derive edges from dependsOn if edges not emitted
        if (edges.length === 0) {
          for (const step of e.steps) {
            if (step.dependsOn) {
              for (const dep of step.dependsOn) {
                edges.push({ from: dep, to: step.name })
              }
            }
          }
        }
        return { steps: e.steps, edges }
      }
    }
    return null
  }, [trace])

  // Unified step status tracking for DAG view
  const planStepStatuses = useMemo(() => {
    const statuses = new Map<string, {
      status: "pending" | "active" | "done" | "error"
      iteration?: number; maxIterations?: number; durationMs?: number
    }>()
    for (const e of trace) {
      if (e.kind === "planner-step-start") {
        statuses.set(e.stepName, { status: "active" })
      } else if (e.kind === "planner-step-end") {
        const existing = statuses.get(e.stepName)
        statuses.set(e.stepName, {
          status: e.status === "completed" ? "done" : "error",
          iteration: existing?.iteration, maxIterations: existing?.maxIterations,
          durationMs: e.durationMs,
        })
      } else if (e.kind === "planner-delegation-iteration") {
        const existing = statuses.get(e.stepName)
        if (existing) {
          existing.iteration = e.iteration
          existing.maxIterations = e.maxIterations
        }
      }
    }
    return statuses
  }, [trace])

  const hasRunContext = activeAgentId != null && trace.length > 0

  // Build graph — stabilised topology
  const prevGraphRef = useRef<{ nodes: MapNode[]; links: MapLink[] }>({ nodes: [], links: [] })
  const graphData = useMemo(() => {
    const nodes: MapNode[] = []
    const links: MapLink[] = []
    const toolNodeIds = new Set<string>()

    if (planDag) {
      // ═══ WORKFLOW DAG MODE ═══
      // When the planner generated a plan, show it as a proper top-down workflow DAG.
      // Agent at top → steps connected by dependency edges → no tool clutter.
      const agentDef = agents.find(a => a.id === activeAgentId) ?? agents[0]
      const agentColor = AGENT_COLORS[0]
      const agentNodeId = `agent:${agentDef?.id ?? "0"}`

      nodes.push({
        id: agentNodeId, type: "agent", label: agentDef?.name ?? "Agent",
        color: agentColor, agentId: agentDef?.id, val: 6,
      })

      const hasIncoming = new Set(planDag.edges.map(e => e.to))

      for (const step of planDag.steps) {
        const nodeId = `step:${step.name}`
        const isChild = step.type === "subagent_task"
        const stepStatus = planStepStatuses.get(step.name)
        const childData = tracePlannerChildren.find(c => c.name === step.name)

        nodes.push({
          id: nodeId,
          type: isChild ? "planner-child" : "planstep",
          label: step.name,
          color: stepStatus?.status === "error" ? C.coral : "#A78BFA",
          delegateStatus: stepStatus?.status === "active" ? "active" : stepStatus?.status === "done" ? "done" : stepStatus?.status === "error" ? "error" : undefined,
          planStepType: step.type,
          plannerChildGoal: childData?.goal,
          plannerChildTools: childData?.tools,
          plannerChildUsedTools: childData?.usedTools,
          val: isChild ? 5 : 4,
        })

        // Root steps (no incoming edges) link from the agent
        if (!hasIncoming.has(step.name)) {
          links.push({
            source: agentNodeId, target: nodeId,
            agentId: agentDef?.id ?? "", color: agentColor + "50",
          })
        }
      }

      // DAG dependency edges between steps
      for (const edge of planDag.edges) {
        const fromStatus = planStepStatuses.get(edge.from)?.status
        const edgeColor = fromStatus === "done" ? C.success + "40" : fromStatus === "error" ? C.coral + "40" : "#A78BFA30"
        links.push({
          source: `step:${edge.from}`, target: `step:${edge.to}`,
          agentId: "", color: edgeColor,
        })
      }
    } else {
      // ═══ FORCE-DIRECTED MODE (no planner) ═══
    agents.forEach((agent, idx) => {
      const agentColor = AGENT_COLORS[idx % AGENT_COLORS.length]
      const agentNodeId = `agent:${agent.id}`

      nodes.push({
        id: agentNodeId, type: "agent", label: agent.name, color: agentColor,
        agentId: agent.id, val: 5, x: -60, y: (idx - (agents.length - 1) / 2) * 50,
      })

      for (const toolId of agent.tools) {
        const toolNodeId = `tool:${toolId}`
        if (!toolNodeIds.has(toolNodeId)) {
          const toolIdx = toolNodeIds.size
          toolNodeIds.add(toolNodeId)
          nodes.push({
            id: toolNodeId, type: "tool", label: mapToolLabel(toolId), color: C.dim,
            toolId, val: 3, x: 60, y: (toolIdx - 2.5) * 40,
          })
        }
        links.push({ source: agentNodeId, target: `tool:${toolId}`, agentId: agent.id, color: agentColor })
      }

      // Runtime-injected tools from trace
      for (const toolId of involvedToolIds) {
        const toolNodeId = `tool:${toolId}`
        if (!toolNodeIds.has(toolNodeId)) {
          const toolIdx = toolNodeIds.size
          toolNodeIds.add(toolNodeId)
          nodes.push({
            id: toolNodeId, type: "tool", label: mapToolLabel(toolId), color: C.dim,
            toolId, val: 3, x: 60, y: (toolIdx - 2.5) * 40,
          })
        }
        if (!links.some(l => l.source === agentNodeId && (typeof l.target === "string" ? l.target : (l.target as MapNode).id) === toolNodeId)) {
          links.push({ source: agentNodeId, target: toolNodeId, agentId: agent.id, color: agentColor })
        }
      }
    })

    // Delegation nodes
    for (const deleg of traceDelegations) {
      const delegId = `delegate:${deleg.key}`
      const baseColor = AGENT_COLORS[(agents.length + deleg.depth) % AGENT_COLORS.length]
      const color = deleg.status === "error" ? C.coral : baseColor
      const delegIndex = traceDelegations.indexOf(deleg)
      nodes.push({
        id: delegId, type: "delegate", label: `D${delegIndex + 1}`, color,
        delegateDepth: deleg.depth, delegateStatus: deleg.status,
        val: 4, x: -30, y: (agents.length + deleg.depth - 1) * 50,
      })
      if (activeAgentId) {
        links.push({ source: `agent:${activeAgentId}`, target: delegId, agentId: activeAgentId, color })
      }
      for (const toolName of deleg.tools) {
        if (toolName === "delegate") continue
        const toolNodeId = `tool:${toolName}`
        if (toolNodeIds.has(toolNodeId)) {
          links.push({ source: delegId, target: toolNodeId, agentId: activeAgentId ?? "", color: color + "80" })
        }
      }
    }

    // Planner deterministic step nodes (small rectangles for inline tool executions)
    for (const ps of tracePlanSteps) {
      const psId = `planstep:${ps.key}`
      const color = ps.status === "active" ? "#C084FC" : ps.status === "error" ? C.coral : "#C084FC"
      nodes.push({
        id: psId, type: "planstep", label: ps.name, color,
        delegateDepth: 1, delegateStatus: ps.status, planStepType: ps.type,
        val: 3, x: -30, y: (agents.length + traceDelegations.length + tracePlanSteps.indexOf(ps)) * 50,
      })
      if (activeAgentId) {
        links.push({ source: `agent:${activeAgentId}`, target: psId, agentId: activeAgentId, color: color + "60" })
      }
    }

    // Planner child agent nodes (circles — spawned subagent_task delegations)
    for (const pc of tracePlannerChildren) {
      const pcId = `planner-child:${pc.key}`
      const baseColor = "#A78BFA"
      const color = pc.status === "error" ? C.coral : baseColor
      const childIdx = tracePlannerChildren.indexOf(pc)
      nodes.push({
        id: pcId, type: "planner-child", label: pc.name, color,
        delegateStatus: pc.status,
        plannerChildGoal: pc.goal,
        plannerChildTools: pc.tools,
        plannerChildUsedTools: pc.usedTools,
        val: 5, x: -20,
        y: (agents.length + traceDelegations.length + tracePlanSteps.length + childIdx - 1) * 50,
      })
      // Link from main agent → child (spawning relationship)
      if (activeAgentId) {
        links.push({
          source: `agent:${activeAgentId}`, target: pcId,
          agentId: activeAgentId, color: color + "80",
        })
      }
      // Links from child → tools it actually used (or assigned tools if none used yet)
      const toolsToShow = pc.usedTools.length > 0 ? pc.usedTools : pc.tools
      for (const toolName of toolsToShow) {
        if (toolName === "delegate" || toolName === "delegate_parallel") continue
        const toolNodeId = `tool:${toolName}`
        if (!toolNodeIds.has(toolNodeId)) {
          const toolIdx = toolNodeIds.size
          toolNodeIds.add(toolNodeId)
          nodes.push({
            id: toolNodeId, type: "tool", label: mapToolLabel(toolName), color: C.dim,
            toolId: toolName, val: 3, x: 60, y: (toolIdx - 2.5) * 40,
          })
        }
        links.push({
          source: pcId, target: toolNodeId,
          agentId: activeAgentId ?? "", color: color + "50",
        })
      }
    }
    } // end else (force-directed mode)

    // Structural comparison (includes status + color so state changes trigger repaint)
    const prev = prevGraphRef.current
    const nk = nodes.map(n => `${n.id}|${n.delegateStatus ?? ""}|${n.color}`).join("\0")
    const lk = links.map(l => `${l.source}\0${l.target}`).join("\0")
    const pnk = prev.nodes.map(n => `${n.id}|${n.delegateStatus ?? ""}|${n.color}`).join("\0")
    const plk = prev.links.map(l => {
      const s = typeof l.source === "string" ? l.source : (l.source as MapNode).id
      const t = typeof l.target === "string" ? l.target : (l.target as MapNode).id
      return `${s}\0${t}`
    }).join("\0")
    if (nk === pnk && lk === plk) return prev
    prevGraphRef.current = { nodes, links }
    return { nodes, links }
  }, [agents, traceDelegations, tracePlanSteps, tracePlannerChildren, activeAgentId, involvedToolIds, planDag, planStepStatuses])

  const graphFingerprint = useMemo(() => {
    const nodeCount = graphData.nodes.length
    const linkCount = graphData.links.length
    return `${planDag ? "dag" : "force"}:${nodeCount}:${linkCount}`
  }, [graphData.links.length, graphData.nodes.length, planDag])

  // Set of currently-running tool IDs (for highlighting)
  const activeToolSet = useMemo(() => {
    const set = new Set<string>()
    for (const [id, s] of toolStats) { if (s.lastStatus === "running") set.add(id) }
    return set
  }, [toolStats])

  // Check if any planner step is currently active (for spinner animation)
  const hasActiveStep = useMemo(() => {
    for (const [, s] of planStepStatuses) { if (s.status === "active") return true }
    return false
  }, [planStepStatuses])

  // Animate while tools are running or steps are active — keeps canvas repainting
  useEffect(() => {
    if (activeToolSet.size === 0 && !hasActiveStep) return
    let running = true
    const tick = () => {
      if (!running) return
      animPhaseRef.current = Date.now()
      // Briefly reheat to force a repaint frame; very low alpha so nodes barely move
      const fg = graphRef.current
      if (fg) { fg.d3ReheatSimulation(); fg.d3Force("charge")?.strength(planDag ? -250 : -120) }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { running = false; cancelAnimationFrame(rafRef.current) }
  }, [activeToolSet.size, hasActiveStep, planDag])

  // Track new tool calls for edge flash
  useEffect(() => {
    if (trace.length <= prevTraceLen.current) { prevTraceLen.current = trace.length; return }
    prevTraceLen.current = trace.length
  }, [trace])

  // Configure d3 forces
  useEffect(() => {
    const fg = graphRef.current
    if (!fg) return
    if (planDag) {
      // DAG mode: wider spacing, no xBias
      fg.d3Force("xBias", null)
      fg.d3Force("link")?.distance(70).strength(0.4)
      fg.d3Force("charge")?.strength(-250).distanceMax(400)
    } else {
      fg.d3Force("link")?.distance(55).strength(0.2)
      fg.d3Force("charge")?.strength(-120).distanceMax(200)
      let forceNodes: NodeObject<MapNode>[] = []
      const xBias = (alpha: number) => {
        for (const node of forceNodes) {
          if (node.fx != null) continue
          const target = node.type === "agent" ? -60 : node.type === "planner-child" ? -20 : node.type === "delegate" || node.type === "planstep" ? -30 : 60
          node.vx = (node.vx ?? 0) + (target - (node.x ?? 0)) * 0.02 * alpha
        }
      }
      xBias.initialize = (nodes: NodeObject<MapNode>[]) => { forceNodes = nodes }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fg.d3Force("xBias", xBias as any)
    }
  }, [planDag]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit to view whenever the map panel size or graph content meaningfully changes.
  // The old behavior only fit on agent-count changes, so the graph could stay stuck
  // in an old viewport after editor/sidebar resizes and leave large unused space.
  useEffect(() => {
    const fg = graphRef.current
    if (!fg || size.w <= 0 || size.h <= 0 || graphData.nodes.length === 0) return

    if (autoFitTimerRef.current != null) window.clearTimeout(autoFitTimerRef.current)

    autoFitTimerRef.current = window.setTimeout(() => {
      const padding = planDag ? 80 : 60
      fg.zoomToFit(350, padding)
      window.setTimeout(() => {
        const z = fg.zoom()
        zoomBaseRef.current = z
        setZoomLevel(100)
      }, 380)
    }, 120)

    return () => {
      if (autoFitTimerRef.current != null) {
        window.clearTimeout(autoFitTimerRef.current)
        autoFitTimerRef.current = null
      }
    }
  }, [graphFingerprint, size.h, size.w, planDag, graphData.nodes.length])

  // Track zoom
  const handleZoom = useCallback((transform: { k: number }) => {
    queueMicrotask(() => {
      const base = zoomBaseRef.current
      setZoomLevel(base > 0 ? Math.round((transform.k / base) * 100) : 100)
    })
  }, [])

  // Paint node
  const paintNode = useCallback((node: NodeObject<MapNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const r = node.type === "agent" || node.type === "planner-child" ? 10 : node.type === "delegate" || node.type === "planstep" ? 8 : 7

    if (node.type === "delegate") {
      const isDone = node.delegateStatus === "done" || node.delegateStatus === "error"
      const fillColor = node.delegateStatus === "error" ? C.coral + "30" : isDone ? C.success + "25" : "#342F57cc"
      const strokeColor = node.delegateStatus === "error" ? C.coral + "aa" : isDone ? C.success + "66" : node.color + "bb"
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = fillColor
      ctx.fillRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4)
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = 1.2
      ctx.strokeRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4)
      ctx.restore()
      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = isDone ? (node.delegateStatus === "error" ? C.coral + "88" : C.muted) : node.color
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 3)
      return
    }

    if (node.type === "planstep") {
      const isDone = node.delegateStatus === "done" || node.delegateStatus === "error"
      const isActive = node.delegateStatus === "active"
      const isPending = !isActive && !isDone
      const w = r * 1.6, h = r * 1.2, rad = 3
      // Active spinner ring
      if (isActive) {
        const t = animPhaseRef.current * 0.003
        const arcLen = Math.PI * 0.8
        ctx.beginPath()
        ctx.arc(x, y, Math.max(w, h) + 3, t, t + arcLen)
        ctx.strokeStyle = C.accent + "88"
        ctx.lineWidth = 1.8
        ctx.lineCap = "butt"
        ctx.stroke()
      }
      // Determine fill and stroke based on state
      const fillColor = node.delegateStatus === "error" ? C.coral + "20" : isDone ? C.success + "18" : isActive ? "#342F57cc" : "#342F5744"
      const strokeColor = node.delegateStatus === "error" ? C.coral + "88" : isDone ? C.success + "55" : isActive ? node.color + "bb" : node.color + "25"
      ctx.beginPath()
      ctx.moveTo(x - w + rad, y - h)
      ctx.lineTo(x + w - rad, y - h)
      ctx.arcTo(x + w, y - h, x + w, y - h + rad, rad)
      ctx.lineTo(x + w, y + h - rad)
      ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad)
      ctx.lineTo(x - w + rad, y + h)
      ctx.arcTo(x - w, y + h, x - w, y + h - rad, rad)
      ctx.lineTo(x - w, y - h + rad)
      ctx.arcTo(x - w, y - h, x - w + rad, y - h, rad)
      ctx.closePath()
      ctx.fillStyle = fillColor
      ctx.fill()
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = isDone || isActive ? 1.4 : 0.8
      ctx.stroke()
      // Label color reflects state
      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = node.delegateStatus === "error" ? C.coral + "cc" : isDone ? C.success + "bb" : isPending ? node.color + "40" : node.color
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + h + 3)
      return
    }

    if (node.type === "planner-child") {
      const isActive = node.delegateStatus === "active"
      const isDone = node.delegateStatus === "done" || node.delegateStatus === "error"
      const isPending = !isActive && !isDone
      // Active spinner ring
      if (isActive) {
        const t = animPhaseRef.current * 0.003
        const arcLen = Math.PI * 0.8
        ctx.beginPath()
        ctx.arc(x, y, r + 3, t, t + arcLen)
        ctx.strokeStyle = C.accent + "88"
        ctx.lineWidth = 1.8
        ctx.lineCap = "butt"
        ctx.stroke()
        // Glow
        ctx.fillStyle = C.accent + "10"
        ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill()
      }
      // Circle body — color indicates state
      const fillColor = node.delegateStatus === "error" ? C.coral + "25" : isDone ? C.success + "1c" : isActive ? "#342F57cc" : "#342F5744"
      const strokeColor = node.delegateStatus === "error" ? C.coral + "99" : isDone ? C.success + "55" : isActive ? C.accent + "aa" : node.color + "25"
      ctx.fillStyle = fillColor
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = strokeColor
      ctx.lineWidth = isActive ? 1.6 : isDone ? 1.2 : 0.8; ctx.stroke()
      // Label — color reflects state
      const lbl = node.label.length > 20 ? node.label.slice(0, 18) + "…" : node.label
      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = node.delegateStatus === "error" ? C.coral + "cc" : isDone ? C.success + "bb" : isPending ? node.color + "40" : C.text + "dd"
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(lbl, x, y + r + 3)
      return
    }

    if (node.type === "agent") {
      const isActive = node.agentId === activeAgentId
      const dimmed = hasRunContext && !isActive
      if (isActive && hasRunContext) {
        ctx.fillStyle = node.color + (isRunning ? "18" : "0c")
        ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, Math.PI * 2); ctx.fill()
      }
      ctx.fillStyle = dimmed ? C.base + "aa" : "#342F57cc"
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = dimmed ? C.dim + "30" : node.color + (isActive && hasRunContext ? "aa" : "60")
      ctx.lineWidth = isActive && hasRunContext ? 1.2 : dimmed ? 0.5 : 0.8; ctx.stroke()
      ctx.font = `${Math.max(4, 13 / globalScale)}px sans-serif`
      ctx.fillStyle = dimmed ? C.muted + "40" : isActive && hasRunContext ? C.text : C.text + "bb"
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 3)
    } else {
      // Tool node
      const stats = toolStats.get(node.toolId ?? "")
      const active = stats?.lastStatus === "running"
      const wasUsed = involvedToolIds.has(node.toolId ?? "")
      const dimmed = hasRunContext && !wasUsed
      const toolColor = active ? C.accent : stats?.lastStatus === "error" ? C.coral : stats?.lastStatus === "done" ? C.success : C.dim

      // Progress spinner ring for active tools
      if (active) {
        const t = animPhaseRef.current * 0.003
        const arcLen = Math.PI * 0.8
        ctx.beginPath()
        ctx.arc(x, y, r + 3, t, t + arcLen)
        ctx.strokeStyle = C.accent + "88"
        ctx.lineWidth = 1.8
        ctx.lineCap = "butt"
        ctx.stroke()
        // Glow behind the node
        ctx.fillStyle = C.accent + "12"
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fill()
      }

      ctx.fillStyle = dimmed ? C.base + "88" : C.elevated
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = dimmed ? C.dim + "20" : toolColor + (active ? "cc" : wasUsed ? "88" : "60")
      ctx.lineWidth = active ? 1.8 : dimmed ? 0.5 : 0.8; ctx.stroke()
      if (stats && stats.calls > 0) {
        ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
        ctx.fillStyle = dimmed ? toolColor + "30" : toolColor
        ctx.textAlign = "center"; ctx.textBaseline = "middle"
        ctx.fillText(stats.calls > 99 ? "99+" : String(stats.calls), x, y + 0.5)
      }
      ctx.font = `${Math.max(4, 12 / globalScale)}px sans-serif`
      ctx.fillStyle = dimmed ? C.muted + "30" : stats && stats.calls > 0 ? C.text : C.muted
      ctx.textAlign = "center"; ctx.textBaseline = "top"
      ctx.fillText(node.label, x, y + r + 2)
    }
  }, [activeAgentId, hasRunContext, isRunning, toolStats, involvedToolIds])

  // Node hit area
  const paintNodeArea = useCallback((node: NodeObject<MapNode>, color: string, ctx: CanvasRenderingContext2D) => {
    const r = node.type === "agent" || node.type === "planner-child" ? 12 : node.type === "delegate" || node.type === "planstep" ? 10 : 9
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2); ctx.fill()
  }, [])

  const handleNodeClick = useCallback((node: NodeObject<MapNode>) => {
    setSelectedNode((prev) => prev === node.id ? null : (node.id as string))
  }, [])

  const handleNodeDragEnd = useCallback((node: NodeObject<MapNode>) => {
    node.fx = node.x; node.fy = node.y
  }, [])

  // Custom link renderer
  const paintLink = useCallback((link: LinkObject<MapNode, MapLink>, ctx: CanvasRenderingContext2D) => {
    const vLink = link as unknown as MapLink
    const src = link.source as NodeObject<MapNode>
    const tgt = link.target as NodeObject<MapNode>
    if (!src || !tgt || src.x == null || tgt.x == null) return

    if (planDag) {
      // DAG mode: straight lines with arrowheads
      const sx = src.x!, sy = src.y!
      const tx = tgt.x!, ty = tgt.y!
      const dx = tx - sx, dy = ty - sy
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const ux = dx / len, uy = dy / len
      // Use same radii as paintNode to avoid artifacts at circle edges
      const srcR = src.type === "agent" || src.type === "planner-child" ? 10 : src.type === "delegate" || src.type === "planstep" ? 8 : 7
      const tgtR = tgt.type === "agent" || tgt.type === "planner-child" ? 10 : tgt.type === "delegate" || tgt.type === "planstep" ? 8 : 7
      // Shorten line to node edges on both ends
      const startX = sx + ux * srcR
      const startY = sy + uy * srcR
      const endX = tx - ux * tgtR
      const endY = ty - uy * tgtR

      ctx.beginPath()
      ctx.moveTo(startX, startY)
      ctx.lineTo(endX, endY)
      ctx.strokeStyle = vLink.color
      ctx.lineWidth = 1.6
      ctx.stroke()

      // Arrowhead at target end
      const arrowLen = 5, arrowW = 3
      ctx.beginPath()
      ctx.moveTo(endX, endY)
      ctx.lineTo(endX - ux * arrowLen + uy * arrowW, endY - uy * arrowLen - ux * arrowW)
      ctx.lineTo(endX - ux * arrowLen - uy * arrowW, endY - uy * arrowLen + ux * arrowW)
      ctx.closePath()
      ctx.fillStyle = vLink.color
      ctx.fill()
      return
    }

    const isActiveLink = vLink.agentId === activeAgentId
    const tgtToolId = tgt.id?.toString().replace("tool:", "") ?? ""
    const toolUsed = involvedToolIds.has(tgtToolId)
    const toolRunning = activeToolSet.has(tgtToolId)
    const highlight = hasRunContext && isActiveLink && toolUsed
    const isLive = hasRunContext && isActiveLink && toolRunning
    const dimmed = hasRunContext && !isActiveLink
    const alpha = isLive ? "88" : highlight ? "44" : dimmed ? "08" : "1a"
    const mx = (src.x + tgt.x) / 2, my = (src.y! + tgt.y!) / 2
    const dx = tgt.x - src.x, dy = tgt.y! - src.y!
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const offset = len * 0.08
    const cx = mx + (-dy / len) * offset, cy = my + (dx / len) * offset

    if (isLive) {
      // Animated dashed line for currently-running tool edge
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.lineDashOffset = -(animPhaseRef.current * 0.04) % 8
      ctx.beginPath(); ctx.moveTo(src.x, src.y!); ctx.quadraticCurveTo(cx, cy, tgt.x, tgt.y!)
      ctx.strokeStyle = vLink.color + alpha; ctx.lineWidth = 2; ctx.stroke()
      ctx.restore()
    } else {
      ctx.beginPath(); ctx.moveTo(src.x, src.y!); ctx.quadraticCurveTo(cx, cy, tgt.x, tgt.y!)
      ctx.strokeStyle = vLink.color + alpha; ctx.lineWidth = highlight ? 1.2 : 0.5; ctx.stroke()
    }
  }, [planDag, activeAgentId, hasRunContext, involvedToolIds, activeToolSet])

  // Detail panel for selected node
  const detailInfo = useMemo((): { title: string; lines: Array<{ label: string; value: string }>; invocations?: Array<{ args: string; result: string; status: "ok" | "error" }> } | null => {
    if (!selectedNode) return null
    if (selectedNode.startsWith("agent:")) {
      const agentId = selectedNode.slice(6)
      const agent = agents.find((a) => a.id === agentId)
      if (!agent) return null
      return {
        title: agent.name, lines: [
          { label: "Tools", value: String(agent.tools.length) },
          ...(run?.agentId === agentId ? [{ label: "Status", value: run.status }] : []),
        ],
      }
    }
    if (selectedNode.startsWith("tool:")) {
      const toolId = selectedNode.slice(5)
      const stats = toolStats.get(toolId)
      const invocations: Array<{ args: string; result: string; status: "ok" | "error" }> = []
      for (let i = 0; i < trace.length; i++) {
        const e = trace[i]
        if (e.kind === "tool-call" && e.tool === toolId) {
          const args = e.argsSummary || e.argsFormatted || "..."
          let result = "", status: "ok" | "error" = "ok"
          for (let j = i + 1; j < trace.length; j++) {
            const r = trace[j]
            if (r.kind === "tool-result") { result = r.text; break }
            else if (r.kind === "tool-error") { result = r.text; status = "error"; break }
            else if (r.kind === "tool-call") { result = "⏳ running..."; break }
          }
          if (!result) result = "⏳ running..."
          invocations.push({ args, result, status })
        }
      }
      return {
        title: mapToolLabel(toolId), lines: stats ? [
          { label: "Calls", value: String(stats.calls) },
          { label: "Errors", value: String(stats.errors) },
          { label: "Status", value: stats.lastStatus },
        ] : [{ label: "Status", value: "No activity" }],
        invocations,
      }
    }
    if (selectedNode.startsWith("delegate:")) {
      const key = selectedNode.slice(9)
      const deleg = traceDelegations.find((d) => d.key === key)
      if (!deleg) return null
      return {
        title: `Delegate D${deleg.depth}`, lines: [
          { label: "Goal", value: deleg.goal.slice(0, 60) },
          { label: "Tools", value: String(deleg.tools.length) },
          { label: "Status", value: deleg.status },
        ],
      }
    }
    if (selectedNode.startsWith("planstep:")) {
      const key = selectedNode.slice(9)
      const ps = tracePlanSteps.find((s) => s.key === key)
      if (!ps) return null
      const endEvt = trace.find((e) => e.kind === "planner-step-end" && e.stepName === ps.name) as
        | { durationMs?: number }
        | undefined
      return {
        title: `Step: ${ps.name}`, lines: [
          { label: "Type", value: ps.type },
          { label: "Status", value: ps.status === "done" ? "completed" : ps.status },
          ...(endEvt?.durationMs != null ? [{ label: "Duration", value: `${endEvt.durationMs}ms` }] : []),
        ],
      }
    }
    if (selectedNode.startsWith("planner-child:")) {
      const key = selectedNode.slice(14)
      const pc = tracePlannerChildren.find(c => c.key === key)
      if (!pc) return null
      return {
        title: `Agent: ${pc.name}`, lines: [
          { label: "Goal", value: pc.goal.length > 80 ? pc.goal.slice(0, 77) + "…" : pc.goal },
          { label: "Assigned tools", value: pc.tools.length > 0 ? pc.tools.join(", ") : "—" },
          { label: "Used tools", value: pc.usedTools.length > 0 ? pc.usedTools.join(", ") : "—" },
          { label: "Status", value: pc.status === "done" ? "completed" : pc.status },
        ],
      }
    }
    // DAG mode: step:name nodes
    if (selectedNode.startsWith("step:")) {
      const stepName = selectedNode.slice(5)
      const stepStatus = planStepStatuses.get(stepName)
      const stepDef = planDag?.steps.find(s => s.name === stepName)
      const childData = tracePlannerChildren.find(c => c.name === stepName)
      const isChild = stepDef?.type === "subagent_task"
      const lines: Array<{ label: string; value: string }> = [
        { label: "Type", value: isChild ? "subagent_task" : stepDef?.type ?? "unknown" },
        { label: "Status", value: stepStatus?.status === "done" ? "completed" : stepStatus?.status ?? "pending" },
      ]
      if (stepStatus?.durationMs != null) lines.push({ label: "Duration", value: `${stepStatus.durationMs}ms` })
      if (stepStatus?.iteration != null) lines.push({ label: "Iteration", value: `${stepStatus.iteration}/${stepStatus.maxIterations ?? "?"}` })
      if (childData) {
        lines.push({ label: "Goal", value: childData.goal.length > 80 ? childData.goal.slice(0, 77) + "…" : childData.goal })
        if (childData.tools.length > 0) lines.push({ label: "Tools", value: childData.tools.join(", ") })
        if (childData.usedTools.length > 0) lines.push({ label: "Used tools", value: childData.usedTools.join(", ") })
      }
      if (stepDef?.dependsOn && stepDef.dependsOn.length > 0) lines.push({ label: "Depends on", value: stepDef.dependsOn.join(", ") })
      return { title: stepName, lines }
    }
    return null
  }, [selectedNode, agents, run, toolStats, traceDelegations, tracePlanSteps, tracePlannerChildren, trace, planDag, planStepStatuses])

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[13px]" style={{ color: C.dim }}>
        Loading agent graph...
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none" style={{ background: C.base }}>
      {/* Force-directed graph */}
      <div className="absolute inset-0" style={{ cursor: "grab" }}>
        {size.w > 0 && size.h > 0 && (
        <ForceGraph2D
          key={planDag ? "dag" : "force"}
          ref={graphRef}
          graphData={graphData}
          width={size.w}
          height={size.h}
          backgroundColor="transparent"
          nodeCanvasObject={paintNode}
          nodeCanvasObjectMode={() => "replace"}
          nodePointerAreaPaint={paintNodeArea}
          onNodeClick={handleNodeClick}
          onNodeDragEnd={handleNodeDragEnd}
          onZoom={handleZoom}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          linkCanvasObject={paintLink}
          linkCanvasObjectMode={() => "replace"}
          cooldownTicks={80}
          d3AlphaDecay={0.015}
          d3VelocityDecay={0.35}
          d3AlphaMin={0.005}
          minZoom={0.3}
          maxZoom={8}
          dagMode={planDag ? "td" : undefined}
          dagLevelDistance={planDag ? 70 : 80}
        />
        )}
      </div>

      {/* Zoom controls — bottom center */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-lg px-1 py-0.5" style={{ background: C.surface + "cc" }}>
        <button className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10" style={{ color: C.muted }}
          onClick={() => { const fg = graphRef.current; if (fg) fg.zoom(fg.zoom() * 0.7, 200) }}>
          <span className="text-[13px]">−</span>
        </button>
        <span className="text-[10px] font-mono w-8 text-center" style={{ color: C.muted }}>{zoomLevel}%</span>
        <button className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10" style={{ color: C.muted }}
          onClick={() => { const fg = graphRef.current; if (fg) fg.zoom(fg.zoom() * 1.4, 200) }}>
          <span className="text-[13px]">+</span>
        </button>
        <button className="flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer hover:bg-white/10" style={{ color: C.muted }}
          onClick={() => {
            const fg = graphRef.current; if (!fg) return
            const nodes = graphData.nodes; if (nodes.length === 0) return
            let cx = 0, cy = 0
            for (const n of nodes) { cx += (n as NodeObject<MapNode>).x ?? 0; cy += (n as NodeObject<MapNode>).y ?? 0 }
            fg.centerAt(cx / nodes.length, cy / nodes.length, 400)
          }}>
          <span className="text-[13px]">⊕</span>
        </button>
      </div>

      {/* Status indicator — top left */}
      {run && (
        <div className="absolute top-3 left-3 flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px]" style={{ background: C.surface + "cc" }}>
          <span className={`w-2 h-2 rounded-full ${isRunning ? "animate-pulse" : ""}`} style={{ background: isRunning ? C.success : statusDot(run.status) }} />
          <span style={{ color: isRunning ? C.success : C.muted }}>{run.status}</span>
          {trace.length > 0 && <span style={{ color: C.dim }}>{trace.filter(e => e.kind === "tool-call").length} calls</span>}
        </div>
      )}

      {/* Detail panel — right side */}
      {selectedNode && detailInfo && (
        <div className="absolute top-3 right-3 rounded-lg px-4 py-3 font-mono max-w-[300px] max-h-[70%] flex flex-col" style={{ background: `${C.surface}ee`, border: `1px solid rgba(255,255,255,0.08)`, color: C.text }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-semibold" style={{ color: C.accent }}>{detailInfo.title}</span>
            <button className="opacity-40 hover:opacity-100 ml-3 leading-none text-[16px] cursor-pointer" style={{ color: C.muted }} onClick={() => setSelectedNode(null)}>×</button>
          </div>
          {detailInfo.lines.map((line, i) => (
            <div key={i} className="flex justify-between gap-4 text-[13px] leading-relaxed">
              <span style={{ color: C.muted }}>{line.label}</span>
              <span className="font-medium">{line.value}</span>
            </div>
          ))}
          {detailInfo.invocations && detailInfo.invocations.length > 0 && (
            <div className="mt-2 pt-2 overflow-y-auto flex-1 flex flex-col gap-2" style={{ borderTop: `1px solid rgba(255,255,255,0.06)` }}>
              {detailInfo.invocations.map((inv, i) => (
                <div key={i} className="text-[10px]">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: inv.status === "error" ? C.coral : inv.result === "⏳ running..." ? C.accent : C.success }} />
                    <span style={{ color: C.text }} className="font-medium">#{i + 1}</span>
                    <span style={{ color: C.muted }} className="truncate">{inv.args.length > 50 ? inv.args.slice(0, 47) + "..." : inv.args}</span>
                  </div>
                  <div className="ml-3 pl-2 leading-snug whitespace-pre-wrap break-all" style={{ color: inv.status === "error" ? C.coral : inv.result === "⏳ running..." ? C.accent : C.muted, borderLeft: `2px solid ${inv.status === "error" ? C.coral + "40" : "rgba(255,255,255,0.06)"}`, maxHeight: 80, overflow: "hidden" }}>
                    {inv.result.length > 200 ? inv.result.slice(0, 197) + "..." : inv.result}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

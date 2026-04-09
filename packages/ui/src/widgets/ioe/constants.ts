/**
 * IOE shared constants, types, and helpers.
 */

import type {
    Run,
    Step,
    TraceEntry,
} from "../../types"

// ── Design tokens ────────────────────────────────────────────────

export const C = {
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
} as const

// ── Layout types ─────────────────────────────────────────────────

export type SidebarSection = "runs" | "compare" | "details"
export type EditorTab = "trace" | "llm-calls" | "map"
export type BottomTab = "output" | "audit" | "problems"
export type PanelSide = "left" | "right"

// ── API data types ───────────────────────────────────────────────

export interface LlmConfig {
  provider: string
  model: string
  hasApiKey: boolean
  baseUrl: string
}

export interface UsageData {
  totals: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    llmCalls: number
    runCount: number
    completedRuns: number
    failedRuns: number
  }
}

export interface HealthData {
  status: string
  active: number
}

export interface DagNode {
  id: string
  type: string
  label: string
  detail: string
  expanded: string
  status: string
  depth: number
  resultText?: string
}

export interface FeedItem {
  text: string
  color: string
}

export interface Problem {
  text: string
  source: string
  time?: string
}

export interface SearchResult {
  type: string
  text: string
  detail?: string
}

// ── Helpers ──────────────────────────────────────────────────────

export function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function ts(date: string): string {
  return new Date(date).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function dur(start: string | null, end: string | null): string {
  if (!start) return ""
  const s = new Date(start).getTime()
  const e = end ? new Date(end).getTime() : Date.now()
  const ms = e - s
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function statusDot(status: string): string {
  switch (status) {
    case "completed":
      return C.success
    case "failed":
      return C.error
    case "running":
    case "pending":
    case "planning":
      return C.accent
    case "cancelled":
      return C.warning
    default:
      return C.dim
  }
}

// ── Data builders ────────────────────────────────────────────────

export function buildDagNodes(trace: TraceEntry[]): DagNode[] {
  const nodes: DagNode[] = []
  let iterIdx = 0
  let lastToolId: string | null = null
  let delegationDepth = 0

  for (let i = 0; i < trace.length; i++) {
    const e = trace[i]
    if (e.kind === "delegation-start") {
      nodes.push({
        id: `deleg-${i}`,
        type: "iteration",
        label: `D${e.depth}`,
        detail: `${e.goal.slice(0, 80)}${e.agentName ? ` [${e.agentName}]` : ""}`,
        expanded: `Delegated sub-task (depth ${e.depth})\nGoal: ${e.goal}\nTools: ${e.tools.join(", ")}`,
        status: "running",
        depth: delegationDepth + 1,
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

    // Planner events → DAG nodes
    if (e.kind === "planner-decision" && e.shouldPlan) {
      nodes.push({
        id: `plan-decision-${i}`,
        type: "iteration",
        label: "P",
        detail: `Planner activated (score ${e.score.toFixed(2)})`,
        expanded: `Planner decision: ${e.reason}\nScore: ${e.score}`,
        status: "done",
        depth: delegationDepth,
      })
      continue
    }
    if (e.kind === "planner-plan-generated") {
      nodes.push({
        id: `plan-gen-${i}`,
        type: "iteration",
        label: `${e.stepCount}P`,
        detail: `Plan: ${e.steps.map(s => s.name).join(" → ")}`,
        expanded: `${e.reason}\n\nSteps:\n${e.steps.map(s => `- ${s.name} (${s.type})`).join("\n")}`,
        status: "done",
        depth: delegationDepth,
      })
      continue
    }
    if (e.kind === "planner-step-start") {
      nodes.push({
        id: `plan-step-${i}`,
        type: "tool-call",
        label: `${e.stepName}`,
        detail: `${e.stepType}: ${e.stepName}`,
        expanded: `Plan step: ${e.stepName} (${e.stepType})`,
        status: "running",
        depth: delegationDepth + 1,
      })
      continue
    }
    if (e.kind === "planner-step-end") {
      for (let j = nodes.length - 1; j >= 0; j--) {
        if (nodes[j].id.startsWith("plan-step-") && nodes[j].status === "running") {
          nodes[j].status = e.status === "completed" ? "done" : "error"
          nodes[j].resultText = `${e.durationMs}ms`
          break
        }
      }
      continue
    }
    if (e.kind === "planner-pipeline-end") {
      nodes.push({
        id: `plan-pipe-${i}`,
        type: "answer",
        label: "PE",
        detail: `Pipeline ${e.status}: ${e.completedSteps}/${e.totalSteps}`,
        expanded: `Pipeline ${e.status}\nCompleted: ${e.completedSteps}/${e.totalSteps} steps`,
        status: e.status === "completed" ? "done" : "error",
        depth: delegationDepth,
      })
      continue
    }
    if (e.kind === "planner-verification") {
      nodes.push({
        id: `plan-verify-${i}`,
        type: "answer",
        label: "V",
        detail: `Verified: ${e.overall} (${(e.confidence * 100).toFixed(0)}%)`,
        expanded: `Verification: ${e.overall}\nConfidence: ${(e.confidence * 100).toFixed(0)}%\n${e.steps.map(s => `${s.stepName}: ${s.outcome}${s.issues.length ? ` — ${s.issues.join("; ")}` : ""}`).join("\n")}`,
        status: e.overall === "pass" ? "done" : e.overall === "partial" ? "done" : "error",
        depth: delegationDepth,
      })
      continue
    }
    if (typeof e.kind === "string" && e.kind.startsWith("planner-")) continue

    if (e.kind === "iteration") {
      iterIdx++
      let hasError = false
      let hasDone = false
      for (let j = i + 1; j < trace.length; j++) {
        if (trace[j].kind === "iteration") break
        if (trace[j].kind === "tool-error" || trace[j].kind === "error") hasError = true
        if (trace[j].kind === "tool-result" || trace[j].kind === "answer") hasDone = true
      }
      const nextIter = trace.findIndex((t, idx) => idx > i && t.kind === "iteration")
      let status = "running"
      if (nextIter !== -1) status = hasDone ? "done" : hasError ? "error" : "done"
      else if (hasError && hasDone) status = "partial"
      else if (hasError) status = "error"
      else if (hasDone) status = "done"

      nodes.push({
        id: `iter-${iterIdx}`,
        type: "iteration",
        label: `${iterIdx}A`,
        detail: `iteration ${e.current}/${e.max}`,
        expanded: `Iteration ${e.current} of ${e.max}`,
        status,
        depth: delegationDepth,
      })
    } else if (e.kind === "tool-call") {
      lastToolId = `tc-${i}`
      nodes.push({
        id: lastToolId,
        type: "tool-call",
        label: `${nodes.filter((n) => n.type === "tool-call").length + 1}T`,
        detail: `${e.tool}(${e.argsSummary || "..."})`,
        expanded: `tool: ${e.tool}\n${e.argsFormatted}`,
        status: "running",
        depth: delegationDepth + 1,
      })
    } else if (e.kind === "tool-result" && lastToolId) {
      const tc = nodes.find((n) => n.id === lastToolId)
      if (tc) {
        tc.status = "done"
        tc.resultText = e.text
      }
      lastToolId = null
    } else if (e.kind === "tool-error" && lastToolId) {
      const tc = nodes.find((n) => n.id === lastToolId)
      if (tc) {
        tc.status = "error"
        tc.resultText = e.text
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
    } else if (e.kind === "workspace_diff") {
      const total = e.diff.added.length + e.diff.modified.length + e.diff.deleted.length
      nodes.push({
        id: `ws-diff-${i}`,
        type: "tool-call",
        label: "WD",
        detail: `${total} isolated changes pending approval`,
        expanded: `workspace diff\n+${e.diff.added.length} added\n~${e.diff.modified.length} modified\n-${e.diff.deleted.length} deleted`,
        status: total > 0 ? "running" : "done",
        depth: delegationDepth + 1,
      })
    } else if (e.kind === "workspace_diff_applied") {
      const total = e.summary.added + e.summary.modified + e.summary.deleted
      nodes.push({
        id: `ws-apply-${i}`,
        type: "answer",
        label: "WA",
        detail: `${total} workspace changes applied`,
        expanded: `workspace apply\n+${e.summary.added} added\n~${e.summary.modified} modified\n-${e.summary.deleted} deleted`,
        status: "done",
        depth: delegationDepth + 1,
      })
    }
  }
  return nodes
}

export function buildFeedItems(trace: TraceEntry[]): FeedItem[] {
  const items: FeedItem[] = []
  for (let i = Math.max(0, trace.length - 50); i < trace.length; i++) {
    const e = trace[i]
    if (e.kind === "tool-call") items.push({ text: `CALL ${e.tool}(${e.argsSummary || "..."})`, color: C.warning })
    else if (e.kind === "tool-result") items.push({ text: `RET  ${e.text}`, color: C.success })
    else if (e.kind === "tool-error") items.push({ text: `ERR  ${e.text}`, color: C.coral })
    else if (e.kind === "thinking") items.push({ text: `THINK ${e.text}`, color: C.accent })
    else if (e.kind === "answer") items.push({ text: `ANS  ${e.text}`, color: C.success })
    else if (e.kind === "iteration") items.push({ text: `ITER ${e.current}/${e.max}`, color: C.dim })
    else if (e.kind === "goal") items.push({ text: `GOAL ${e.text ?? ""}`, color: C.accent })
    else if (e.kind === "delegation-start") items.push({ text: `DELEG ▶ ${e.agentName ? `[${e.agentName}] ` : ""}${e.goal}`, color: C.plum })
    else if (e.kind === "delegation-end") items.push({ text: `DELEG ◀ ${e.status}`, color: e.status === "done" ? C.success : C.coral })
    else if (e.kind === "planner-decision" && e.shouldPlan) items.push({ text: `PLAN ▶ score ${e.score.toFixed(2)}`, color: C.plum })
    else if (e.kind === "planner-plan-generated") items.push({ text: `PLAN ✓ ${e.stepCount} steps: ${e.steps.map(s => s.name).join(" → ")}`, color: C.plum })
    else if (e.kind === "planner-step-start") items.push({ text: `STEP ⟩ ${e.stepName}`, color: C.dim })
    else if (e.kind === "planner-step-end") items.push({ text: `STEP ${e.status === "completed" ? "✓" : "✗"} ${e.stepName} (${e.durationMs}ms)`, color: e.status === "completed" ? C.success : C.coral })
    else if (e.kind === "planner-pipeline-end") items.push({ text: `PIPE ◀ ${e.status} ${e.completedSteps}/${e.totalSteps}`, color: e.status === "completed" ? C.success : C.coral })
    else if (e.kind === "planner-verification") items.push({ text: `VRFY ${e.overall} (${(e.confidence * 100).toFixed(0)}%)`, color: e.overall === "pass" ? C.success : C.warning })
    else if (e.kind === "workspace_diff") items.push({ text: `DIFF pending +${e.diff.added.length} ~${e.diff.modified.length} -${e.diff.deleted.length}`, color: C.cyan })
    else if (e.kind === "workspace_diff_applied") items.push({ text: `APPLY +${e.summary.added} ~${e.summary.modified} -${e.summary.deleted}`, color: C.success })
  }
  return items
}

export function buildProblems(trace: TraceEntry[], steps: Step[]): Problem[] {
  const items: Problem[] = []
  for (const e of trace) {
    if (e.kind === "error") items.push({ text: e.text, source: "run" })
    else if (e.kind === "tool-error") items.push({ text: e.text.slice(0, 200), source: "tool" })
    else if (e.kind === "planner-generation-failed") {
      for (const d of e.diagnostics) items.push({ text: `[${d.code}] ${d.message}`, source: "planner" })
    } else if (e.kind === "planner-validation-failed") {
      for (const d of e.diagnostics) items.push({ text: `[${d.code}] ${d.message}`, source: "planner" })
    } else if (e.kind === "planner-pipeline-end" && e.status === "failed") {
      items.push({ text: `Pipeline ${e.status}: ${e.completedSteps}/${e.totalSteps} steps completed`, source: "planner" })
    }
  }
  for (const s of steps) {
    if (s.status === "failed" && s.error) items.push({ text: s.error, source: s.name, time: s.completedAt ?? undefined })
  }
  return items
}

export function buildToolStats(steps: Step[]): Map<string, { calls: number; errors: number; totalMs: number }> {
  const stats = new Map<string, { calls: number; errors: number; totalMs: number }>()
  for (const s of steps) {
    const existing = stats.get(s.name) ?? { calls: 0, errors: 0, totalMs: 0 }
    existing.calls++
    if (s.status === "failed") existing.errors++
    if (s.startedAt && s.completedAt) {
      existing.totalMs += new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
    }
    stats.set(s.name, existing)
  }
  return stats
}

export function buildSearchResults(
  query: string,
  runs: Run[],
  trace: TraceEntry[],
  audit: { action: string; actor: string; timestamp: string }[],
): SearchResult[] | null {
  if (!query.trim()) return null
  const q = query.toLowerCase()
  const results: SearchResult[] = []
  for (const r of runs) {
    if (r.goal.toLowerCase().includes(q)) results.push({ type: "run", text: r.goal, detail: r.id.slice(0, 8) })
  }
  for (const e of trace) {
    if (e.kind === "tool-call" && (e.tool.toLowerCase().includes(q) || e.argsSummary.toLowerCase().includes(q))) {
      results.push({ type: "trace", text: `${e.tool}(${e.argsSummary})` })
    }
    if (e.kind === "thinking" && e.text.toLowerCase().includes(q)) {
      results.push({ type: "trace", text: e.text.slice(0, 100) })
    }
    if (e.kind === "workspace_diff") {
      const summary = `workspace diff +${e.diff.added.length} ~${e.diff.modified.length} -${e.diff.deleted.length}`
      if (summary.toLowerCase().includes(q)) results.push({ type: "trace", text: summary })
    }
    if (e.kind === "workspace_diff_applied") {
      const summary = `workspace applied +${e.summary.added} ~${e.summary.modified} -${e.summary.deleted}`
      if (summary.toLowerCase().includes(q)) results.push({ type: "trace", text: summary })
    }
  }
  for (const a of audit) {
    if (a.action.toLowerCase().includes(q) || a.actor.toLowerCase().includes(q)) {
      results.push({ type: "audit", text: `${a.actor}: ${a.action}`, detail: ts(a.timestamp) })
    }
  }
  return results.slice(0, 50)
}

// ── Chat message types ───────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "thinking" | "tool" | "system" | "input-request"
  content: string
  toolName?: string
  options?: string[]
  sensitive?: boolean
}

export function buildChatMessages(trace: TraceEntry[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const e of trace) {
    if (e.kind === "goal") msgs.push({ role: "user", content: e.text ?? "" })
    else if (e.kind === "thinking") msgs.push({ role: "thinking", content: e.text })
    else if (e.kind === "tool-call")
      msgs.push({ role: "tool", content: `${e.tool}(${e.argsSummary || "..."})`, toolName: e.tool })
    else if (e.kind === "tool-result") msgs.push({ role: "tool", content: e.text })
    else if (e.kind === "tool-error") msgs.push({ role: "system", content: `Error: ${e.text}` })
    else if (e.kind === "answer") msgs.push({ role: "assistant", content: e.text })
    else if (e.kind === "error") msgs.push({ role: "system", content: e.text })
    else if (e.kind === "delegation-start")
      msgs.push({ role: "system", content: `Delegating to ${e.agentName ?? "sub-agent"}: ${e.goal}` })
    else if (e.kind === "delegation-end")
      msgs.push({ role: "system", content: `Delegation ${e.status}${e.answer ? `: ${e.answer}` : ""}` })
    else if (e.kind === "planner-decision" && e.shouldPlan)
      msgs.push({ role: "system", content: `Planner activated (score ${e.score.toFixed(2)}): ${e.reason}` })
    else if (e.kind === "planner-plan-generated")
      msgs.push({ role: "system", content: `Plan generated (${e.stepCount} steps): ${e.steps.map(s => s.name).join(" → ")}` })
    else if (e.kind === "planner-pipeline-end")
      msgs.push({ role: "system", content: `Pipeline ${e.status}: ${e.completedSteps}/${e.totalSteps} steps completed` })
    else if (e.kind === "planner-verification")
      msgs.push({ role: "system", content: `Verification: ${e.overall} (confidence ${(e.confidence * 100).toFixed(0)}%)` })
    else if (e.kind === "planner-step-end" && e.status !== "completed")
      msgs.push({ role: "system", content: `Plan step failed: ${e.stepName}` })
    else if (e.kind === "workspace_diff")
      msgs.push({ role: "system", content: `Workspace diff pending approval (+${e.diff.added.length} ~${e.diff.modified.length} -${e.diff.deleted.length})` })
    else if (e.kind === "workspace_diff_applied")
      msgs.push({ role: "system", content: `Workspace diff applied (+${e.summary.added} ~${e.summary.modified} -${e.summary.deleted})` })
    else if (e.kind === "user-input-request")
      msgs.push({ role: "input-request", content: e.question, options: e.options, sensitive: e.sensitive })
    else if (e.kind === "user-input-response")
      msgs.push({ role: "user", content: e.text })
  }
  return msgs
}

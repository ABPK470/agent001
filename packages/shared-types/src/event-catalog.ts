/**
 * Event catalog — single source of truth for how wire events present.
 *
 * Every `TraceEntry.kind` and high-traffic `EventType` gets one descriptor.
 * Widgets must not switch on kind/type strings for labels —
 * look up the catalog (same dialect as tool-call-presentation).
 * Hierarchy / sticky / scope-vs-leaf live on ViewSpec, not here.
 *
 * Add a row here when introducing a new BE event (after shared-enums).
 */

import { presentToolCall } from "./tool-call-presentation.js"

export type EventSeverity = "info" | "warn" | "error"

/** Structural family — ViewSpec nest / sticky / roles key off these. */
export type EventFamily =
  | "context"
  | "plan"
  | "pipeline"
  | "step"
  | "call"
  | "work"
  | "verify"
  | "repair"
  | "sync"
  | "run"
  | "tool"
  | "delegation"
  | "input"
  | "answer"
  | "error"
  | "telemetry"
  | "misc"

/** Loose payload — catalog summaries must not assume a full TraceEntry cast. */
export type EventPayload = Record<string, unknown>

/**
 * Semantic descriptor only — no hierarchy, sticky, or outline role.
 * Those belong on ViewSpec (Trace vs Chat vs Timeline disagree).
 */
export type EventDescriptor = {
  /** TraceEntry.kind or EventType string. */
  id: string
  family: EventFamily
  label: string
  severity: EventSeverity
  /**
   * Semantic instance id for merging consecutive updates of the same entity
   * (e.g. step:frontend_layer). Not parent/child hierarchy.
   */
  instanceKey?: (payload: EventPayload) => string | null
  summary: (payload: EventPayload) => string
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function humanize(name: string): string {
  return name.replace(/_/g, " ")
}

function truncate(text: string, max = 72): string {
  const t = text.trim().replace(/\s+/g, " ")
  if (!t) return t
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function stepName(payload: EventPayload): string {
  return humanize(str(payload.stepName, "step"))
}

/** Wire step/tool rows: action → name → tool → toolName. Empty when unknown. */
function resolveToolName(payload: EventPayload): string {
  return str(payload.action, str(payload.name, str(payload.tool, str(payload.toolName, ""))))
}

function formatStepOutput(payload: EventPayload): string {
  const output = payload.output
  if (!output || typeof output !== "object" || Array.isArray(output)) return ""
  const record = output as EventPayload
  const result = record.result
  if (typeof result === "string" && result.trim()) return truncate(result, 64)
  const keys = Object.keys(record)
  if (keys.length === 0) return ""
  try {
    return truncate(JSON.stringify(record), 64)
  } catch {
    return ""
  }
}

/** Self-contained Event Stream lines: `query_mssql started · sql=…` (no label prefix). */
function stepStartedSummary(payload: EventPayload): string {
  const tool = resolveToolName(payload) || "tool"
  const input =
    payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
      ? (payload.input as Record<string, unknown>)
      : {}
  const args = Object.keys(input).length > 0 ? presentToolCall(tool, input).summary : ""
  if (args) return truncate(`${tool} started · ${args}`, 120)
  return `${tool} started`
}

function stepCompletedSummary(payload: EventPayload): string {
  const tool = resolveToolName(payload) || "tool"
  const out = formatStepOutput(payload)
  const ms = num(payload.durationMs)
  const dur = ms != null ? `${(ms / 1000).toFixed(1)}s` : ""
  const parts = [`${tool} completed`, out || null, dur || null].filter(Boolean)
  return truncate(parts.join(" · "), 120)
}

function stepFailedSummary(payload: EventPayload): string {
  const tool = resolveToolName(payload) || "tool"
  const err = truncate(str(payload.error, "failed"), 72)
  return truncate(`${tool} failed · ${err}`, 120)
}

function toolCallSummary(payload: EventPayload, verb: string): string {
  const tool = str(payload.toolName, str(payload.tool, str(payload.action, "")))
  return tool ? `${tool} ${verb}` : `tool ${verb}`
}

/** TraceEntry.kind → descriptor. */
export const TRACE_EVENT_CATALOG: Readonly<Record<string, EventDescriptor>> = {
  goal: {
    id: "goal",
    family: "context",
    label: "Goal",
    severity: "info",
    summary: (p) => truncate(str(p.text, "Goal")),
  },
  "system-prompt": {
    id: "system-prompt",
    family: "context",
    label: "Prompt",
    severity: "info",
    instanceKey: () => "context:prompt",
    summary: (p) => {
      const t = str(p.text)
      return t ? `${t.length} chars` : "system prompt"
    },
  },
  "tools-resolved": {
    id: "tools-resolved",
    family: "context",
    label: "Tools",
    severity: "info",
    instanceKey: () => "context:tools",
    summary: (p) => {
      const tools = Array.isArray(p.tools) ? p.tools : []
      return `${tools.length} tool${tools.length === 1 ? "" : "s"}`
    },
  },
  "tools-filtered": {
    id: "tools-filtered",
    family: "context",
    label: "Tools filtered",
    severity: "info",
    summary: (p) => str(p.reason, `kept ${num(p.kept) ?? "?"}`),
  },
  iteration: {
    id: "iteration",
    family: "telemetry",
    label: "Iteration",
    severity: "info",
    summary: (p) => `${num(p.current) ?? "?"}/${num(p.max) ?? "?"}`,
  },
  thinking: {
    id: "thinking",
    family: "telemetry",
    label: "Thinking",
    severity: "info",
    summary: () => "thinking",
  },
  "tool-call": {
    id: "tool-call",
    family: "work",
    label: "Tool",
    severity: "info",
    summary: (p) =>
      str(p.tool, "tool") + (str(p.argsSummary) ? ` · ${truncate(str(p.argsSummary), 40)}` : ""),
  },
  "tool-result": {
    id: "tool-result",
    family: "work",
    label: "Result",
    severity: "info",
    summary: (p) => truncate(str(p.text, "done"), 48),
  },
  "tool-error": {
    id: "tool-error",
    family: "work",
    label: "Tool error",
    severity: "error",
    summary: (p) => truncate(str(p.text, "failed"), 48),
  },
  answer: {
    id: "answer",
    family: "answer",
    label: "Answer",
    severity: "info",
    summary: (p) => truncate(str(p.text, "answer"), 64),
  },
  error: {
    id: "error",
    family: "error",
    label: "Error",
    severity: "error",
    summary: (p) => truncate(str(p.text, "error"), 64),
  },
  usage: {
    id: "usage",
    family: "telemetry",
    label: "Usage",
    severity: "info",
    summary: (p) => `${num(p.totalTokens) ?? 0} tokens`,
  },
  "llm-request": {
    id: "llm-request",
    family: "call",
    label: "Call",
    severity: "info",
    instanceKey: (p) => `call:${num(p.iteration) ?? "?"}`,
    summary: (p) => `iter ${(num(p.iteration) ?? 0) + 1}`,
  },
  "llm-response": {
    id: "llm-response",
    family: "call",
    label: "Received",
    severity: "info",
    summary: (p) => {
      const ms = num(p.durationMs)
      const tools = Array.isArray(p.toolCalls) ? p.toolCalls.length : 0
      if (tools > 0) return `${tools} tool${tools === 1 ? "" : "s"}${ms != null ? ` · ${ms}ms` : ""}`
      return ms != null ? `${ms}ms` : "reply"
    },
  },
  planning_preflight: {
    id: "planning_preflight",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: () => "plan",
    summary: () => "Preparing…",
  },
  "planner-decision": {
    id: "planner-decision",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: (p) => (p.shouldPlan === false || p.route === "direct" ? "direct" : "plan"),
    summary: (p) => str(p.reason, p.shouldPlan === false ? "direct" : "orchestrated"),
  },
  "planner-generating": {
    id: "planner-generating",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: () => "plan",
    summary: () => "Generating…",
  },
  "planner-plan-generated": {
    id: "planner-plan-generated",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: () => "plan",
    summary: (p) => {
      const n = num(p.stepCount) ?? (Array.isArray(p.steps) ? p.steps.length : 0)
      return `${n} step${n === 1 ? "" : "s"}`
    },
  },
  "planner-runtime-compiled": {
    id: "planner-runtime-compiled",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: () => "plan",
    summary: () => "Runtime compiled",
  },
  "planner-generation-failed": {
    id: "planner-generation-failed",
    family: "plan",
    label: "Plan",
    severity: "error",
    instanceKey: () => "plan",
    summary: () => "Generation failed",
  },
  "planner-validation-failed": {
    id: "planner-validation-failed",
    family: "plan",
    label: "Plan",
    severity: "error",
    instanceKey: () => "plan",
    summary: () => "Validation failed",
  },
  "planner-validation-remediated": {
    id: "planner-validation-remediated",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: () => "plan",
    summary: () => "Validation remediated",
  },
  "planner-validation-warnings": {
    id: "planner-validation-warnings",
    family: "plan",
    label: "Plan",
    severity: "warn",
    instanceKey: () => "plan",
    summary: (p) => `${num(p.warningCount) ?? 0} warnings`,
  },
  "planner-output-root-forced": {
    id: "planner-output-root-forced",
    family: "plan",
    label: "Plan",
    severity: "info",
    instanceKey: () => "plan",
    summary: (p) => truncate(str(p.outputRoot, "output root"), 40),
  },
  "planner-prompt-budget": {
    id: "planner-prompt-budget",
    family: "telemetry",
    label: "Prompt budget",
    severity: "info",
    summary: (p) => (p.constrained ? "constrained" : "ok"),
  },
  "planner-pipeline-start": {
    id: "planner-pipeline-start",
    family: "pipeline",
    label: "Pipeline",
    severity: "info",
    // Stable across start/end/budget — bare "pipeline" so terminals merge into
    // the open attempt instead of emitting a second root card ("attempt 1" + "success").
    instanceKey: () => "pipeline",
    summary: (p) => `attempt ${num(p.attempt) ?? 1}`,
  },
  "planner-pipeline-end": {
    id: "planner-pipeline-end",
    family: "pipeline",
    label: "Pipeline",
    severity: "info",
    instanceKey: () => "pipeline",
    summary: (p) => str(p.status, "done"),
  },
  "planner-budget-extended": {
    id: "planner-budget-extended",
    family: "pipeline",
    label: "Pipeline",
    severity: "info",
    instanceKey: () => "pipeline",
    summary: (p) => `budget → ${num(p.effectiveBudget) ?? "?"}`,
  },
  "planner-step-start": {
    id: "planner-step-start",
    family: "step",
    label: "Subagent",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => {
      const type = str(p.stepType)
      return type === "subagent_task" ? "running" : humanize(type || "running")
    },
  },
  "planner-step-transition": {
    id: "planner-step-transition",
    family: "step",
    label: "Step",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => `${str(p.phase)} · ${str(p.state)}`,
  },
  "planner-step-end": {
    id: "planner-step-end",
    family: "step",
    label: "Step",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => {
      const status = str(p.status, "done")
      const ok = status === "pass" || status === "success"
      return ok ? "done" : truncate(str(p.error, status), 48)
    },
  },
  "planner-delegation-start": {
    id: "planner-delegation-start",
    family: "step",
    label: "Subagent",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => truncate(str(p.goal, "delegating")),
  },
  "planner-delegation-iteration": {
    id: "planner-delegation-iteration",
    family: "step",
    label: "Subagent",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: () => "running",
  },
  "planner-delegation-end": {
    id: "planner-delegation-end",
    family: "step",
    label: "Subagent",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => (str(p.status) === "done" ? "done" : truncate(str(p.error, "failed"))),
  },
  "planner-delegation-decision": {
    id: "planner-delegation-decision",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    summary: (p) => str(p.reason, p.shouldDelegate ? "delegate" : "skip"),
  },
  "planner-verification": {
    id: "planner-verification",
    family: "verify",
    label: "Verifying",
    severity: "info",
    instanceKey: () => "verify",
    summary: (p) => {
      const overall = str(p.overall, "?")
      const conf = num(p.confidence)
      return conf != null ? `${overall} · ${Math.round(conf * 100)}%` : overall
    },
  },
  "planner-verification-followup": {
    id: "planner-verification-followup",
    family: "verify",
    label: "Verifying",
    severity: "warn",
    instanceKey: () => "verify",
    summary: (p) => {
      const steps = Array.isArray(p.requestedSteps) ? p.requestedSteps.length : 0
      return `follow-up · ${steps} step${steps === 1 ? "" : "s"}`
    },
  },
  "planner-issue-timeline": {
    id: "planner-issue-timeline",
    family: "verify",
    label: "Issues",
    severity: "warn",
    summary: (p) => {
      const issues = Array.isArray(p.issues) ? p.issues.length : 0
      return `${issues} issue${issues === 1 ? "" : "s"}`
    },
  },
  "planner-repair-plan": {
    id: "planner-repair-plan",
    family: "repair",
    label: "Repairing",
    severity: "warn",
    instanceKey: (p) => `repair:${num(p.attempt) ?? 1}`,
    summary: (p) => {
      const tasks = Array.isArray(p.tasks) ? p.tasks.length : 0
      return `attempt ${num(p.attempt) ?? 1} · ${tasks} task${tasks === 1 ? "" : "s"}`
    },
  },
  "planner-retry": {
    id: "planner-retry",
    family: "repair",
    label: "Repairing",
    severity: "warn",
    instanceKey: (p) => `repair:${num(p.attempt) ?? 1}`,
    summary: (p) => str(p.reason, `retry ${num(p.attempt) ?? 1}`),
  },
  "planner-retry-skipped": {
    id: "planner-retry-skipped",
    family: "repair",
    label: "Repairing",
    severity: "info",
    summary: (p) => str(p.reason, "skipped"),
  },
  "planner-retry-skip": {
    id: "planner-retry-skip",
    family: "step",
    label: "Step",
    severity: "info",
    instanceKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => `skipped — ${str(p.reason)}`,
  },
  "planner-retry-abort": {
    id: "planner-retry-abort",
    family: "repair",
    label: "Repairing",
    severity: "error",
    summary: (p) => str(p.reason, "aborted"),
  },
  "planner-escalation": {
    id: "planner-escalation",
    family: "repair",
    label: "Repairing",
    severity: "warn",
    instanceKey: (p) => `repair:${num(p.attempt) ?? 1}`,
    summary: (p) => `${str(p.action)} · ${str(p.reason)}`,
  },
  "planner-sql-quality": {
    id: "planner-sql-quality",
    family: "work",
    label: "SQL quality",
    severity: "info",
    summary: (p) =>
      str(p.phase, "sql") + (str(p.validationCode) ? ` · ${str(p.validationCode)}` : ""),
  },
  "sync-progress": {
    id: "sync-progress",
    family: "sync",
    label: "Sync",
    severity: "info",
    summary: (p) => str(p.headline, str(p.detail, str(p.status, "sync"))),
  },
  "user-input-request": {
    id: "user-input-request",
    family: "input",
    label: "Waiting on user",
    severity: "info",
    summary: (p) => truncate(str(p.question, "input")),
  },
  "user-input-response": {
    id: "user-input-response",
    family: "input",
    label: "User answered",
    severity: "info",
    summary: (p) => truncate(str(p.text, "answered")),
  },
  "delegation-start": {
    id: "delegation-start",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    summary: (p) => truncate(str(p.goal, "delegating")),
  },
  "delegation-iteration": {
    id: "delegation-iteration",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    summary: (p) => `${num(p.iteration) ?? "?"}/${num(p.maxIterations) ?? "?"}`,
  },
  "delegation-end": {
    id: "delegation-end",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    summary: (p) => str(p.status, "done"),
  },
  "delegation-parallel-start": {
    id: "delegation-parallel-start",
    family: "delegation",
    label: "Parallel",
    severity: "info",
    summary: (p) => `${num(p.taskCount) ?? 0} tasks`,
  },
  "delegation-parallel-end": {
    id: "delegation-parallel-end",
    family: "delegation",
    label: "Parallel",
    severity: "info",
    summary: (p) => `${num(p.fulfilled) ?? 0}/${num(p.taskCount) ?? 0} done`,
  },
  nudge: {
    id: "nudge",
    family: "telemetry",
    label: "Nudge",
    severity: "info",
    summary: (p) => truncate(str(p.message, str(p.tag, "nudge"))),
  },
  workspace_diff: {
    id: "workspace_diff",
    family: "telemetry",
    label: "Workspace",
    severity: "info",
    summary: () => "diff",
  },
  workspace_diff_applied: {
    id: "workspace_diff_applied",
    family: "telemetry",
    label: "Workspace",
    severity: "info",
    summary: () => "applied",
  },
  direct_loop_fallback: {
    id: "direct_loop_fallback",
    family: "misc",
    label: "Fallback",
    severity: "info",
    summary: (p) => str(p.reason, str(p.source)),
  },
}

/**
 * High-traffic SSE EventType → descriptor.
 * Unknown types fall back via `lookupEventDescriptor`.
 */
export const SSE_EVENT_CATALOG: Readonly<Record<string, EventDescriptor>> = {
  "run.queued": {
    id: "run.queued",
    family: "run",
    label: "Run queued",
    severity: "info",
    summary: () => "queued",
  },
  "run.started": {
    id: "run.started",
    family: "run",
    label: "Run started",
    severity: "info",
    summary: () => "started",
  },
  "run.completed": {
    id: "run.completed",
    family: "run",
    label: "Run completed",
    severity: "info",
    summary: () => "completed",
  },
  "run.failed": {
    id: "run.failed",
    family: "run",
    label: "Run failed",
    severity: "error",
    summary: (p) => truncate(str(p.error, str(p.message, "failed"))),
  },
  "run.cancelled": {
    id: "run.cancelled",
    family: "run",
    label: "Run cancelled",
    severity: "warn",
    summary: () => "cancelled",
  },
  "step.started": {
    id: "step.started",
    family: "tool",
    label: "Step",
    severity: "info",
    summary: stepStartedSummary,
  },
  "step.completed": {
    id: "step.completed",
    family: "tool",
    label: "Step",
    severity: "info",
    summary: stepCompletedSummary,
  },
  "step.failed": {
    id: "step.failed",
    family: "tool",
    label: "Step",
    severity: "error",
    summary: stepFailedSummary,
  },
  "tool.invoked": {
    id: "tool.invoked",
    family: "tool",
    label: "Tool",
    severity: "info",
    summary: (p) => resolveToolName(p),
  },
  "tool.completed": {
    id: "tool.completed",
    family: "tool",
    label: "Tool done",
    severity: "info",
    summary: (p) => stepCompletedSummary(p),
  },
  "tool.failed": {
    id: "tool.failed",
    family: "tool",
    label: "Tool failed",
    severity: "error",
    summary: (p) => stepFailedSummary(p),
  },
  "debug.trace": {
    id: "debug.trace",
    family: "telemetry",
    label: "Trace",
    severity: "info",
    summary: (p) => {
      const entry = p.entry
      if (entry && typeof entry === "object" && entry !== null && "kind" in entry) {
        const kind = str((entry as EventPayload).kind, "trace")
        const d = TRACE_EVENT_CATALOG[kind]
        if (d) return d.summary(entry as EventPayload)
        return kind
      }
      return "trace"
    },
  },
  "approval.required": {
    id: "approval.required",
    family: "input",
    label: "Approval required",
    severity: "warn",
    summary: (p) => str(p.tool, "approval"),
  },
  "user_input.required": {
    id: "user_input.required",
    family: "input",
    label: "Input required",
    severity: "info",
    summary: (p) => truncate(str(p.question, "input")),
  },
  "sync.preview.completed": {
    id: "sync.preview.completed",
    family: "sync",
    label: "Preview complete",
    severity: "info",
    summary: () => "preview complete",
  },
  "sync.preview.table.start": {
    id: "sync.preview.table.start",
    family: "sync",
    label: "Table scan",
    severity: "info",
    summary: (p) => str(p.table, str(p.name, "table")),
  },
  "answer.chunk": {
    id: "answer.chunk",
    family: "answer",
    label: "Answer",
    severity: "info",
    summary: () => "chunk",
  },
  "delegation.started": {
    id: "delegation.started",
    family: "delegation",
    label: "Delegation started",
    severity: "info",
    summary: (p) => truncate(str(p.goal, "delegation")),
  },
  "delegation.ended": {
    id: "delegation.ended",
    family: "delegation",
    label: "Delegation ended",
    severity: "info",
    summary: (p) => str(p.status, "ended"),
  },
  "planner.step.started": {
    id: "planner.step.started",
    family: "step",
    label: "Planner step",
    severity: "info",
    summary: (p) => stepName(p),
  },
  "planner.step.completed": {
    id: "planner.step.completed",
    family: "step",
    label: "Planner step",
    severity: "info",
    summary: (p) => `${stepName(p)} · done`,
  },
  "run.user_safe_failure": {
    id: "run.user_safe_failure",
    family: "run",
    label: "User safe failure",
    severity: "error",
    summary: () => "user safe failure",
  },
  "agent.started": {
    id: "agent.started",
    family: "run",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "agent.completed": {
    id: "agent.completed",
    family: "run",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "agent.failed": {
    id: "agent.failed",
    family: "run",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "agent.cancelled": {
    id: "agent.cancelled",
    family: "run",
    label: "Cancelled",
    severity: "error",
    summary: () => "cancelled",
  },
  "agent.thinking": {
    id: "agent.thinking",
    family: "telemetry",
    label: "Thinking",
    severity: "info",
    summary: () => "thinking",
  },
  "agent.user_safe_failure": {
    id: "agent.user_safe_failure",
    family: "run",
    label: "User safe failure",
    severity: "error",
    summary: () => "user safe failure",
  },
  "tool.blocked": {
    id: "tool.blocked",
    family: "tool",
    label: "Blocked",
    severity: "info",
    summary: () => "blocked",
  },
  "tool.denied": {
    id: "tool.denied",
    family: "tool",
    label: "Denied",
    severity: "info",
    summary: () => "denied",
  },
  "tool_call.executing": {
    id: "tool_call.executing",
    family: "tool",
    label: "Tool call",
    severity: "info",
    summary: (p) => toolCallSummary(p, "executing"),
  },
  "tool_call.completed": {
    id: "tool_call.completed",
    family: "tool",
    label: "Tool call",
    severity: "info",
    summary: (p) => toolCallSummary(p, "completed"),
  },
  "tool_call.killed": {
    id: "tool_call.killed",
    family: "tool",
    label: "Tool call",
    severity: "info",
    summary: (p) => toolCallSummary(p, "killed"),
  },
  "approval.resolved": {
    id: "approval.resolved",
    family: "input",
    label: "Resolved",
    severity: "info",
    summary: () => "resolved",
  },
  "user_input.response": {
    id: "user_input.response",
    family: "input",
    label: "Response",
    severity: "info",
    summary: () => "response",
  },
  "stream.reset": {
    id: "stream.reset",
    family: "misc",
    label: "Reset",
    severity: "info",
    summary: () => "reset",
  },
  "usage.updated": {
    id: "usage.updated",
    family: "telemetry",
    label: "Updated",
    severity: "info",
    summary: () => "updated",
  },
  "checkpoint.saved": {
    id: "checkpoint.saved",
    family: "telemetry",
    label: "Saved",
    severity: "info",
    summary: () => "saved",
  },
  "api.request": {
    id: "api.request",
    family: "telemetry",
    label: "Request",
    severity: "info",
    summary: () => "request",
  },
  "log.detail": {
    id: "log.detail",
    family: "misc",
    label: "Detail",
    severity: "info",
    summary: () => "detail",
  },
  "events.connected": {
    id: "events.connected",
    family: "telemetry",
    label: "Connected",
    severity: "info",
    summary: () => "connected",
  },
  "session.presence.tick": {
    id: "session.presence.tick",
    family: "misc",
    label: "Tick",
    severity: "info",
    summary: () => "tick",
  },
  "delegation.iteration": {
    id: "delegation.iteration",
    family: "delegation",
    label: "Iteration",
    severity: "info",
    summary: () => "iteration",
  },
  "delegation.completed": {
    id: "delegation.completed",
    family: "delegation",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "delegation.failed": {
    id: "delegation.failed",
    family: "delegation",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "delegation.parallel-started": {
    id: "delegation.parallel-started",
    family: "delegation",
    label: "Parallel started",
    severity: "info",
    summary: () => "parallel started",
  },
  "delegation.parallel-ended": {
    id: "delegation.parallel-ended",
    family: "delegation",
    label: "Parallel ended",
    severity: "info",
    summary: () => "parallel ended",
  },
  "planner.started": {
    id: "planner.started",
    family: "plan",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "planner.completed": {
    id: "planner.completed",
    family: "plan",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "planner.failed": {
    id: "planner.failed",
    family: "plan",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "planner.verified": {
    id: "planner.verified",
    family: "plan",
    label: "Verified",
    severity: "info",
    summary: () => "verified",
  },
  "planner.verification": {
    id: "planner.verification",
    family: "plan",
    label: "Verification",
    severity: "info",
    summary: () => "verification",
  },
  "planner.verification.followup": {
    id: "planner.verification.followup",
    family: "plan",
    label: "Followup",
    severity: "info",
    summary: () => "followup",
  },
  "planner.pipeline.started": {
    id: "planner.pipeline.started",
    family: "plan",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "planner.platform.unconfigured": {
    id: "planner.platform.unconfigured",
    family: "plan",
    label: "Unconfigured",
    severity: "info",
    summary: () => "unconfigured",
  },
  "planner.runtime.compiled": {
    id: "planner.runtime.compiled",
    family: "plan",
    label: "Compiled",
    severity: "info",
    summary: () => "compiled",
  },
  "planner.validation.failed": {
    id: "planner.validation.failed",
    family: "plan",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "planner.validation.remediated": {
    id: "planner.validation.remediated",
    family: "plan",
    label: "Remediated",
    severity: "info",
    summary: () => "remediated",
  },
  "planner.issue.timeline": {
    id: "planner.issue.timeline",
    family: "plan",
    label: "Timeline",
    severity: "info",
    summary: () => "timeline",
  },
  "planner.repair.plan": {
    id: "planner.repair.plan",
    family: "plan",
    label: "Plan",
    severity: "info",
    summary: () => "plan",
  },
  "planner.step.transition": {
    id: "planner.step.transition",
    family: "plan",
    label: "Transition",
    severity: "info",
    summary: () => "transition",
  },
  "planner.delegation.started": {
    id: "planner.delegation.started",
    family: "plan",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "planner.delegation.iteration": {
    id: "planner.delegation.iteration",
    family: "plan",
    label: "Iteration",
    severity: "info",
    summary: () => "iteration",
  },
  "planner.delegation.ended": {
    id: "planner.delegation.ended",
    family: "plan",
    label: "Ended",
    severity: "info",
    summary: () => "ended",
  },
  "sync.preview": {
    id: "sync.preview",
    family: "sync",
    label: "Preview",
    severity: "info",
    summary: () => "preview",
  },
  "sync.preview.started": {
    id: "sync.preview.started",
    family: "sync",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "sync.preview.failed": {
    id: "sync.preview.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "sync.preview.table.done": {
    id: "sync.preview.table.done",
    family: "sync",
    label: "Done",
    severity: "info",
    summary: () => "done",
  },
  "sync.preview.table.failed": {
    id: "sync.preview.table.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "sync.retry": {
    id: "sync.retry",
    family: "sync",
    label: "Retry",
    severity: "info",
    summary: () => "retry",
  },
  "sync.scan.discovered": {
    id: "sync.scan.discovered",
    family: "sync",
    label: "Discovered",
    severity: "info",
    summary: () => "discovered",
  },
  "sync.scan.entity.start": {
    id: "sync.scan.entity.start",
    family: "sync",
    label: "Start",
    severity: "info",
    summary: () => "start",
  },
  "sync.execute": {
    id: "sync.execute",
    family: "sync",
    label: "Execute",
    severity: "info",
    summary: () => "execute",
  },
  "sync.execute.start": {
    id: "sync.execute.start",
    family: "sync",
    label: "Start",
    severity: "info",
    summary: () => "start",
  },
  "sync.execute.started": {
    id: "sync.execute.started",
    family: "sync",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "sync.execute.completed": {
    id: "sync.execute.completed",
    family: "sync",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "sync.execute.skipped": {
    id: "sync.execute.skipped",
    family: "sync",
    label: "Skipped",
    severity: "info",
    summary: () => "skipped",
  },
  "sync.execute.failed": {
    id: "sync.execute.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "sync.execute.cancelled": {
    id: "sync.execute.cancelled",
    family: "sync",
    label: "Cancelled",
    severity: "error",
    summary: () => "cancelled",
  },
  "sync.execute.step": {
    id: "sync.execute.step",
    family: "sync",
    label: "Step",
    severity: "info",
    summary: () => "step",
  },
  "sync.execute.step.failed": {
    id: "sync.execute.step.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "sync.execute.table.start": {
    id: "sync.execute.table.start",
    family: "sync",
    label: "Start",
    severity: "info",
    summary: () => "start",
  },
  "sync.execute.table.done": {
    id: "sync.execute.table.done",
    family: "sync",
    label: "Done",
    severity: "info",
    summary: () => "done",
  },
  "sync.execute.archive.probe": {
    id: "sync.execute.archive.probe",
    family: "sync",
    label: "Probe",
    severity: "info",
    summary: () => "probe",
  },
  "sync.execute.archive.probe.batch": {
    id: "sync.execute.archive.probe.batch",
    family: "sync",
    label: "Batch",
    severity: "info",
    summary: () => "batch",
  },
  "sync.execute.archive.skipped": {
    id: "sync.execute.archive.skipped",
    family: "sync",
    label: "Skipped",
    severity: "info",
    summary: () => "skipped",
  },
  "sync.agent.preview": {
    id: "sync.agent.preview",
    family: "sync",
    label: "Preview",
    severity: "info",
    summary: () => "preview",
  },
  "sync.agent.execute.started": {
    id: "sync.agent.execute.started",
    family: "sync",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "sync.agent.execute.completed": {
    id: "sync.agent.execute.completed",
    family: "sync",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "sync_env.update": {
    id: "sync_env.update",
    family: "misc",
    label: "Update",
    severity: "info",
    summary: () => "update",
  },
  "sync_env.reset": {
    id: "sync_env.reset",
    family: "misc",
    label: "Reset",
    severity: "info",
    summary: () => "reset",
  },
  "freeze_window.upserted": {
    id: "freeze_window.upserted",
    family: "misc",
    label: "Upserted",
    severity: "info",
    summary: () => "upserted",
  },
  "freeze_window.deleted": {
    id: "freeze_window.deleted",
    family: "misc",
    label: "Deleted",
    severity: "info",
    summary: () => "deleted",
  },
  "sync.proposer.schedule.saved": {
    id: "sync.proposer.schedule.saved",
    family: "sync",
    label: "Saved",
    severity: "info",
    summary: () => "saved",
  },
  "sync.proposer.schedule.deleted": {
    id: "sync.proposer.schedule.deleted",
    family: "sync",
    label: "Deleted",
    severity: "info",
    summary: () => "deleted",
  },
  "sync.policy.saved": {
    id: "sync.policy.saved",
    family: "sync",
    label: "Saved",
    severity: "info",
    summary: () => "saved",
  },
  "sync.policy.deleted": {
    id: "sync.policy.deleted",
    family: "sync",
    label: "Deleted",
    severity: "info",
    summary: () => "deleted",
  },
  "sync.notification.route.saved": {
    id: "sync.notification.route.saved",
    family: "sync",
    label: "Saved",
    severity: "info",
    summary: () => "saved",
  },
  "sync.notification.route.deleted": {
    id: "sync.notification.route.deleted",
    family: "sync",
    label: "Deleted",
    severity: "info",
    summary: () => "deleted",
  },
  "sync.definitions.published": {
    id: "sync.definitions.published",
    family: "sync",
    label: "Published",
    severity: "info",
    summary: () => "published",
  },
  "sync.catalog.version.committed": {
    id: "sync.catalog.version.committed",
    family: "sync",
    label: "Committed",
    severity: "info",
    summary: () => "committed",
  },
  "entity_registry.saved": {
    id: "entity_registry.saved",
    family: "misc",
    label: "Saved",
    severity: "info",
    summary: () => "saved",
  },
  "entity_registry.retired": {
    id: "entity_registry.retired",
    family: "misc",
    label: "Retired",
    severity: "info",
    summary: () => "retired",
  },
  "entity_registry.strategy.saved": {
    id: "entity_registry.strategy.saved",
    family: "misc",
    label: "Saved",
    severity: "info",
    summary: () => "saved",
  },
  "entity_registry.strategy.retired": {
    id: "entity_registry.strategy.retired",
    family: "misc",
    label: "Retired",
    severity: "info",
    summary: () => "retired",
  },
  "entity_registry.imported": {
    id: "entity_registry.imported",
    family: "misc",
    label: "Imported",
    severity: "info",
    summary: () => "imported",
  },
  "sync.proposer.run.started": {
    id: "sync.proposer.run.started",
    family: "sync",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "sync.proposer.run.completed": {
    id: "sync.proposer.run.completed",
    family: "sync",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "sync.proposer.run.failed": {
    id: "sync.proposer.run.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "sync.proposer.run.cancelled": {
    id: "sync.proposer.run.cancelled",
    family: "sync",
    label: "Cancelled",
    severity: "error",
    summary: () => "cancelled",
  },
  "sync.proposal.created": {
    id: "sync.proposal.created",
    family: "sync",
    label: "Created",
    severity: "info",
    summary: () => "created",
  },
  "sync.proposal.annotated": {
    id: "sync.proposal.annotated",
    family: "sync",
    label: "Annotated",
    severity: "info",
    summary: () => "annotated",
  },
  "sync.proposal.status.changed": {
    id: "sync.proposal.status.changed",
    family: "sync",
    label: "Changed",
    severity: "info",
    summary: () => "changed",
  },
  "sync.approval.requested": {
    id: "sync.approval.requested",
    family: "sync",
    label: "Requested",
    severity: "info",
    summary: () => "requested",
  },
  "sync.approval.granted": {
    id: "sync.approval.granted",
    family: "sync",
    label: "Granted",
    severity: "info",
    summary: () => "granted",
  },
  "sync.approval.rejected": {
    id: "sync.approval.rejected",
    family: "sync",
    label: "Rejected",
    severity: "info",
    summary: () => "rejected",
  },
  "sync.approval.expired": {
    id: "sync.approval.expired",
    family: "sync",
    label: "Expired",
    severity: "info",
    summary: () => "expired",
  },
  "sync.approval.bypassed": {
    id: "sync.approval.bypassed",
    family: "sync",
    label: "Bypassed",
    severity: "info",
    summary: () => "bypassed",
  },
  "sync.evidence.sealed": {
    id: "sync.evidence.sealed",
    family: "sync",
    label: "Sealed",
    severity: "info",
    summary: () => "sealed",
  },
  "sync.verification.completed": {
    id: "sync.verification.completed",
    family: "sync",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "sync.verification.failed": {
    id: "sync.verification.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "sync.notification.delivered": {
    id: "sync.notification.delivered",
    family: "sync",
    label: "Delivered",
    severity: "info",
    summary: () => "delivered",
  },
  "sync.notification.failed": {
    id: "sync.notification.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "llm.interaction.required": {
    id: "llm.interaction.required",
    family: "misc",
    label: "Required",
    severity: "info",
    summary: () => "required",
  },
  "llm.interaction.cleared": {
    id: "llm.interaction.cleared",
    family: "misc",
    label: "Cleared",
    severity: "info",
    summary: () => "cleared",
  },
  "memory.ingested": {
    id: "memory.ingested",
    family: "telemetry",
    label: "Ingested",
    severity: "info",
    summary: () => "ingested",
  },
  "memory.filtered": {
    id: "memory.filtered",
    family: "telemetry",
    label: "Filtered",
    severity: "info",
    summary: () => "filtered",
  },
  "memory.retrieved": {
    id: "memory.retrieved",
    family: "telemetry",
    label: "Retrieved",
    severity: "info",
    summary: () => "retrieved",
  },
  "memory.consolidated": {
    id: "memory.consolidated",
    family: "telemetry",
    label: "Consolidated",
    severity: "info",
    summary: () => "consolidated",
  },
  "attachment.uploaded": {
    id: "attachment.uploaded",
    family: "telemetry",
    label: "Uploaded",
    severity: "info",
    summary: () => "uploaded",
  },
  "attachment.imported": {
    id: "attachment.imported",
    family: "telemetry",
    label: "Imported",
    severity: "info",
    summary: () => "imported",
  },
  "attachment.promoted": {
    id: "attachment.promoted",
    family: "telemetry",
    label: "Promoted",
    severity: "info",
    summary: () => "promoted",
  },
  "attachment.deleted": {
    id: "attachment.deleted",
    family: "telemetry",
    label: "Deleted",
    severity: "info",
    summary: () => "deleted",
  },
  "attachment.pruned": {
    id: "attachment.pruned",
    family: "telemetry",
    label: "Pruned",
    severity: "info",
    summary: () => "pruned",
  },
  "effect.recorded": {
    id: "effect.recorded",
    family: "misc",
    label: "Recorded",
    severity: "info",
    summary: () => "recorded",
  },
  "snapshot.captured": {
    id: "snapshot.captured",
    family: "misc",
    label: "Captured",
    severity: "info",
    summary: () => "captured",
  },
  "rollback.started": {
    id: "rollback.started",
    family: "telemetry",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "rollback.effect": {
    id: "rollback.effect",
    family: "telemetry",
    label: "Effect",
    severity: "info",
    summary: () => "effect",
  },
  "rollback.blocked": {
    id: "rollback.blocked",
    family: "telemetry",
    label: "Blocked",
    severity: "info",
    summary: () => "blocked",
  },
  "rollback.completed": {
    id: "rollback.completed",
    family: "telemetry",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "message.queued": {
    id: "message.queued",
    family: "telemetry",
    label: "Queued",
    severity: "info",
    summary: () => "queued",
  },
  "message.delivered": {
    id: "message.delivered",
    family: "telemetry",
    label: "Delivered",
    severity: "info",
    summary: () => "delivered",
  },
  "message.failed": {
    id: "message.failed",
    family: "error",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "conversation.message": {
    id: "conversation.message",
    family: "telemetry",
    label: "Message",
    severity: "info",
    summary: () => "message",
  },
  "agent.bus.message": {
    id: "agent.bus.message",
    family: "run",
    label: "Message",
    severity: "info",
    summary: () => "message",
  },
  "agent.help.requested": {
    id: "agent.help.requested",
    family: "run",
    label: "Requested",
    severity: "error",
    summary: () => "requested",
  },
  "audit": {
    id: "audit",
    family: "telemetry",
    label: "Audit",
    severity: "info",
    summary: () => "audit",
  },
  "notification": {
    id: "notification",
    family: "telemetry",
    label: "Notification",
    severity: "info",
    summary: () => "notification",
  },
  "sync.preview.sql": {
    id: "sync.preview.sql",
    family: "sync",
    label: "Sql",
    severity: "info",
    summary: () => "sql",
  },
  "sync.execute.sql": {
    id: "sync.execute.sql",
    family: "sync",
    label: "Sql",
    severity: "info",
    summary: () => "sql",
  },
  "sync.execute.http": {
    id: "sync.execute.http",
    family: "sync",
    label: "Http",
    severity: "info",
    summary: () => "http",
  },
  "sync.catalog.sql": {
    id: "sync.catalog.sql",
    family: "sync",
    label: "Sql",
    severity: "info",
    summary: () => "sql",
  },
  "sync.discovery.sql": {
    id: "sync.discovery.sql",
    family: "sync",
    label: "Sql",
    severity: "info",
    summary: () => "sql",
  },
  "bridge.preview.started": {
    id: "bridge.preview.started",
    family: "sync",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "bridge.preview.completed": {
    id: "bridge.preview.completed",
    family: "sync",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "bridge.preview.failed": {
    id: "bridge.preview.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
  "bridge.run.started": {
    id: "bridge.run.started",
    family: "sync",
    label: "Started",
    severity: "info",
    summary: () => "started",
  },
  "bridge.run.progress": {
    id: "bridge.run.progress",
    family: "sync",
    label: "Progress",
    severity: "info",
    summary: () => "progress",
  },
  "bridge.run.completed": {
    id: "bridge.run.completed",
    family: "sync",
    label: "Completed",
    severity: "info",
    summary: () => "completed",
  },
  "bridge.run.failed": {
    id: "bridge.run.failed",
    family: "sync",
    label: "Failed",
    severity: "error",
    summary: () => "failed",
  },
}

const UNKNOWN: EventDescriptor = {
  id: "unknown",
  family: "misc",
  label: "Event",
  severity: "info",
  summary: (p) => {
    const kind = str(p.kind, str(p.type, "event"))
    return humanize(kind)
  },
}

/** Lookup TraceEntry.kind or EventType. Never throws — unknown → generic descriptor. */
export function lookupEventDescriptor(id: string): EventDescriptor {
  return (
    TRACE_EVENT_CATALOG[id] ??
    SSE_EVENT_CATALOG[id] ?? { ...UNKNOWN, id, label: humanize(id) }
  )
}

/** Label for a trace kind or SSE type. */
export function eventLabel(id: string): string {
  return lookupEventDescriptor(id).label
}

/** Summary line from catalog. */
export function eventSummary(id: string, payload: EventPayload = {}): string {
  return lookupEventDescriptor(id).summary(payload)
}

/** Prefer TraceEntry.kind when embedded in debug.trace. */
export function describeDebugTracePayload(data: EventPayload): {
  label: string
  summary: string
} {
  const entry = data.entry
  if (entry && typeof entry === "object" && entry !== null) {
    const e = entry as EventPayload
    const kind = str(e.kind, "trace")
    const d = lookupEventDescriptor(kind)
    const label =
      d.family === "step" && str(e.stepName)
        ? str(e.stepType) === "subagent_task" || kind.includes("delegation")
          ? "Subagent"
          : "Step"
        : d.label
    const titleBit = d.family === "step" && str(e.stepName) ? ` ${stepName(e)}` : ""
    return {
      label: `${label}${titleBit}`.trim(),
      summary: d.summary(e),
    }
  }
  return { label: "Trace", summary: "trace" }
}

export function isTraceKind(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRACE_EVENT_CATALOG, id)
}

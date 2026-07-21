/**
 * Event catalog — single source of truth for how wire events present.
 *
 * Every `TraceEntry.kind` and high-traffic `EventType` gets one descriptor.
 * Widgets must not switch on kind/type strings for labels or outline roles —
 * look up the catalog (same dialect as tool-call-presentation).
 *
 * Add a row here when introducing a new BE event (after shared-enums).
 */

export type EventSeverity = "info" | "warn" | "error"

/** How the event participates in an outline tree. */
export type EventOutlineRole = "scope" | "leaf" | "ignore"

/** Structural family — ViewSpec nest rules key off these. */
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

export type EventDescriptor = {
  /** TraceEntry.kind or EventType string. */
  id: string
  family: EventFamily
  label: string
  severity: EventSeverity
  outline: EventOutlineRole
  /** Eligible for VS Code–style pin overlay. */
  sticky?: boolean
  /**
   * Nest / merge key while this scope is open.
   * Same key collapses consecutive scope updates (e.g. step:frontend_layer).
   */
  nestKey?: (payload: EventPayload) => string | null
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

/** TraceEntry.kind → descriptor. */
export const TRACE_EVENT_CATALOG: Readonly<Record<string, EventDescriptor>> = {
  goal: {
    id: "goal",
    family: "context",
    label: "Goal",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.text, "Goal")),
  },
  "system-prompt": {
    id: "system-prompt",
    family: "context",
    label: "Prompt",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: () => "context:prompt",
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
    outline: "scope",
    sticky: true,
    nestKey: () => "context:tools",
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
    outline: "leaf",
    summary: (p) => str(p.reason, `kept ${num(p.kept) ?? "?"}`),
  },
  iteration: {
    id: "iteration",
    family: "telemetry",
    label: "Iteration",
    severity: "info",
    outline: "ignore",
    summary: (p) => `${num(p.current) ?? "?"}/${num(p.max) ?? "?"}`,
  },
  thinking: {
    id: "thinking",
    family: "telemetry",
    label: "Thinking",
    severity: "info",
    outline: "ignore",
    summary: () => "thinking",
  },
  "tool-call": {
    id: "tool-call",
    family: "work",
    label: "Tool",
    severity: "info",
    outline: "leaf",
    summary: (p) =>
      str(p.tool, "tool") + (str(p.argsSummary) ? ` · ${truncate(str(p.argsSummary), 40)}` : ""),
  },
  "tool-result": {
    id: "tool-result",
    family: "work",
    label: "Result",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.text, "done"), 48),
  },
  "tool-error": {
    id: "tool-error",
    family: "work",
    label: "Tool error",
    severity: "error",
    outline: "leaf",
    summary: (p) => truncate(str(p.text, "failed"), 48),
  },
  answer: {
    id: "answer",
    family: "answer",
    label: "Answer",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.text, "answer"), 64),
  },
  error: {
    id: "error",
    family: "error",
    label: "Error",
    severity: "error",
    outline: "leaf",
    summary: (p) => truncate(str(p.text, "error"), 64),
  },
  usage: {
    id: "usage",
    family: "telemetry",
    label: "Usage",
    severity: "info",
    outline: "ignore",
    summary: (p) => `${num(p.totalTokens) ?? 0} tokens`,
  },
  "llm-request": {
    id: "llm-request",
    family: "call",
    label: "Call",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: (p) => `call:${num(p.iteration) ?? "?"}`,
    summary: (p) => `iter ${(num(p.iteration) ?? 0) + 1}`,
  },
  "llm-response": {
    id: "llm-response",
    family: "call",
    label: "Received",
    severity: "info",
    outline: "leaf",
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
    outline: "scope",
    sticky: true,
    nestKey: () => "plan",
    summary: () => "Preparing…",
  },
  "planner-decision": {
    id: "planner-decision",
    family: "plan",
    label: "Plan",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: (p) => (p.shouldPlan === false || p.route === "direct" ? "direct" : "plan"),
    summary: (p) => str(p.reason, p.shouldPlan === false ? "direct" : "orchestrated"),
  },
  "planner-generating": {
    id: "planner-generating",
    family: "plan",
    label: "Plan",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: () => "plan",
    summary: () => "Generating…",
  },
  "planner-plan-generated": {
    id: "planner-plan-generated",
    family: "plan",
    label: "Plan",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: () => "plan",
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
    outline: "scope",
    sticky: true,
    nestKey: () => "plan",
    summary: () => "Runtime compiled",
  },
  "planner-generation-failed": {
    id: "planner-generation-failed",
    family: "plan",
    label: "Plan",
    severity: "error",
    outline: "scope",
    nestKey: () => "plan",
    summary: () => "Generation failed",
  },
  "planner-validation-failed": {
    id: "planner-validation-failed",
    family: "plan",
    label: "Plan",
    severity: "error",
    outline: "scope",
    nestKey: () => "plan",
    summary: () => "Validation failed",
  },
  "planner-validation-remediated": {
    id: "planner-validation-remediated",
    family: "plan",
    label: "Plan",
    severity: "info",
    outline: "scope",
    nestKey: () => "plan",
    summary: () => "Validation remediated",
  },
  "planner-validation-warnings": {
    id: "planner-validation-warnings",
    family: "plan",
    label: "Plan",
    severity: "warn",
    outline: "scope",
    nestKey: () => "plan",
    summary: (p) => `${num(p.warningCount) ?? 0} warnings`,
  },
  "planner-output-root-forced": {
    id: "planner-output-root-forced",
    family: "plan",
    label: "Plan",
    severity: "info",
    outline: "scope",
    nestKey: () => "plan",
    summary: (p) => truncate(str(p.outputRoot, "output root"), 40),
  },
  "planner-prompt-budget": {
    id: "planner-prompt-budget",
    family: "telemetry",
    label: "Prompt budget",
    severity: "info",
    outline: "ignore",
    summary: (p) => (p.constrained ? "constrained" : "ok"),
  },
  "planner-pipeline-start": {
    id: "planner-pipeline-start",
    family: "pipeline",
    label: "Pipeline",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: (p) => `pipeline:${num(p.attempt) ?? 1}`,
    summary: (p) => `attempt ${num(p.attempt) ?? 1}`,
  },
  "planner-pipeline-end": {
    id: "planner-pipeline-end",
    family: "pipeline",
    label: "Pipeline",
    severity: "info",
    outline: "scope",
    nestKey: () => "pipeline",
    summary: (p) => str(p.status, "done"),
  },
  "planner-budget-extended": {
    id: "planner-budget-extended",
    family: "pipeline",
    label: "Pipeline",
    severity: "info",
    outline: "scope",
    nestKey: () => "pipeline",
    summary: (p) => `budget → ${num(p.effectiveBudget) ?? "?"}`,
  },
  "planner-step-start": {
    id: "planner-step-start",
    family: "step",
    label: "Subagent",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
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
    outline: "scope",
    sticky: true,
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => `${str(p.phase)} · ${str(p.state)}`,
  },
  "planner-step-end": {
    id: "planner-step-end",
    family: "step",
    label: "Step",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
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
    outline: "scope",
    sticky: true,
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => truncate(str(p.goal, "delegating")),
  },
  "planner-delegation-iteration": {
    id: "planner-delegation-iteration",
    family: "step",
    label: "Subagent",
    severity: "info",
    outline: "scope",
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: () => "running",
  },
  "planner-delegation-end": {
    id: "planner-delegation-end",
    family: "step",
    label: "Subagent",
    severity: "info",
    outline: "scope",
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => (str(p.status) === "done" ? "done" : truncate(str(p.error, "failed"))),
  },
  "planner-delegation-decision": {
    id: "planner-delegation-decision",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.reason, p.shouldDelegate ? "delegate" : "skip"),
  },
  "planner-verification": {
    id: "planner-verification",
    family: "verify",
    label: "Verifying",
    severity: "info",
    outline: "scope",
    sticky: true,
    nestKey: (p) => `verify:${num(p.verifierRound) ?? 1}`,
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
    outline: "scope",
    nestKey: () => "verify",
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
    outline: "leaf",
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
    outline: "scope",
    sticky: true,
    nestKey: (p) => `repair:${num(p.attempt) ?? 1}`,
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
    outline: "scope",
    sticky: true,
    nestKey: (p) => `repair:${num(p.attempt) ?? 1}`,
    summary: (p) => str(p.reason, `retry ${num(p.attempt) ?? 1}`),
  },
  "planner-retry-skipped": {
    id: "planner-retry-skipped",
    family: "repair",
    label: "Repairing",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.reason, "skipped"),
  },
  "planner-retry-skip": {
    id: "planner-retry-skip",
    family: "step",
    label: "Step",
    severity: "info",
    outline: "scope",
    nestKey: (p) => `step:${str(p.stepName, "step")}`,
    summary: (p) => `skipped — ${str(p.reason)}`,
  },
  "planner-retry-abort": {
    id: "planner-retry-abort",
    family: "repair",
    label: "Repairing",
    severity: "error",
    outline: "leaf",
    summary: (p) => str(p.reason, "aborted"),
  },
  "planner-escalation": {
    id: "planner-escalation",
    family: "repair",
    label: "Repairing",
    severity: "warn",
    outline: "scope",
    nestKey: (p) => `repair:${num(p.attempt) ?? 1}`,
    summary: (p) => `${str(p.action)} · ${str(p.reason)}`,
  },
  "planner-sql-quality": {
    id: "planner-sql-quality",
    family: "work",
    label: "SQL quality",
    severity: "info",
    outline: "leaf",
    summary: (p) =>
      str(p.phase, "sql") + (str(p.validationCode) ? ` · ${str(p.validationCode)}` : ""),
  },
  "sync-progress": {
    id: "sync-progress",
    family: "sync",
    label: "Sync",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.headline, str(p.detail, str(p.status, "sync"))),
  },
  "user-input-request": {
    id: "user-input-request",
    family: "input",
    label: "Waiting on user",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.question, "input")),
  },
  "user-input-response": {
    id: "user-input-response",
    family: "input",
    label: "User answered",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.text, "answered")),
  },
  "delegation-start": {
    id: "delegation-start",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.goal, "delegating")),
  },
  "delegation-iteration": {
    id: "delegation-iteration",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    outline: "ignore",
    summary: (p) => `${num(p.iteration) ?? "?"}/${num(p.maxIterations) ?? "?"}`,
  },
  "delegation-end": {
    id: "delegation-end",
    family: "delegation",
    label: "Delegation",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.status, "done"),
  },
  "delegation-parallel-start": {
    id: "delegation-parallel-start",
    family: "delegation",
    label: "Parallel",
    severity: "info",
    outline: "leaf",
    summary: (p) => `${num(p.taskCount) ?? 0} tasks`,
  },
  "delegation-parallel-end": {
    id: "delegation-parallel-end",
    family: "delegation",
    label: "Parallel",
    severity: "info",
    outline: "leaf",
    summary: (p) => `${num(p.fulfilled) ?? 0}/${num(p.taskCount) ?? 0} done`,
  },
  nudge: {
    id: "nudge",
    family: "telemetry",
    label: "Nudge",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.message, str(p.tag, "nudge"))),
  },
  workspace_diff: {
    id: "workspace_diff",
    family: "telemetry",
    label: "Workspace",
    severity: "info",
    outline: "ignore",
    summary: () => "diff",
  },
  workspace_diff_applied: {
    id: "workspace_diff_applied",
    family: "telemetry",
    label: "Workspace",
    severity: "info",
    outline: "ignore",
    summary: () => "applied",
  },
  direct_loop_fallback: {
    id: "direct_loop_fallback",
    family: "misc",
    label: "Fallback",
    severity: "info",
    outline: "ignore",
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
    outline: "leaf",
    summary: () => "queued",
  },
  "run.started": {
    id: "run.started",
    family: "run",
    label: "Run started",
    severity: "info",
    outline: "leaf",
    summary: () => "started",
  },
  "run.completed": {
    id: "run.completed",
    family: "run",
    label: "Run completed",
    severity: "info",
    outline: "leaf",
    summary: () => "completed",
  },
  "run.failed": {
    id: "run.failed",
    family: "run",
    label: "Run failed",
    severity: "error",
    outline: "leaf",
    summary: (p) => truncate(str(p.error, str(p.message, "failed"))),
  },
  "run.cancelled": {
    id: "run.cancelled",
    family: "run",
    label: "Run cancelled",
    severity: "warn",
    outline: "leaf",
    summary: () => "cancelled",
  },
  "step.started": {
    id: "step.started",
    family: "tool",
    label: "Step started",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.tool, str(p.name, "step")),
  },
  "step.completed": {
    id: "step.completed",
    family: "tool",
    label: "Step completed",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.tool, str(p.name, "done")),
  },
  "step.failed": {
    id: "step.failed",
    family: "tool",
    label: "Step failed",
    severity: "error",
    outline: "leaf",
    summary: (p) => truncate(str(p.error, str(p.tool, "failed"))),
  },
  "tool.invoked": {
    id: "tool.invoked",
    family: "tool",
    label: "Tool",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.tool, str(p.name, "invoked")),
  },
  "tool.completed": {
    id: "tool.completed",
    family: "tool",
    label: "Tool done",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.tool, "completed"),
  },
  "tool.failed": {
    id: "tool.failed",
    family: "tool",
    label: "Tool failed",
    severity: "error",
    outline: "leaf",
    summary: (p) => truncate(str(p.error, str(p.tool, "failed"))),
  },
  "debug.trace": {
    id: "debug.trace",
    family: "telemetry",
    label: "Trace",
    severity: "info",
    outline: "leaf",
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
    outline: "leaf",
    summary: (p) => str(p.tool, "approval"),
  },
  "user_input.required": {
    id: "user_input.required",
    family: "input",
    label: "Input required",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.question, "input")),
  },
  "sync.preview.completed": {
    id: "sync.preview.completed",
    family: "sync",
    label: "Preview complete",
    severity: "info",
    outline: "leaf",
    summary: () => "preview complete",
  },
  "sync.preview.table.start": {
    id: "sync.preview.table.start",
    family: "sync",
    label: "Table scan",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.table, str(p.name, "table")),
  },
  "answer.chunk": {
    id: "answer.chunk",
    family: "answer",
    label: "Answer",
    severity: "info",
    outline: "ignore",
    summary: () => "chunk",
  },
  "delegation.started": {
    id: "delegation.started",
    family: "delegation",
    label: "Delegation started",
    severity: "info",
    outline: "leaf",
    summary: (p) => truncate(str(p.goal, "delegation")),
  },
  "delegation.ended": {
    id: "delegation.ended",
    family: "delegation",
    label: "Delegation ended",
    severity: "info",
    outline: "leaf",
    summary: (p) => str(p.status, "ended"),
  },
  "planner.step.started": {
    id: "planner.step.started",
    family: "step",
    label: "Planner step",
    severity: "info",
    outline: "leaf",
    summary: (p) => stepName(p),
  },
  "planner.step.completed": {
    id: "planner.step.completed",
    family: "step",
    label: "Planner step",
    severity: "info",
    outline: "leaf",
    summary: (p) => `${stepName(p)} · done`,
  },
}

const UNKNOWN: EventDescriptor = {
  id: "unknown",
  family: "misc",
  label: "Event",
  severity: "info",
  outline: "leaf",
  summary: (p) => {
    const kind = str(p.kind, str(p.type, "event"))
    return humanize(kind)
  },
}

/** Lookup TraceEntry.kind or EventType. Never throws — unknown → generic leaf. */
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

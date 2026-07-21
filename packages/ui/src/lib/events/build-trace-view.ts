/**
 * Pure Trace → hybrid DAG model (bodies + outline).
 *
 * Structure (nesting) comes from buildOutline + TRACE_VIEW_SPEC.
 * Call / Work / Phase bodies are leaf adapters for Sent/Received/tools.
 * Kind switches for body enrichment live here (lib/events) — not in widgets.
 */

import type { TraceEntry } from "@mia/shared-types"
import { buildOutline, TRACE_VIEW_SPEC } from "./build-outline"
import { atomsFromTrace } from "./normalize"
import type { OutlineNode } from "./types"

type LlmRequest = Extract<TraceEntry, { kind: "llm-request" }>
type LlmResponse = Extract<TraceEntry, { kind: "llm-response" }>
type SystemPrompt = Extract<TraceEntry, { kind: "system-prompt" }>
type ToolsResolved = Extract<TraceEntry, { kind: "tools-resolved" }>
type ToolCallEntry = Extract<TraceEntry, { kind: "tool-call" }>
type ToolResultEntry = Extract<TraceEntry, { kind: "tool-result" }>
type ToolErrorEntry = Extract<TraceEntry, { kind: "tool-error" }>
export type TraceSqlQuality = Extract<TraceEntry, { kind: "planner-sql-quality" }>

export type TraceToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
  /**
   * `proposed` = model asked for this tool in the reply (Received).
   * `running` / `done` / `error` = actual execution (Work).
   */
  status?: "proposed" | "running" | "done" | "error"
  resultText?: string
  argsSummary?: string
  argsFormatted?: string
}

export type TracePromptMessage = {
  role: string
  content: string | null
  toolCalls: TraceToolCall[]
  toolCallId: string | null
  speaker: string
  detail?: string
}

export type TraceCallNode = {
  /** 0-based display index (Call N = index + 1). */
  index: number
  iteration: number
  messageCount: number
  toolCount: number
  messages: TracePromptMessage[]
  content: string | null
  toolBranches: TraceToolCall[]
  durationMs: number | null
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  } | null
  headline: string
  askedUser: boolean
  waiting: boolean
  sqlQuality: TraceSqlQuality[]
}

/** Expandable body — empty `details` ⇒ leaf card (no chevron). */
export type TracePhaseDetail =
  | { id: string; kind: "event"; text: string; tone?: "neutral" | "warn" | "error" }
  | { id: string; kind: "step"; name: string; type: string; dependsOn?: string[] }
  | { id: string; kind: "json"; label: string; value: unknown }

/**
 * Planner / routing milestone on the spine.
 * `family` is the merge key (plan, pipeline:N, step:name, verify:N, …) —
 * consecutive same-family events collapse into one card.
 *
 * Step families nest Call/Work in `children` (subagent body).
 */
export type TracePhaseChild =
  | { kind: "call"; callIndex: number }
  | { kind: "work"; work: TraceWorkNode }

export type TracePhaseNode = {
  id: string
  family: string
  title: string
  summary: string
  status: "running" | "done" | "error"
  details: TracePhaseDetail[]
  /** Scope lead — e.g. "Subagent" while `title` is the step name. */
  leading?: string
  /** Call / Work that ran inside this step (not flat spine peers). */
  children?: TracePhaseChild[]
}

export type TraceWorkNote = {
  id: string
  label: string
  text: string
  tone?: "neutral" | "error"
}

export type TraceWorkNode = {
  id: string
  afterCallIndex: number
  title: string
  summary: string
  tools: TraceToolCall[]
  notes: TraceWorkNote[]
  /** SQL validation that ran during this work (not part of the prompt). */
  sqlQuality: TraceSqlQuality[]
}

/** Chronological spine after Context — phases, calls, and between-call work. */
export type TraceSpineEntry =
  | { kind: "phase"; phase: TracePhaseNode }
  | { kind: "call"; callIndex: number }
  | { kind: "work"; work: TraceWorkNode }

export type TracePreamble = {
  systemPrompt: string | null
  tools: Array<{
    name: string
    description: string
    parameters?: Record<string, unknown>
  }>
}

export type TraceDagStats = {
  callCount: number
  promptTokens: number
  completionTokens: number
  totalDuration: number
  toolRunCount: number
  phaseCount: number
}

export type TraceDag = {
  preamble: TracePreamble
  calls: TraceCallNode[]
  spine: TraceSpineEntry[]
  /** Catalog + ViewSpec projection — sticky / fold shells read this. */
  outline: OutlineNode[]
  stats: TraceDagStats
  hasData: boolean
}

export type TraceCallSearchHit = {
  reasons: string[]
  inHistory: boolean
  inReply: boolean
}

function historySpeaker(role: string): string {
  if (role === "assistant") return "Agent"
  if (role === "system") return "System"
  if (role === "user") return "User"
  if (role === "tool") return "Tool result"
  return role
}

/**
 * Label a history row. ask_user answers are tool-role messages — show as
 * “User answer”, not a generic tool result.
 */
export function historyRowLabel(
  msg: { role: string; toolCallId: string | null; toolCalls: TraceToolCall[] },
  messages: Array<{ role: string; toolCalls: TraceToolCall[] }>,
  index: number,
): { speaker: string; detail?: string } {
  if (msg.role !== "tool") return { speaker: historySpeaker(msg.role) }
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i]!
    if (prev.role !== "assistant") continue
    const tc = prev.toolCalls.find((t) => t.id === msg.toolCallId)
    if (!tc) continue
    if (tc.name === "ask_user") {
      return { speaker: "User answer", detail: "via ask_user" }
    }
    return { speaker: "Tool result", detail: tc.name }
  }
  return { speaker: "Tool result" }
}

export function replyHeadline(res: LlmResponse | null): string {
  if (!res) return "Waiting…"
  if (res.toolCalls.length > 0) {
    const names = res.toolCalls.map((t) => t.name)
    if (names.length === 1) return names[0]!
    if (names.length === 2) return `${names[0]}, ${names[1]}`
    return `${names[0]}, ${names[1]} +${names.length - 2}`
  }
  if (res.content) return "Final answer"
  return "Empty reply"
}

function pairLlmCalls(trace: TraceEntry[]): Array<{
  request: LlmRequest
  response: LlmResponse | null
}> {
  const requests = trace.filter((e): e is LlmRequest => e.kind === "llm-request")
  const responses = trace.filter((e): e is LlmResponse => e.kind === "llm-response")
  const responseByIter = new Map<number, LlmResponse>()
  for (const response of responses) {
    if (!responseByIter.has(response.iteration)) {
      responseByIter.set(response.iteration, response)
    }
  }
  return requests.map((request, i) => ({
    request,
    response: responseByIter.get(request.iteration) ?? responses[i] ?? null,
  }))
}

function enrichMessages(
  messages: LlmRequest["messages"],
  systemPrompt: string | null,
): TracePromptMessage[] {
  const enriched = messages.map((msg, index) => {
    const label = historyRowLabel(msg, messages, index)
    return {
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      speaker: label.speaker,
      ...(label.detail ? { detail: label.detail } : {}),
    }
  })
  // System is often emitted once as `system-prompt` and omitted from later
  // llm-request payloads — still show it first in Sent so the prompt is whole.
  if (systemPrompt && !enriched.some((m) => m.role === "system")) {
    return [
      {
        role: "system",
        content: systemPrompt,
        toolCalls: [],
        toolCallId: null,
        speaker: "System",
        detail: "shared prompt",
      },
      ...enriched,
    ]
  }
  return enriched
}

function parseToolArgs(argsFormatted: string): Record<string, unknown> {
  try {
    const v = JSON.parse(argsFormatted) as unknown
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { raw: argsFormatted }
  } catch {
    return argsFormatted ? { raw: argsFormatted } : {}
  }
}

function humanizeStep(name: string): string {
  return name.replace(/_/g, " ")
}

function detailEvent(
  id: string,
  text: string,
  tone: "neutral" | "warn" | "error" = "neutral",
): TracePhaseDetail {
  return { id, kind: "event", text, tone }
}

function detailStep(
  id: string,
  step: { name: string; type: string; dependsOn?: string[] },
): TracePhaseDetail {
  return {
    id,
    kind: "step",
    name: step.name,
    type: step.type,
    ...(step.dependsOn?.length ? { dependsOn: step.dependsOn } : {}),
  }
}

function detailJson(id: string, label: string, value: unknown): TracePhaseDetail {
  return { id, kind: "json", label, value }
}

/** One update from a trace entry — merged into an open phase by `family`. */
type PhaseUpdate = {
  family: string
  title: string
  summary: string
  status: TracePhaseNode["status"]
  details: TracePhaseDetail[]
  leading?: string
  /** Bare Direct with nothing to show — omit from the spine. */
  skip?: boolean
}

function isStepFamily(family: string): boolean {
  return family.startsWith("step:")
}

function truncatePhaseText(text: string, max = 72): string {
  const t = text.trim().replace(/\s+/g, " ")
  if (!t) return t
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function phaseFromEntry(entry: TraceEntry, index: number): PhaseUpdate | null {
  switch (entry.kind) {
    case "planning_preflight":
      return {
        family: "plan",
        title: "Plan",
        summary: "Preparing…",
        status: "running",
        details: [detailEvent(`preflight-${index}`, "Planner-first preflight")],
      }
    case "planner-decision": {
      const direct = !entry.shouldPlan || entry.route === "direct"
      if (direct) {
        return {
          family: "direct",
          title: "Direct",
          summary: entry.reason || "tool loop",
          status: "done",
          details: [],
          skip: true,
        }
      }
      const bits = [
        entry.route ? `route ${entry.route}` : null,
        entry.score != null ? `score ${entry.score}` : null,
        entry.reason || null,
      ].filter(Boolean)
      return {
        family: "plan",
        title: "Plan",
        summary: entry.reason || "orchestrated",
        status: "done",
        details: [detailEvent(`decision-${index}`, bits.join(" · "))],
      }
    }
    case "planner-generating":
      return {
        family: "plan",
        title: "Plan",
        summary: "Generating…",
        status: "running",
        details: [detailEvent(`generating-${index}`, "Generating plan")],
      }
    case "planner-plan-generated": {
      const stepLines = entry.steps.map((s, si) =>
        detailStep(`plan-step-${index}-${si}`, s),
      )
      return {
        family: "plan",
        title: "Plan",
        summary: `${entry.stepCount} step${entry.stepCount !== 1 ? "s" : ""}`,
        status: "done",
        details: [
          ...stepLines,
          detailJson(`plan-graph-${index}`, "Plan graph", {
            reason: entry.reason,
            stepCount: entry.stepCount,
            steps: entry.steps,
            ...(entry.edges ? { edges: entry.edges } : {}),
          }),
        ],
      }
    }
    case "planner-runtime-compiled":
      return {
        family: "plan",
        title: "Plan",
        summary: "Runtime compiled",
        status: "done",
        details: [
          detailJson(`runtime-${index}`, "Runtime", {
            executionSteps: entry.executionSteps,
            ownershipArtifacts: entry.ownershipArtifacts,
            runtimeEntities: entry.runtimeEntities,
          }),
        ],
      }
    case "planner-generation-failed":
      return {
        family: "plan",
        title: "Plan",
        summary: "Generation failed",
        status: "error",
        details: entry.diagnostics.map((d, di) =>
          detailEvent(`gen-fail-${index}-${di}`, `${d.code}: ${d.message}`, "error"),
        ),
      }
    case "planner-validation-failed":
    case "planner-validation-remediated":
    case "planner-validation-warnings": {
      const label =
        entry.kind === "planner-validation-failed"
          ? "Validation failed"
          : entry.kind === "planner-validation-remediated"
            ? "Validation remediated"
            : `Validation warnings (${entry.warningCount})`
      const tone =
        entry.kind === "planner-validation-failed"
          ? "error"
          : entry.kind === "planner-validation-warnings"
            ? "warn"
            : "neutral"
      return {
        family: "plan",
        title: "Plan",
        summary: label,
        status: entry.kind === "planner-validation-failed" ? "error" : "done",
        details: entry.diagnostics.map((d, di) =>
          detailEvent(`val-${index}-${di}`, `${d.code}: ${d.message}`, tone),
        ),
      }
    }
    case "planner-pipeline-start":
      return {
        family: "pipeline",
        title: "Pipeline",
        summary: entry.attempt > 1 ? `attempt ${entry.attempt}` : "running",
        status: "running",
        details: [
          detailEvent(
            `pipe-start-${index}`,
            [
              `attempt ${entry.attempt}`,
              entry.verifierRound != null ? `verifier round ${entry.verifierRound}` : null,
              `max retries ${entry.maxRetries}`,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ],
      }
    case "planner-pipeline-end":
      return {
        family: "pipeline",
        title: "Pipeline",
        summary: `${entry.completedSteps}/${entry.totalSteps} · ${entry.status}`,
        status: entry.status === "success" ? "done" : "error",
        details: [
          detailEvent(
            `pipe-end-${index}`,
            `Finished ${entry.completedSteps}/${entry.totalSteps} steps (${entry.status})`,
          ),
        ],
      }
    case "planner-budget-extended":
      return {
        family: "pipeline",
        title: "Pipeline",
        summary: `budget → ${entry.effectiveBudget}`,
        status: "running",
        details: [
          detailEvent(
            `budget-${index}`,
            `Extended budget to ${entry.effectiveBudget} (${entry.extensions}×) after ${entry.completedSteps} steps`,
          ),
        ],
      }
    case "planner-step-start": {
      const subagent = entry.stepType === "subagent_task"
      return {
        family: `step:${entry.stepName}`,
        leading: subagent ? "Subagent" : "Step",
        title: humanizeStep(entry.stepName),
        summary: subagent ? "running" : entry.stepType.replace(/_/g, " "),
        status: "running",
        details: [
          detailEvent(
            `step-start-${index}`,
            subagent ? "Subagent started" : `Started (${entry.stepType})`,
          ),
        ],
      }
    }
    case "planner-step-transition":
      return {
        family: `step:${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: `${entry.phase} · ${entry.state}`,
        status: "running",
        details: [
          detailEvent(`step-tr-${index}`, `${entry.phase} → ${entry.state} (attempt ${entry.attempt})`),
        ],
      }
    case "planner-step-end": {
      const ok = entry.status === "pass" || entry.status === "success"
      const details: TracePhaseDetail[] = [
        detailEvent(
          `step-end-${index}`,
          [
            ok ? "Finished" : entry.error || "Failed",
            entry.durationMs != null ? `${entry.durationMs}ms` : null,
            entry.acceptanceState ? `acceptance ${entry.acceptanceState}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ]
      if (entry.producedArtifacts?.length) {
        details.push(
          detailEvent(`step-art-${index}`, `Artifacts: ${entry.producedArtifacts.join(", ")}`),
        )
      }
      if (entry.verificationAttempts?.length) {
        details.push(detailJson(`step-verify-${index}`, "Verification attempts", entry.verificationAttempts))
      }
      if (entry.reconciliation) {
        details.push(detailJson(`step-recon-${index}`, "Reconciliation", entry.reconciliation))
      }
      return {
        family: `step:${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: ok ? "done" : entry.error || "failed",
        status: ok ? "done" : "error",
        details,
      }
    }
    case "planner-delegation-start": {
      const details: TracePhaseDetail[] = [
        detailEvent(`del-goal-${index}`, entry.goal),
      ]
      if (entry.tools.length > 0) {
        details.push(detailEvent(`del-tools-${index}`, `Tools: ${entry.tools.join(", ")}`))
      }
      if (entry.envelope) {
        details.push(detailJson(`del-env-${index}`, "Delegation envelope", entry.envelope))
      }
      details.push(
        detailJson(`del-budget-${index}`, "Budget", entry.budget),
      )
      return {
        family: `step:${entry.stepName}`,
        leading: "Subagent",
        title: humanizeStep(entry.stepName),
        summary: truncatePhaseText(entry.goal) || "delegating",
        status: "running",
        details,
      }
    }
    case "planner-delegation-iteration": {
      // Keep timeline quiet — Call/Work under the step are the body.
      const details: TracePhaseDetail[] = []
      if (entry.content) {
        details.push(detailEvent(`del-iter-${index}`, entry.content))
      }
      return {
        family: `step:${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: "running",
        status: "running",
        details,
      }
    }
    case "planner-delegation-end":
      return {
        family: `step:${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: entry.status === "done" ? "done" : entry.error || "failed",
        status: entry.status === "done" ? "done" : "error",
        details: [
          detailEvent(
            `del-end-${index}`,
            entry.status === "done"
              ? entry.answer
                ? `Delegation done — ${entry.answer}`
                : "Delegation done"
              : entry.error || "Delegation failed",
          ),
        ],
      }
    case "planner-delegation-decision":
      return {
        family: "plan",
        title: "Plan",
        summary: entry.shouldDelegate ? "will delegate" : "no delegation",
        status: "done",
        details: [
          detailEvent(
            `del-dec-${index}`,
            [
              entry.shouldDelegate ? "Delegate" : "Skip delegation",
              entry.reason,
              `utility ${entry.utilityScore.toFixed(2)}`,
              `safety ${entry.safetyRisk.toFixed(2)}`,
            ].join(" · "),
          ),
        ],
      }
    case "planner-verification": {
      const details: TracePhaseDetail[] = entry.steps.map((s, si) =>
        detailEvent(
          `verify-step-${index}-${si}`,
          `${s.stepName}: ${s.outcome}${s.issues.length ? ` — ${s.issues.join("; ")}` : ""}`,
        ),
      )
      if (entry.systemChecks?.length) {
        details.push(detailJson(`verify-sys-${index}`, "System checks", entry.systemChecks))
      }
      details.push(
        detailJson(`verify-full-${index}`, "Verification", {
          overall: entry.overall,
          confidence: entry.confidence,
          verifierRound: entry.verifierRound,
          steps: entry.steps,
        }),
      )
      return {
        family: "verify",
        title: "Verifying",
        summary: `${entry.overall} · ${Math.round(entry.confidence * 100)}%`,
        status:
          entry.overall === "pass" ? "done" : entry.overall === "fail" ? "error" : "running",
        details,
      }
    }
    case "planner-repair-plan":
      return {
        family: `repair:${entry.attempt}`,
        title: "Repairing",
        summary: `attempt ${entry.attempt} · ${entry.tasks.length} task${entry.tasks.length !== 1 ? "s" : ""}`,
        status: "running",
        details: [
          ...entry.tasks.map((t, ti) =>
            detailEvent(
              `repair-task-${index}-${ti}`,
              `${t.stepName}: ${t.mode}${t.ownedIssueCodes.length ? ` (${t.ownedIssueCodes.join(", ")})` : ""}`,
            ),
          ),
          detailJson(`repair-full-${index}`, "Repair plan", {
            attempt: entry.attempt,
            rerunOrder: entry.rerunOrder,
            tasks: entry.tasks,
          }),
        ],
      }
    case "planner-retry":
      return {
        family: `repair:${entry.attempt}`,
        title: "Repairing",
        summary: `retry ${entry.attempt}`,
        status: "running",
        details: [
          detailEvent(
            `retry-${index}`,
            [
              entry.reason,
              entry.retrySteps != null ? `${entry.retrySteps} to retry` : null,
              entry.skippedSteps != null ? `${entry.skippedSteps} skipped` : null,
              entry.rerunOrder?.length ? `order: ${entry.rerunOrder.join(" → ")}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ],
      }
    case "planner-escalation":
      return {
        family: `repair:${entry.attempt}`,
        title: "Repairing",
        summary: `${entry.action} · ${entry.reason}`,
        status: entry.action === "pass" ? "done" : "running",
        details: [
          detailEvent(`esc-${index}`, `Escalation: ${entry.action} (${entry.reason})`),
        ],
      }
    case "planner-retry-skip":
      return {
        family: `step:${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: "skipped",
        status: "done",
        details: [detailEvent(`retry-skip-${index}`, `Retry skipped — ${entry.reason}`)],
      }
    case "direct_loop_fallback":
      return {
        family: "direct",
        title: "Direct",
        summary: entry.reason || "tool loop",
        status: "done",
        details: [],
        skip: true,
      }
    default:
      return null
  }
}

function mergePhaseSummary(prev: string, next: string): string {
  if (prev === next) return next
  const stepBit = [prev, next].find((s) => /^\d+ steps?\b/.test(s))
  if (stepBit) {
    const other = prev === stepBit ? next : prev
    if (!other || other === stepBit) return stepBit
    if (other.includes(stepBit) || stepBit.includes(other)) return stepBit.length >= other.length ? stepBit : other
    return `${stepBit} · ${other}`
  }
  return next
}

function mergePhase(prev: TracePhaseNode, next: PhaseUpdate): TracePhaseNode {
  return {
    ...prev,
    title: next.title,
    summary: mergePhaseSummary(prev.summary, next.summary),
    status: next.status,
    details: [...prev.details, ...next.details].slice(0, 48),
    leading: next.leading ?? prev.leading,
    children: prev.children,
  }
}

function applyToolResult(
  tools: TraceToolCall[],
  entry: ToolResultEntry | ToolErrorEntry,
): TraceToolCall[] {
  const status: "done" | "error" = entry.kind === "tool-error" ? "error" : "done"
  const id = entry.toolCallId || entry.invocationId
  if (!id) return tools
  let hit = false
  const next = tools.map((t) => {
    if (t.id !== id && t.id !== entry.invocationId && t.id !== entry.toolCallId) return t
    hit = true
    return { ...t, status, resultText: entry.text }
  })
  if (hit) return next
  return next.concat({
    id,
    name: "tool",
    arguments: {},
    status,
    resultText: entry.text,
  })
}

function workTitle(tools: TraceToolCall[], notes: TraceWorkNote[]): string {
  if (tools.length === 0 && notes.length > 0) return notes[0]!.label
  if (tools.length === 1) return tools[0]!.name
  if (tools.length > 1) return `${tools.length} tools`
  return "Work"
}

function workSummary(tools: TraceToolCall[], notes: TraceWorkNote[]): string {
  const bits: string[] = []
  const done = tools.filter((t) => t.status === "done").length
  const err = tools.filter((t) => t.status === "error").length
  const run = tools.filter((t) => t.status === "running" || !t.status).length
  if (tools.length > 0) {
    if (err) bits.push(`${err} failed`)
    if (done) bits.push(`${done} done`)
    if (run) bits.push(`${run} running`)
  }
  if (notes.length > 0) bits.push(`${notes.length} note${notes.length !== 1 ? "s" : ""}`)
  return bits.join(" · ") || "between calls"
}

/** Build the hybrid DAG view-model from a raw trace stream. */
export function buildTraceDag(trace: TraceEntry[]): TraceDag {
  const outline = buildOutline(atomsFromTrace(trace), TRACE_VIEW_SPEC)
  const systemPrompt =
    trace.find((e): e is SystemPrompt => e.kind === "system-prompt")?.text ?? null
  const toolsResolved = trace.find((e): e is ToolsResolved => e.kind === "tools-resolved")
  const sqlQuality = trace.filter((e): e is TraceSqlQuality => e.kind === "planner-sql-quality")

  const paired = pairLlmCalls(trace)
  const calls: TraceCallNode[] = paired.map(({ request, response }, index) => {
    const toolBranches = (response?.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: "proposed" as const,
    }))
    const usage = response?.usage ?? null
    return {
      index,
      iteration: request.iteration,
      messageCount: request.messageCount,
      toolCount: request.toolCount,
      messages: enrichMessages(request.messages, systemPrompt),
      content: response?.content ?? null,
      toolBranches,
      durationMs: response?.durationMs ?? null,
      usage,
      headline: replyHeadline(response),
      askedUser: toolBranches.some((t) => t.name === "ask_user"),
      waiting: response == null,
      sqlQuality: sqlQuality.filter((s) => s.iteration === request.iteration),
    }
  })

  const callByIteration = new Map(calls.map((c) => [c.iteration, c]))
  const spine: TraceSpineEntry[] = []
  let openPhase: TracePhaseNode | null = null
  let openWork: TraceWorkNode | null = null
  let lastCallIndex = -1
  let workSeq = 0
  let phaseSeq = 0

  function flushWork() {
    if (!openWork) return
    if (openWork.tools.length > 0 || openWork.notes.length > 0) {
      openWork.title = workTitle(openWork.tools, openWork.notes)
      openWork.summary = workSummary(openWork.tools, openWork.notes)
      // SQL validation runs during tool execution — attach to Work, not Received.
      const call = calls[openWork.afterCallIndex]
      if (call && call.sqlQuality.length > 0) {
        const matched = call.sqlQuality.filter((s) =>
          openWork!.tools.some(
            (t) => t.id === s.toolCallId || t.name === s.toolName,
          ),
        )
        openWork.sqlQuality = matched.length > 0 ? matched : call.sqlQuality
      }
      if (openPhase && isStepFamily(openPhase.family)) {
        openPhase.children = openPhase.children ?? []
        openPhase.children.push({ kind: "work", work: openWork })
      } else {
        spine.push({ kind: "work", work: openWork })
      }
      // Do not mirror execution onto Received toolBranches — Received shows
      // proposals only; Work owns run + result (clear agent-loop chronology).
    }
    openWork = null
  }

  /**
   * Close the open phase pointer. Phase is already on the spine (pushed at
   * create) so we only clear the handle — children keep accumulating until then.
   */
  function flushPhase() {
    flushWork()
    openPhase = null
  }

  function applyPhase(update: PhaseUpdate) {
    if (update.skip && update.details.length === 0) return
    flushWork()
    if (openPhase && openPhase.family !== update.family) flushPhase()
    if (!openPhase) {
      phaseSeq += 1
      openPhase = {
        id: `phase-${phaseSeq}`,
        family: update.family,
        title: update.title,
        summary: update.summary,
        status: update.status,
        details: update.details,
        ...(update.leading ? { leading: update.leading } : {}),
        ...(isStepFamily(update.family) ? { children: [] } : {}),
      }
      spine.push({ kind: "phase", phase: openPhase })
      return
    }
    // Mutate in place — spine holds this object reference (live Trace).
    const merged = mergePhase(openPhase, update)
    openPhase.title = merged.title
    openPhase.summary = merged.summary
    openPhase.status = merged.status
    openPhase.details = merged.details
    if (merged.leading) openPhase.leading = merged.leading
  }

  function ensureWork(afterCallIndex: number): TraceWorkNode {
    if (openWork && openWork.afterCallIndex === afterCallIndex) return openWork
    flushWork()
    workSeq += 1
    openWork = {
      id: `work-${afterCallIndex}-${workSeq}`,
      afterCallIndex,
      title: "Work",
      summary: "",
      tools: [],
      notes: [],
      sqlQuality: [],
    }
    return openWork
  }

  function pushCall(callIndex: number) {
    if (openPhase && isStepFamily(openPhase.family)) {
      flushWork()
      openPhase.children = openPhase.children ?? []
      openPhase.children.push({ kind: "call", callIndex })
    } else {
      flushWork()
      openPhase = null
      spine.push({ kind: "call", callIndex })
    }
    lastCallIndex = callIndex
  }

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i]!

    if (entry.kind === "llm-request") {
      const call = callByIteration.get(entry.iteration)
      if (call) pushCall(call.index)
      continue
    }

    if (entry.kind === "llm-response" || entry.kind === "system-prompt" || entry.kind === "tools-resolved") {
      continue
    }

    if (entry.kind === "planner-sql-quality") {
      continue
    }

    const phase = phaseFromEntry(entry, i)
    if (phase) {
      applyPhase(phase)
      continue
    }

    if (lastCallIndex < 0) continue

    if (entry.kind === "tool-call") {
      const work = ensureWork(lastCallIndex)
      const tc = entry as ToolCallEntry
      const id = tc.toolCallId || tc.invocationId
      const existing = work.tools.findIndex((t) => t.id === id || t.id === tc.invocationId)
      const row: TraceToolCall = {
        id,
        name: tc.tool,
        arguments: parseToolArgs(tc.argsFormatted),
        status: "running",
        argsSummary: tc.argsSummary,
        argsFormatted: tc.argsFormatted,
      }
      if (existing >= 0) work.tools[existing] = { ...work.tools[existing]!, ...row }
      else work.tools.push(row)
      continue
    }

    if (entry.kind === "tool-result" || entry.kind === "tool-error") {
      const work = ensureWork(lastCallIndex)
      work.tools = applyToolResult(work.tools, entry)
      continue
    }

    if (entry.kind === "nudge") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `nudge-${i}`,
        label: entry.tag || "Nudge",
        text: entry.message,
      })
      continue
    }

    if (entry.kind === "sync-progress") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `sync-${entry.invocationId}-${i}`,
        label: entry.headline || entry.tool || "Sync",
        text: entry.detail || entry.status,
      })
      continue
    }

    if (entry.kind === "user-input-request") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `ask-${i}`,
        label: "Waiting on user",
        text: entry.question,
      })
      continue
    }

    if (entry.kind === "user-input-response") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `answer-${i}`,
        label: "User answered",
        text: entry.text,
      })
      continue
    }

    if (entry.kind === "error" && entry.text !== "Run cancelled by user") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `err-${i}`,
        label: "Error",
        text: entry.text,
        tone: "error",
      })
    }
  }

  flushWork()
  flushPhase()

  let promptTokens = 0
  let completionTokens = 0
  let totalDuration = 0
  for (const c of calls) {
    if (c.durationMs != null) totalDuration += c.durationMs
    if (c.usage) {
      promptTokens += c.usage.promptTokens
      completionTokens += c.usage.completionTokens
    }
  }

  const preamble: TracePreamble = {
    systemPrompt,
    tools: toolsResolved?.tools ?? [],
  }

  const finalSpine = spineFromOutline(outline, calls, spine)

  const toolRunCount = finalSpine.reduce((n, e) => {
    if (e.kind === "work") return n + e.work.tools.length
    if (e.kind === "phase" && e.phase.children) {
      return (
        n +
        e.phase.children.reduce(
          (m, c) => (c.kind === "work" ? m + c.work.tools.length : m),
          0,
        )
      )
    }
    return n
  }, 0)
  const phaseCount = finalSpine.filter((e) => e.kind === "phase").length

  const hasData =
    Boolean(systemPrompt) ||
    preamble.tools.length > 0 ||
    calls.length > 0 ||
    sqlQuality.length > 0 ||
    finalSpine.length > 0

  return {
    preamble,
    calls,
    spine: finalSpine,
    outline,
    stats: {
      callCount: calls.length,
      promptTokens,
      completionTokens,
      totalDuration,
      toolRunCount,
      phaseCount,
    },
    hasData,
  }
}

/**
 * Prefer outline nesting for step-owned Call/Work; fall back to body spine
 * for phase details / work payloads that the catalog projection does not own.
 */
function spineFromOutline(
  outline: OutlineNode[],
  calls: TraceCallNode[],
  bodySpine: TraceSpineEntry[],
): TraceSpineEntry[] {
  if (outline.length === 0) return bodySpine

  const callByIteration = new Map(calls.map((c) => [c.iteration, c]))
  const bodyPhases = new Map(
    bodySpine
      .filter((e): e is Extract<TraceSpineEntry, { kind: "phase" }> => e.kind === "phase")
      .map((e) => [e.phase.family, e.phase]),
  )
  const bodyWorkByCall = new Map<number, TraceWorkNode>()
  for (const e of bodySpine) {
    if (e.kind === "work") bodyWorkByCall.set(e.work.afterCallIndex, e.work)
    if (e.kind === "phase" && e.phase.children) {
      for (const c of e.phase.children) {
        if (c.kind === "work") bodyWorkByCall.set(c.work.afterCallIndex, c.work)
      }
    }
  }

  function mapChildren(nodes: OutlineNode[]): TracePhaseChild[] {
    const out: TracePhaseChild[] = []
    let i = 0
    while (i < nodes.length) {
      const n = nodes[i]!
      if (n.family === "call") {
        const iter = nestIteration(n.nestKey)
        const call = iter != null ? callByIteration.get(iter) : undefined
        if (call) {
          out.push({ kind: "call", callIndex: call.index })
          i += 1
          // Collapse consecutive work leaves into one Work card.
          let sawWork = false
          while (i < nodes.length && nodes[i]!.family === "work") {
            sawWork = true
            i += 1
          }
          if (sawWork) {
            const work = bodyWorkByCall.get(call.index)
            if (work) out.push({ kind: "work", work })
          }
          continue
        }
      }
      if (n.family === "work") {
        // Orphan work — skip; body spine already ordered under a call when present.
        i += 1
        continue
      }
      i += 1
    }
    return out
  }

  const spine: TraceSpineEntry[] = []
  let oi = 0
  while (oi < outline.length) {
    const node = outline[oi]!
    if (node.family === "call") {
      const iter = nestIteration(node.nestKey)
      const call = iter != null ? callByIteration.get(iter) : undefined
      if (call) {
        spine.push({ kind: "call", callIndex: call.index })
        oi += 1
        let sawWork = false
        while (oi < outline.length && outline[oi]!.family === "work") {
          sawWork = true
          oi += 1
        }
        if (sawWork) {
          const work = bodyWorkByCall.get(call.index)
          if (work) spine.push({ kind: "work", work })
        }
        continue
      }
      oi += 1
      continue
    }
    if (node.family === "work") {
      oi += 1
      continue
    }
    // Phase / plan / step / pipeline / verify / repair scopes
    if (node.kind === "scope") {
      const key = node.nestKey ?? String(node.family)
      const body = bodyPhases.get(key) ?? findPhaseLoose(bodyPhases, key, node)
      const children = mapChildren(node.children ?? [])
      if (body) {
        spine.push({
          kind: "phase",
          phase: {
            ...body,
            title: node.title ?? body.title,
            summary: node.summary ?? body.summary,
            leading: node.label !== body.title ? node.label : body.leading,
            ...(children.length > 0 ? { children } : { children: body.children }),
          },
        })
      } else if (children.length > 0 || (node.summary && node.summary.length > 0)) {
        spine.push({
          kind: "phase",
          phase: {
            id: node.id,
            family: key,
            title: node.title ?? node.label,
            summary: node.summary ?? "",
            status: node.severity === "error" ? "error" : "done",
            details: [],
            leading: node.title ? node.label : undefined,
            ...(children.length > 0 ? { children } : {}),
          },
        })
      }
      oi += 1
      continue
    }
    oi += 1
  }

  // If outline produced nothing useful, keep body spine.
  return spine.length > 0 ? spine : bodySpine
}

function nestIteration(nestKey: string | undefined): number | null {
  if (!nestKey) return null
  const m = /^call:(\d+)$/.exec(nestKey)
  return m ? Number(m[1]) : null
}

function findPhaseLoose(
  bodyPhases: Map<string, TracePhaseNode>,
  key: string,
  node: OutlineNode,
): TracePhaseNode | undefined {
  const direct = bodyPhases.get(key)
  if (direct) return direct
  // pipeline / verify may use unversioned family in body spine
  for (const [fam, phase] of bodyPhases) {
    if (fam === node.family || fam.startsWith(`${node.family}:`) || key.startsWith(`${fam}`)) {
      return phase
    }
  }
  return undefined
}

/** Where a call matched the filter — shown so search feels intentional. */
export function searchCall(
  call: TraceCallNode,
  rawQuery: string,
): TraceCallSearchHit | null {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return null

  const reasons: string[] = []
  let inHistory = false
  let inReply = false
  const callNo = call.index + 1
  const iterNo = call.iteration + 1

  if (q === String(callNo) || q === `call ${callNo}` || q === `#${callNo}`) {
    reasons.push(`Call ${callNo}`)
  }
  if (q === `iteration ${iterNo}` || q === `iter ${iterNo}` || q === `i${iterNo}`) {
    reasons.push(`Iteration ${iterNo}`)
  } else if (q === String(iterNo) && !reasons.includes(`Call ${callNo}`)) {
    reasons.push(`Iteration ${iterNo}`)
  }

  for (const tc of call.toolBranches) {
    if (tc.name.toLowerCase().includes(q)) {
      reasons.push(`tool ${tc.name}`)
      inReply = true
    }
    if (tc.id.toLowerCase().includes(q)) {
      reasons.push("tool call id")
      inReply = true
    }
    const args = JSON.stringify(tc.arguments).toLowerCase()
    if (args.includes(q) && !reasons.some((r) => r.startsWith("tool "))) {
      reasons.push(`tool args (${tc.name})`)
      inReply = true
    }
  }
  if (call.content?.toLowerCase().includes(q)) {
    reasons.push("agent reply")
    inReply = true
  }
  if (call.headline.toLowerCase().includes(q) && !inReply) {
    reasons.push("outcome")
    inReply = true
  }

  for (const msg of call.messages) {
    if (msg.content?.toLowerCase().includes(q)) {
      inHistory = true
      break
    }
    if (
      msg.role.toLowerCase().includes(q) ||
      msg.speaker.toLowerCase().includes(q)
    ) {
      inHistory = true
      break
    }
    if (msg.toolCallId?.toLowerCase().includes(q)) {
      reasons.push("tool call id")
      inHistory = true
      break
    }
    for (const tc of msg.toolCalls) {
      if (tc.name.toLowerCase().includes(q) || tc.id.toLowerCase().includes(q)) {
        if (tc.id.toLowerCase().includes(q)) reasons.push("tool call id")
        inHistory = true
        break
      }
    }
    if (inHistory) break
  }
  if (inHistory && !reasons.includes("history")) reasons.push("history")

  if (reasons.length === 0) return null
  return { reasons: reasons.slice(0, 3), inHistory, inReply }
}

export function messagePreview(msg: TracePromptMessage): string {
  if (msg.toolCalls.length > 0) {
    return `called ${msg.toolCalls.map((t) => t.name).join(", ")}`
  }
  if (msg.content) {
    const line = msg.content.replace(/\s+/g, " ").trim()
    return line.length > 100 ? `${line.slice(0, 99)}…` : line
  }
  if (msg.toolCallId) return `for ${msg.toolCallId.slice(0, 12)}`
  return "empty"
}

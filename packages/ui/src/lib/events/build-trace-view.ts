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
import { isPlannerStepSuccessStatus } from "./planner-step-status"
import { computeTokenCostUsd } from "./trace-cost"
import { isCancelRaceFailureError } from "./trace-terminal"
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
  /** 0-based index in `calls[]` (stable identity for Work.afterCallIndex). */
  index: number
  /**
   * 0-based Call number within the owning step (or global when no step).
   * UI shows `Call ${callOrdinal + 1}`.
   */
  callOrdinal: number
  iteration: number
  /** Planner step that owns this LLM call (child agents); unset for direct loop. */
  stepName: string | null
  messageCount: number
  toolCount: number
  messages: TracePromptMessage[]
  content: string | null
  toolBranches: TraceToolCall[]
  durationMs: number | null
  /** Offset from run start for waterfall / Gantt (ms). */
  startOffsetMs: number
  /** Resolved model id when known (planner-prompt-budget telemetry). */
  model: string | null
  /** USD cost from token usage + model pricing table. */
  costUsd: number | null
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
  /** Nested phase (Subagent under Pipeline). */
  | { kind: "phase"; phase: TracePhaseNode }

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
  startOffsetMs: number
  durationMs: number | null
}

export type TraceWorkNote = {
  id: string
  label: string
  text: string
  /** cancelled = user/abort stop (not Fail); error = real failure. */
  tone?: "neutral" | "error" | "cancelled"
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
  startOffsetMs: number
  durationMs: number | null
}

/** Chronological spine after Context — phases, calls, and between-call work. */
export type TraceSpineEntry =
  | { kind: "phase"; phase: TracePhaseNode }
  | { kind: "call"; callIndex: number }
  | { kind: "work"; work: TraceWorkNode }

export type TracePreamble = {
  /** Primary (first) system prompt — injected into calls missing a system role. */
  systemPrompt: string | null
  /** Every `system-prompt` trace entry — Context tab shows each. */
  systemPrompts: string[]
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
  totalCostUsd: number
  toolRunCount: number
  phaseCount: number
  /** Wall-clock when createdAt meta exists; otherwise LLM-duration packing. */
  timingBasis: "wall" | "llm-pack"
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

function llmPairKey(stepName: string | null | undefined, iteration: number): string {
  return `${stepName ?? "_"}:${iteration}`
}

/**
 * Pair llm-request → llm-response by (stepName, iteration) when stamped;
 * fall back to chronological FIFO for legacy traces without stepName.
 */
function pairLlmCalls(trace: TraceEntry[]): Array<{
  request: LlmRequest
  response: LlmResponse | null
}> {
  const requests = trace.filter((e): e is LlmRequest => e.kind === "llm-request")
  const responses = trace.filter((e): e is LlmResponse => e.kind === "llm-response")
  const responseByKey = new Map<string, LlmResponse[]>()
  for (const response of responses) {
    const key = llmPairKey(response.stepName, response.iteration)
    const q = responseByKey.get(key) ?? []
    q.push(response)
    responseByKey.set(key, q)
  }
  const used = new Set<LlmResponse>()
  return requests.map((request, i) => {
    const key = llmPairKey(request.stepName, request.iteration)
    const q = responseByKey.get(key)
    let response: LlmResponse | null = null
    if (q) {
      const next = q.find((r) => !used.has(r))
      if (next) {
        used.add(next)
        response = next
      }
    }
    if (!response) {
      // Legacy: first unused response with same iteration, else positional.
      const legacy = responses.find(
        (r) => !used.has(r) && r.iteration === request.iteration && !r.stepName,
      )
      if (legacy) {
        used.add(legacy)
        response = legacy
      } else {
        const positional = responses[i]
        if (positional && !used.has(positional)) {
          used.add(positional)
          response = positional
        }
      }
    }
    return { request, response }
  })
}

function enrichMessages(
  messages: LlmRequest["messages"],
  systemPrompts: string[],
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
  // System prompts are often emitted as `system-prompt` entries and omitted
  // from later llm-request payloads — inject all of them so Sent / System stay whole.
  const callSystemCount = enriched.filter((m) => m.role === "system").length
  if (systemPrompts.length > 0 && callSystemCount < systemPrompts.length) {
    const withoutSystem = enriched.filter((m) => m.role !== "system")
    return [
      ...systemPrompts.map((content, i) => ({
        role: "system" as const,
        content,
        toolCalls: [] as TracePromptMessage["toolCalls"],
        toolCallId: null,
        speaker: systemPrompts.length > 1 ? `System ${i + 1}` : "System",
        detail: "shared prompt",
      })),
      ...withoutSystem,
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
  /**
   * Start a new attempt card for this family (e.g. planner-step-start).
   * Status-only follow-ups (transitions after verify) must NOT set this —
   * they reattach to the latest card of the same family.
   */
  beginNew?: boolean
  /**
   * True only for planner-step-end. Delegation/end-of-loop updates must NOT
   * clear the open step — otherwise the next step-end reattaches to attempt 1
   * via findPhaseInTree and overwrites a failed card to "done".
   */
  closesStep?: boolean
}

function isStepFamily(family: string): boolean {
  return family.startsWith("step:")
}

/** Stable phase ids so open/fold state survives DAG rebuilds. */
function allocatePhaseId(
  family: string,
  beginNew: boolean,
  stepAttempts: Map<string, number>,
  fallbackSeq: () => number,
): string {
  if (family === "plan") return "phase-plan"
  if (family === "pipeline") return "phase-pipeline"
  if (family === "verify") return "phase-verify"
  if (family === "direct") return "phase-direct"
  if (family === "repair" || family.startsWith("repair:")) return "phase-repair"
  if (isStepFamily(family)) {
    const stepName = family.slice("step:".length)
    if (beginNew) {
      const attempt = (stepAttempts.get(stepName) ?? 0) + 1
      stepAttempts.set(stepName, attempt)
      return `phase-step:${stepName}:${attempt}`
    }
    const attempt = stepAttempts.get(stepName) ?? 1
    return `phase-step:${stepName}:${attempt}`
  }
  return `phase-${fallbackSeq()}`
}

function assignMergedPhase(target: TracePhaseNode, update: PhaseUpdate): void {
  const merged = mergePhase(target, update)
  target.title = merged.title
  target.summary = merged.summary
  target.status = merged.status
  target.details = merged.details
  if (merged.leading) target.leading = merged.leading
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
    case "planner-pipeline-end": {
      const ok = entry.status === "success"
      return {
        family: "pipeline",
        title: "Pipeline",
        summary: `${entry.completedSteps}/${entry.totalSteps} · ${entry.status}`,
        status: ok ? "done" : "error",
        details: [
          detailEvent(
            `pipe-end-${index}`,
            ok
              ? `Finished ${entry.completedSteps}/${entry.totalSteps} steps (success)`
              : `Finished ${entry.completedSteps}/${entry.totalSteps} steps (failed)`,
          ),
        ],
      }
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
        beginNew: true,
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
      const ok = isPlannerStepSuccessStatus(entry.status)
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
        closesStep: true,
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
    case "planner-delegation-decision": {
      const mode = entry.executionMode
      const modeLabel =
        mode === "parallel"
          ? "Parallel subagents"
          : mode === "serial"
            ? "Serial subagents"
            : mode === "guided"
              ? "Guided subagents"
              : mode === "stop"
                ? "Blocked"
                : entry.shouldDelegate
                  ? "Parallel subagents"
                  : "Serial subagents"
      return {
        family: "plan",
        title: "Subagent mode",
        summary: modeLabel.toLowerCase(),
        status: mode === "stop" ? "error" : "done",
        details: [
          detailEvent(
            `del-dec-${index}`,
            [
              modeLabel,
              entry.reason,
              `utility ${entry.utilityScore.toFixed(2)}`,
              `safety ${entry.safetyRisk.toFixed(2)}`,
            ].join(" · "),
          ),
        ],
      }
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
      // One "repair" family — plan + retry are the same cycle (not repair:1 vs repair:2).
      return {
        family: "repair",
        title: "Repairing",
        summary: `attempt ${entry.attempt} · ${entry.tasks.length} task${entry.tasks.length !== 1 ? "s" : ""}`,
        status: "done",
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
        family: "repair",
        title: "Repairing",
        summary: entry.reason || `retry ${entry.attempt}`,
        status: "done",
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
        family: "repair",
        title: "Repairing",
        summary: `${entry.action} · ${entry.reason}`,
        status: entry.action === "pass" ? "done" : "error",
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
    startOffsetMs: prev.startOffsetMs,
    durationMs: prev.durationMs,
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
  if (tools.length === 0 && notes.some((n) => n.tone === "cancelled")) {
    return "Cancelled"
  }
  if (tools.length === 0 && notes.length > 0) return notes[0]!.label
  if (tools.length === 1) return tools[0]!.name
  if (tools.length > 1) return `${tools.length} tools`
  return "Work"
}

function workSummary(tools: TraceToolCall[], notes: TraceWorkNote[]): string {
  if (notes.some((n) => n.tone === "cancelled") && tools.length === 0) {
    return "run stopped"
  }
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

export type BuildTraceDagOpts = {
  /** Parallel wall-clock ms per entry (from TraceEnvelope.createdAt). */
  createdAtMs?: Array<number | null>
}

/** Build the hybrid DAG view-model from a raw trace stream. */
export function buildTraceDag(trace: TraceEntry[], opts?: BuildTraceDagOpts): TraceDag {
  const outline = buildOutline(atomsFromTrace(trace), TRACE_VIEW_SPEC)
  const systemPrompts = trace
    .filter((e): e is SystemPrompt => e.kind === "system-prompt")
    .map((e) => e.text.trim())
    .filter(Boolean)
  const systemPrompt = systemPrompts[0] ?? null
  const toolsResolved = trace.find((e): e is ToolsResolved => e.kind === "tools-resolved")
  const sqlQuality = trace.filter((e): e is TraceSqlQuality => e.kind === "planner-sql-quality")
  const createdAtMs = opts?.createdAtMs
  const hasWallClock = Boolean(createdAtMs?.some((ms) => ms != null))

  const modelByIteration = new Map<number, string>()
  for (const entry of trace) {
    if (entry.kind === "planner-prompt-budget" && entry.model) {
      modelByIteration.set(entry.iteration, entry.model)
    }
  }

  const paired = pairLlmCalls(trace)
  const ordinalByStep = new Map<string, number>()
  const t0 = createdAtMs?.find((ms) => ms != null) ?? null
  let callOffsetMs = 0
  const calls: TraceCallNode[] = paired.map(({ request, response }, index) => {
    const stepName = request.stepName ?? response?.stepName ?? null
    const stepKey = stepName ?? "_"
    const callOrdinal = ordinalByStep.get(stepKey) ?? 0
    ordinalByStep.set(stepKey, callOrdinal + 1)
    const toolBranches = (response?.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: "proposed" as const,
    }))
    const usage = response?.usage ?? null
    const model = modelByIteration.get(request.iteration) ?? null
    const durationMs = response?.durationMs ?? null
    let startOffsetMs = callOffsetMs
    if (hasWallClock && t0 != null && createdAtMs) {
      // Prefer request entry wall time when we can find it in the stream.
      const reqIdx = trace.findIndex(
        (e, ei) =>
          e.kind === "llm-request" &&
          e === request &&
          (createdAtMs[ei] != null || true),
      )
      const wall = reqIdx >= 0 ? createdAtMs[reqIdx] : null
      if (wall != null) startOffsetMs = Math.max(0, wall - t0)
      else if (durationMs != null) callOffsetMs += durationMs
    } else if (durationMs != null) {
      callOffsetMs += durationMs
    }
    const costUsd =
      usage != null
        ? computeTokenCostUsd(model, usage.promptTokens, usage.completionTokens)
        : null
    return {
      index,
      callOrdinal,
      iteration: request.iteration,
      stepName,
      messageCount: request.messageCount,
      toolCount: request.toolCount,
      messages: enrichMessages(request.messages, systemPrompts),
      content: response?.content ?? null,
      toolBranches,
      durationMs,
      startOffsetMs,
      model,
      costUsd,
      usage,
      headline: replyHeadline(response),
      askedUser: toolBranches.some((t) => t.name === "ask_user"),
      waiting: response == null,
      sqlQuality: sqlQuality.filter(
        (s) =>
          s.iteration === request.iteration &&
          (stepName == null || !("stepName" in s) || (s as { stepName?: string }).stepName === stepName),
      ),
    }
  })

  // Consume Calls in request order (pairing already resolved stepName+iteration).
  const callQueue = [...calls]
  const spine: TraceSpineEntry[] = []
  /** Parallel-safe: stepName → open step phase (mirrors Chat runningSteps). */
  const runningSteps = new Map<string, TracePhaseNode>()
  let openPipeline: TracePhaseNode | null = null
  /** Serial fallback when tools lack stepName. */
  let serialOpenStep: TracePhaseNode | null = null
  /** Non-step open phase (plan / verify / repair) for merge. */
  let openMilestone: TracePhaseNode | null = null
  const openWorkByCall = new Map<number, TraceWorkNode>()
  const stepLastCall = new Map<string, number>()
  const invocationOwner = new Map<string, { stepName: string | null; callIndex: number }>()
  let lastCallIndex = -1
  let workSeq = 0
  let phaseSeq = 0
  const stepAttempts = new Map<string, number>()
  const stepEndDuration = new Map<string, number>()

  function findStepOwningCall(callIndex: number): TracePhaseNode | null {
    function walk(phase: TracePhaseNode): TracePhaseNode | null {
      for (const child of phase.children ?? []) {
        if (child.kind === "call" && child.callIndex === callIndex) return phase
        if (child.kind === "phase") {
          const found = walk(child.phase)
          if (found) return found
        }
      }
      return null
    }
    for (const entry of spine) {
      if (entry.kind !== "phase") continue
      const found = walk(entry.phase)
      if (found) return found
    }
    return null
  }

  function flushWorkForCall(callIndex: number) {
    const openWork = openWorkByCall.get(callIndex)
    if (!openWork) return
    openWorkByCall.delete(callIndex)
    if (openWork.tools.length === 0 && openWork.notes.length === 0) return
    openWork.title = workTitle(openWork.tools, openWork.notes)
    openWork.summary = workSummary(openWork.tools, openWork.notes)
    const call = calls[openWork.afterCallIndex]
    if (call && call.sqlQuality.length > 0) {
      const matched = call.sqlQuality.filter((s) =>
        openWork.tools.some((t) => t.id === s.toolCallId || t.name === s.toolName),
      )
      openWork.sqlQuality = matched.length > 0 ? matched : call.sqlQuality
    }
    // Prefer the phase that already owns this Call (survives step-end).
    const ownerStep =
      findStepOwningCall(callIndex) ??
      (call?.stepName ? runningSteps.get(call.stepName) : null) ??
      (call?.stepName ? findPhaseInTree(`step:${call.stepName}`) : null) ??
      serialOpenStep
    if (ownerStep && isStepFamily(ownerStep.family)) {
      ownerStep.children = ownerStep.children ?? []
      ownerStep.children.push({ kind: "work", work: openWork })
    } else {
      spine.push({ kind: "work", work: openWork })
    }
  }

  function flushAllWork() {
    for (const callIndex of [...openWorkByCall.keys()]) flushWorkForCall(callIndex)
  }

  /** Latest card for `family` — repair attempts must not reattach to attempt 1. */
  function findPhaseInTree(family: string): TracePhaseNode | null {
    for (let i = spine.length - 1; i >= 0; i--) {
      const entry = spine[i]
      if (entry?.kind !== "phase") continue
      if (entry.phase.family === family) return entry.phase
      const kids = entry.phase.children
      if (!kids) continue
      for (let j = kids.length - 1; j >= 0; j--) {
        const child = kids[j]!
        if (child.kind === "phase" && child.phase.family === family) return child.phase
      }
    }
    return null
  }

  function nestsUnderPipeline(family: string): boolean {
    return (
      isStepFamily(family) ||
      family === "verify" ||
      family === "repair" ||
      family.startsWith("repair:")
    )
  }

  function createPhase(update: PhaseUpdate): TracePhaseNode {
    phaseSeq += 1
    const phase: TracePhaseNode = {
      id: allocatePhaseId(update.family, Boolean(update.beginNew), stepAttempts, () => phaseSeq),
      family: update.family,
      title: update.title,
      summary: update.summary,
      status: update.status,
      details: update.details,
      startOffsetMs: 0,
      durationMs: null,
      ...(update.leading ? { leading: update.leading } : {}),
      ...(nestsUnderPipeline(update.family) || update.family === "pipeline"
        ? { children: [] }
        : {}),
    }
    // Steps / verify / repair append in event order under the open Pipeline so
    // fail → verify → repair → retry-step reads top-to-bottom (not spine peers after).
    if (nestsUnderPipeline(update.family) && openPipeline) {
      openPipeline.children = openPipeline.children ?? []
      openPipeline.children.push({ kind: "phase", phase })
    } else {
      spine.push({ kind: "phase", phase })
    }
    return phase
  }

  function applyPhase(update: PhaseUpdate) {
    if (update.skip && update.details.length === 0) return

    if (update.family === "pipeline") {
      flushAllWork()
      if (openPipeline) {
        assignMergedPhase(openPipeline, update)
        return
      }
      const prior = findPhaseInTree("pipeline")
      if (prior) {
        assignMergedPhase(prior, update)
        openPipeline = prior
        return
      }
      openPipeline = createPhase(update)
      return
    }

    if (isStepFamily(update.family)) {
      const stepName = update.family.slice("step:".length)
      if (update.beginNew) {
        flushAllWork()
        const phase = createPhase(update)
        runningSteps.set(stepName, phase)
        serialOpenStep = phase
        return
      }
      const open = runningSteps.get(stepName) ?? findPhaseInTree(update.family)
      if (open) {
        assignMergedPhase(open, update)
        if (update.closesStep) {
          runningSteps.delete(stepName)
          if (serialOpenStep === open) serialOpenStep = null
        } else {
          runningSteps.set(stepName, open)
          serialOpenStep = open
        }
        return
      }
      return
    }

    // Plan / verify / repair milestones
    flushAllWork()
    if (openMilestone && openMilestone.family === update.family) {
      assignMergedPhase(openMilestone, update)
      return
    }
    const canReattach =
      update.family === "verify" ||
      update.family === "plan" ||
      update.family === "repair" ||
      update.family.startsWith("repair:")
    if (canReattach) {
      const prior = findPhaseInTree(update.family)
      if (prior) {
        assignMergedPhase(prior, update)
        openMilestone = prior
        return
      }
    }
    openMilestone = createPhase(update)
  }

  function ensureWork(afterCallIndex: number): TraceWorkNode {
    const existing = openWorkByCall.get(afterCallIndex)
    if (existing) return existing
    workSeq += 1
    const openWork: TraceWorkNode = {
      id: `work-${afterCallIndex}-${workSeq}`,
      afterCallIndex,
      title: "Work",
      summary: "",
      tools: [],
      notes: [],
      sqlQuality: [],
      startOffsetMs: 0,
      durationMs: null,
    }
    openWorkByCall.set(afterCallIndex, openWork)
    return openWork
  }

  function resolveStepOwner(stepName: string | null | undefined): TracePhaseNode | null {
    if (stepName && runningSteps.has(stepName)) return runningSteps.get(stepName)!
    if (stepName) {
      const found = findPhaseInTree(`step:${stepName}`)
      if (found) return found
    }
    return serialOpenStep
  }

  function pushCall(call: TraceCallNode) {
    // Close Work for the previous Call before the next Call lands — otherwise
    // direct multi-iteration loops batch as Call×N then Work×N (EOF flush).
    // Planner step boundaries still flush; this keeps Call → Work → Call order
    // when several Calls share one step (or there is no step at all).
    if (lastCallIndex >= 0) flushWorkForCall(lastCallIndex)

    const owner = resolveStepOwner(call.stepName)
    if (owner && isStepFamily(owner.family)) {
      owner.children = owner.children ?? []
      owner.children.push({ kind: "call", callIndex: call.index })
      if (call.stepName) stepLastCall.set(call.stepName, call.index)
    } else {
      spine.push({ kind: "call", callIndex: call.index })
    }
    lastCallIndex = call.index
  }

  function resolveWorkCallIndex(stepName: string | null | undefined): number {
    if (stepName != null && stepLastCall.has(stepName)) return stepLastCall.get(stepName)!
    return lastCallIndex
  }

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i]!

    if (entry.kind === "llm-request") {
      const call = callQueue.shift()
      if (call) pushCall(call)
      continue
    }

    if (entry.kind === "llm-response" || entry.kind === "system-prompt" || entry.kind === "tools-resolved") {
      continue
    }

    if (entry.kind === "planner-sql-quality") {
      continue
    }

    if (entry.kind === "planner-step-end" && typeof entry.durationMs === "number") {
      stepEndDuration.set(entry.stepName, entry.durationMs)
    }

    if (entry.kind === "planner-pipeline-end") {
      const phase = phaseFromEntry(entry, i)
      if (phase) applyPhase(phase)
      openPipeline = null
      continue
    }

    const phase = phaseFromEntry(entry, i)
    if (phase) {
      applyPhase(phase)
      continue
    }

    if (entry.kind === "tool-call") {
      const tc = entry as ToolCallEntry
      const ownerStep = tc.stepName ?? null
      const callIndex = resolveWorkCallIndex(ownerStep)
      if (callIndex < 0) continue
      const work = ensureWork(callIndex)
      const id = tc.toolCallId || tc.invocationId
      invocationOwner.set(tc.invocationId, { stepName: ownerStep, callIndex })
      if (tc.toolCallId) invocationOwner.set(tc.toolCallId, { stepName: ownerStep, callIndex })
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
      const inv =
        entry.invocationId ??
        entry.toolCallId ??
        null
      const owned = inv ? invocationOwner.get(inv) : undefined
      const stepName = entry.stepName ?? owned?.stepName ?? null
      const callIndex = owned?.callIndex ?? resolveWorkCallIndex(stepName)
      if (callIndex < 0) continue
      const work = ensureWork(callIndex)
      work.tools = applyToolResult(work.tools, entry)
      continue
    }

    const noteCall = lastCallIndex
    if (noteCall < 0) continue

    if (entry.kind === "nudge") {
      const work = ensureWork(noteCall)
      const tag = entry.tag || "Nudge"
      const fatalTag =
        tag === "fatal-tool-outcome" || tag === "abort-round-tool-outcome"
      const cancelNudge =
        fatalTag && isCancelRaceFailureError(entry.message)
      work.notes.push({
        id: `nudge-${i}`,
        label: tag,
        text: entry.message,
        tone: cancelNudge ? "cancelled" : fatalTag ? "error" : undefined,
      })
      continue
    }

    if (entry.kind === "sync-progress") {
      const work = ensureWork(noteCall)
      work.notes.push({
        id: `sync-${entry.invocationId}-${i}`,
        label: entry.headline || entry.tool || "Sync",
        text: entry.detail || entry.status,
      })
      continue
    }

    if (entry.kind === "user-input-request") {
      const work = ensureWork(noteCall)
      work.notes.push({
        id: `ask-${i}`,
        label: "Waiting on user",
        text: entry.question,
      })
      continue
    }

    if (entry.kind === "user-input-response") {
      const work = ensureWork(noteCall)
      work.notes.push({
        id: `answer-${i}`,
        label: "User answered",
        text: entry.text,
      })
      continue
    }

    if (entry.kind === "error" && entry.text !== "Run cancelled by user") {
      const work = ensureWork(noteCall)
      work.notes.push({
        id: `err-${i}`,
        label: "Error",
        text: entry.text,
        tone: "error",
      })
    }
  }

  flushAllWork()

  let promptTokens = 0
  let completionTokens = 0
  let totalDuration = 0
  let totalCostUsd = 0
  for (const c of calls) {
    if (c.durationMs != null) totalDuration += c.durationMs
    if (c.usage) {
      promptTokens += c.usage.promptTokens
      completionTokens += c.usage.completionTokens
    }
    if (c.costUsd != null) totalCostUsd += c.costUsd
  }

  const preamble: TracePreamble = {
    systemPrompt,
    systemPrompts,
    tools: toolsResolved?.tools ?? [],
  }

  // Body ownership is authoritative; outline patches titles only.
  const finalSpine = enrichSpanTimings(
    patchPhaseTitlesFromOutline(spine, outline),
    calls,
    stepEndDuration,
  )

  function countTools(children: TracePhaseChild[] | undefined): number {
    if (!children) return 0
    let n = 0
    for (const c of children) {
      if (c.kind === "work") n += c.work.tools.length
      else if (c.kind === "phase") n += countTools(c.phase.children)
    }
    return n
  }

  function countPhases(entries: TraceSpineEntry[]): number {
    let n = 0
    for (const e of entries) {
      if (e.kind !== "phase") continue
      n += 1
      if (e.phase.children) {
        for (const c of e.phase.children) {
          if (c.kind === "phase") n += 1 + countNestedPhases(c.phase)
        }
      }
    }
    return n
  }

  function countNestedPhases(phase: TracePhaseNode): number {
    let n = 0
    for (const c of phase.children ?? []) {
      if (c.kind === "phase") n += 1 + countNestedPhases(c.phase)
    }
    return n
  }

  const toolRunCount = finalSpine.reduce((n, e) => {
    if (e.kind === "work") return n + e.work.tools.length
    if (e.kind === "phase") return n + countTools(e.phase.children)
    return n
  }, 0)
  const phaseCount = countPhases(finalSpine)

  const hasData =
    systemPrompts.length > 0 ||
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
      totalCostUsd,
      toolRunCount,
      phaseCount,
      timingBasis: hasWallClock ? "wall" : "llm-pack",
    },
    hasData,
  }
}

/** Patch phase titles/summaries from outline without rewriting ownership. */
function patchPhaseTitlesFromOutline(
  bodySpine: TraceSpineEntry[],
  outline: OutlineNode[],
): TraceSpineEntry[] {
  const byNest = new Map<string, OutlineNode>()
  function walk(nodes: OutlineNode[]) {
    for (const n of nodes) {
      if (n.nestKey) byNest.set(n.nestKey, n)
      if (n.family === "pipeline") byNest.set("pipeline", n)
      if (n.family === "plan") byNest.set("plan", n)
      if (n.family === "verify") byNest.set("verify", n)
      if (n.children) walk(n.children)
    }
  }
  walk(outline)

  function patchPhase(phase: TracePhaseNode, latestByFamily: Map<string, TracePhaseNode>) {
    const key = phase.family
    const node = byNest.get(key) ?? byNest.get(phase.family)
    const isLatestAttempt = latestByFamily.get(phase.family) === phase
    if (node) {
      if (node.title) phase.title = node.title
      // Outline has one summary per family — only the latest attempt card.
      // Older failed attempts keep their own "failed" summary.
      if (node.summary && isLatestAttempt) phase.summary = node.summary
      if (node.label && node.label !== phase.title) phase.leading = node.label
    }
    for (const child of phase.children ?? []) {
      if (child.kind === "phase") patchPhase(child.phase, latestByFamily)
    }
  }

  const latestByFamily = new Map<string, TracePhaseNode>()
  function collectLatest(phase: TracePhaseNode) {
    latestByFamily.set(phase.family, phase)
    for (const child of phase.children ?? []) {
      if (child.kind === "phase") collectLatest(child.phase)
    }
  }
  for (const entry of bodySpine) {
    if (entry.kind === "phase") collectLatest(entry.phase)
  }

  for (const entry of bodySpine) {
    if (entry.kind === "phase") patchPhase(entry.phase, latestByFamily)
  }
  return bodySpine
}

/** Assign startOffsetMs / durationMs to work and phase spans from call timeline. */
function enrichSpanTimings(
  spine: TraceSpineEntry[],
  calls: TraceCallNode[],
  stepEndDuration?: Map<string, number>,
): TraceSpineEntry[] {
  function callEndOffset(index: number): number {
    const call = calls[index]
    if (!call) return 0
    return call.startOffsetMs + (call.durationMs ?? 0)
  }

  function enrichWork(work: TraceWorkNode): void {
    const after = calls[work.afterCallIndex]
    work.startOffsetMs = after ? callEndOffset(work.afterCallIndex) : 0
    const nextCall = calls.find((c) => c.startOffsetMs > work.startOffsetMs)
    const sqlMs = work.sqlQuality.reduce(
      (max, s) => Math.max(max, s.durationMs ?? 0),
      0,
    )
    const spanEnd = nextCall?.startOffsetMs ?? work.startOffsetMs + sqlMs
    work.durationMs = Math.max(0, spanEnd - work.startOffsetMs) || (work.tools.length > 0 ? sqlMs || null : null)
  }

  function enrichPhase(phase: TracePhaseNode): void {
    if (!phase.children?.length) {
      phase.startOffsetMs = 0
      if (isStepFamily(phase.family) && stepEndDuration) {
        const name = phase.family.slice("step:".length)
        phase.durationMs = stepEndDuration.get(name) ?? null
      } else {
        phase.durationMs = null
      }
      return
    }
    let minStart = Number.POSITIVE_INFINITY
    let maxEnd = 0
    for (const child of phase.children) {
      if (child.kind === "call") {
        const call = calls[child.callIndex]
        if (!call) continue
        minStart = Math.min(minStart, call.startOffsetMs)
        maxEnd = Math.max(maxEnd, call.startOffsetMs + (call.durationMs ?? 0))
      } else if (child.kind === "work") {
        enrichWork(child.work)
        minStart = Math.min(minStart, child.work.startOffsetMs)
        maxEnd = Math.max(
          maxEnd,
          child.work.startOffsetMs + (child.work.durationMs ?? 0),
        )
      } else {
        enrichPhase(child.phase)
        minStart = Math.min(minStart, child.phase.startOffsetMs)
        maxEnd = Math.max(
          maxEnd,
          child.phase.startOffsetMs + (child.phase.durationMs ?? 0),
        )
      }
    }
    if (Number.isFinite(minStart)) {
      phase.startOffsetMs = minStart
      if (isStepFamily(phase.family) && stepEndDuration) {
        const name = phase.family.slice("step:".length)
        const beDuration = stepEndDuration.get(name)
        phase.durationMs = beDuration ?? (maxEnd > minStart ? maxEnd - minStart : null)
      } else {
        phase.durationMs = maxEnd > minStart ? maxEnd - minStart : null
      }
    }
  }

  for (const entry of spine) {
    if (entry.kind === "work") enrichWork(entry.work)
    if (entry.kind === "phase") enrichPhase(entry.phase)
  }
  return spine
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
  const callNo = call.callOrdinal + 1
  const iterNo = call.iteration + 1

  if (q === String(callNo) || q === `call ${callNo}` || q === `#${callNo}`) {
    reasons.push(`Call ${callNo}`)
  }
  if (q === `iteration ${iterNo}` || q === `iter ${iterNo}` || q === `i${iterNo}`) {
    reasons.push(`Iteration ${iterNo}`)
  } else if (q === String(iterNo) && !reasons.includes(`Call ${callNo}`)) {
    reasons.push(`Iteration ${iterNo}`)
  }

  if (call.model?.toLowerCase().includes(q)) {
    reasons.push("model")
    inHistory = true
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

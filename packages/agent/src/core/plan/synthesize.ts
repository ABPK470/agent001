import { VerifierOutcome } from "../../domain/index.js"
/**
 * Answer synthesis — build a short user-facing summary from planner results.
 *
 * Hard rule: the run answer is NOT step telemetry. Tool results (SQL tables,
 * schema dumps, command stdout) and verbose child work logs belong on the
 * step/tool rows in chat. Dumping them into `answer` floods the transcript,
 * burns tokens on re-display, and breaks layout with horizontal scroll.
 *
 * @module
 */

import { synthesizePlatformUnconfiguredAnswer } from "./platform-errors.js"
import type { PipelineResult, PipelineStepResult, Plan, PlanStep, VerifierDecision } from "./types.js"

/** Soft cap for a single narrative contribution. */
const MAX_NARRATIVE_CHARS = 4_000
/** Hard cap for the final answer string. */
const MAX_ANSWER_CHARS = 6_000
/** Above this many lines, treat as a dump unless it is clearly short prose. */
const MAX_NARRATIVE_LINES = 60

function normalizeSuccessfulOutput(text: string): string {
  return text
    .trim()
    .replace(/^done:\s*/i, "")
    .replace(/^completed:\s*/i, "")
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length
}

/** SQL / pipe-table / schema dumps — never the user-facing answer. */
export function isToolTelemetryDump(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true

  if (/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE)\b/i.test(trimmed)) {
    return true
  }
  if (/^Error:/i.test(trimmed)) return true
  if (/^Query executed\./i.test(trimmed)) return true
  if (/^\(\d+\s+rows?\)/i.test(trimmed)) return true
  if (/EXPORT_HINT|export_query_to_file/i.test(trimmed) && trimmed.includes(" | ")) {
    return true
  }

  const lines = trimmed.split(/\r?\n/)
  const pipeLines = lines.filter((line) => (line.match(/\|/g) ?? []).length >= 2).length
  if (pipeLines >= 3 && pipeLines / Math.max(lines.length, 1) >= 0.25) {
    return true
  }

  // Schema / explore dumps often look like key: value walls.
  const kvLines = lines.filter((line) => /^\s*[\w.[\]"]+\s*[:=]\s*.+/.test(line)).length
  if (lines.length >= 20 && kvLines / lines.length >= 0.6) {
    return true
  }

  return false
}

/**
 * True when text is short enough and shaped like something a human should see
 * as the assistant's final reply (not a tool log).
 */
export function isUserFacingNarrative(text: string): boolean {
  const normalized = normalizeSuccessfulOutput(text)
  if (!normalized) return false
  if (isToolTelemetryDump(normalized)) return false
  if (normalized.length > MAX_NARRATIVE_CHARS) return false
  if (lineCount(normalized) > MAX_NARRATIVE_LINES) return false
  return true
}

function clampAnswer(text: string): string {
  const t = text.trim()
  if (t.length <= MAX_ANSWER_CHARS) return t
  return `${t.slice(0, MAX_ANSWER_CHARS - 1).trimEnd()}…`
}

function artifactFallback(plan: Plan, pipelineResult: PipelineResult): string {
  const producedArtifacts = plan.steps.flatMap(
    (step) => pipelineResult.stepResults.get(step.name)?.producedArtifacts ?? []
  )
  const uniqueArtifacts = [...new Set(producedArtifacts)]
  if (uniqueArtifacts.length === 1) {
    return `Created ${uniqueArtifacts[0]}.`
  }
  if (uniqueArtifacts.length > 1) {
    return `Created ${uniqueArtifacts.length} files: ${uniqueArtifacts.join(", ")}.`
  }

  return pipelineResult.completedSteps === pipelineResult.totalSteps
    ? "Completed successfully."
    : `Completed ${pipelineResult.completedSteps} of ${pipelineResult.totalSteps} steps.`
}

type NarrativeCandidate = {
  step: PlanStep
  text: string
}

function collectNarratives(plan: Plan, pipelineResult: PipelineResult): NarrativeCandidate[] {
  const out: NarrativeCandidate[] = []
  for (const step of plan.steps) {
    // Deterministic tool output is always telemetry (SQL, schema, etc.).
    if (step.stepType === "deterministic_tool") continue

    const result: PipelineStepResult | undefined = pipelineResult.stepResults.get(step.name)
    if (!result?.output || typeof result.output !== "string") continue
    const text = normalizeSuccessfulOutput(result.output)
    if (!isUserFacingNarrative(text)) continue
    out.push({ step, text })
  }
  return out
}

/**
 * Pass path: prefer the last subagent narrative (usually the write/answer step).
 * Join multiple short narratives only when the total stays small.
 * Never concatenate tool dumps.
 */
function synthesizeSuccessfulAnswer(plan: Plan, pipelineResult: PipelineResult): string {
  const narratives = collectNarratives(plan, pipelineResult)
  if (narratives.length === 0) {
    return artifactFallback(plan, pipelineResult)
  }

  // Last narrative wins when it looks like a real answer (not a one-liner ack).
  const last = narratives[narratives.length - 1]!
  if (last.text.length >= 40 || narratives.length === 1) {
    return clampAnswer(last.text)
  }

  const unique = [...new Set(narratives.map((n) => n.text))]
  const joined = unique.join("\n\n")
  if (joined.length <= MAX_NARRATIVE_CHARS && lineCount(joined) <= MAX_NARRATIVE_LINES) {
    return clampAnswer(joined)
  }

  return clampAnswer(last.text)
}

export function synthesizeAnswer(
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision
): string {
  // Platform-unconfigured short-circuit — if any step failed because a required
  // platform integration is missing, the verbose "Task verification FAILED" wall
  // is misleading and leaks operator-only details to the end user. Emit an
  // opaque, user-safe message instead. The technical detail (env var to set,
  // missing service name) is logged server-side by run-executor; the user
  // gets a run reference they can forward to the platform admin.
  const hasPlatformUnconfigured = [...pipelineResult.stepResults.values()].some(
    (r) => r.failureClass === "platform_unconfigured"
  )
  if (hasPlatformUnconfigured) {
    return synthesizePlatformUnconfiguredAnswer()
  }

  if (verifierDecision.overall === VerifierOutcome.Pass) {
    return synthesizeSuccessfulAnswer(plan, pipelineResult)
  }

  const parts: string[] = []

  if (verifierDecision.overall === VerifierOutcome.Retry) {
    parts.push("Task verification FAILED — the following issues remain unresolved after all retry attempts:")
  } else {
    parts.push("Task FAILED — critical errors prevented completion:")
  }

  parts.push("")
  parts.push(`Plan: ${plan.reason}`)
  parts.push(`Steps: ${pipelineResult.completedSteps}/${pipelineResult.totalSteps} completed`)
  parts.push("")

  for (const step of plan.steps) {
    const result = pipelineResult.stepResults.get(step.name)
    const stepVerification = verifierDecision.steps.find((s) => s.stepName === step.name)
    const acceptanceState = result?.acceptanceState
    const effectiveAcceptance =
      acceptanceState ??
      (stepVerification?.outcome === VerifierOutcome.Pass
        ? "accepted"
        : stepVerification?.outcome === VerifierOutcome.Retry ||
            stepVerification?.outcome === VerifierOutcome.Fail
          ? "repair_required"
          : undefined)
    const status =
      effectiveAcceptance === "accepted"
        ? "verified"
        : effectiveAcceptance === "repair_required"
          ? "incomplete"
          : effectiveAcceptance === "rejected"
            ? "rejected"
            : (result?.status ?? "unknown")
    const icon =
      effectiveAcceptance === "accepted"
        ? "✓"
        : effectiveAcceptance === "repair_required"
          ? "⚠"
          : status === "failed" || effectiveAcceptance === "rejected"
            ? "✗"
            : "⊘"
    parts.push(`${icon} ${step.name} (${step.stepType}): ${status}`)

    // Tiny peek only — never paste full tool/SQL dumps into failure answers.
    if (result?.output && step.stepType === "subagent_task" && isUserFacingNarrative(result.output)) {
      const summary = result.output.slice(0, 200)
      parts.push(`  → ${summary}${result.output.length > 200 ? "..." : ""}`)
    }

    if (result?.error) {
      parts.push(`  ⚠ ${result.error.slice(0, 200)}`)
    }

    if (stepVerification && stepVerification.issues.length > 0) {
      for (const issue of stepVerification.issues) {
        parts.push(`  ! ${issue}`)
      }
    }
  }

  if (verifierDecision.repairPlan && verifierDecision.repairPlan.tasks.length > 0) {
    parts.push("")
    parts.push("Repair Plan:")
    for (const task of verifierDecision.repairPlan.tasks) {
      parts.push(`  - ${task.stepName}: ${task.mode}`)
    }
  }

  if (verifierDecision.unresolvedItems.length > 0) {
    parts.push("")
    parts.push("Unresolved:")
    for (const item of verifierDecision.unresolvedItems) {
      parts.push(`  - ${item}`)
    }
  }

  return clampAnswer(parts.join("\n"))
}

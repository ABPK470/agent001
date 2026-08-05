/**
 * Chat domain view — group planner attempts + verify under plan-step identity.
 *
 * Orchestrator owns verify/repair (pipeline peers). Chat nests them under the
 * *target step name* for a coherent story — not as fake children of the
 * subagent process. Trace keeps the raw pipeline tree.
 */

import { formatMs } from "../util"
import type {
  ResponsePart,
  ResponseProgressPart,
  ResponseStepAttemptPart,
  ResponseStepBlockPart,
  ResponseStepCheckPart,
  StepBlockOutcome,
} from "./build-chat-parts"

function humanizeStepName(stepName: string): string {
  return stepName.replace(/_/g, " ")
}

/** Sum attempt wall times for the step header (not just the last attempt). */
export function sumAttemptDurationMs(
  attempts: readonly { durationMs?: number }[],
): number {
  let total = 0
  for (const a of attempts) {
    if (typeof a.durationMs === "number" && a.durationMs > 0) total += a.durationMs
  }
  return total
}

function attemptNumber(block: ResponseStepBlockPart, index: number): number {
  const m = block.detail?.match(/\battempt\s+(\d+)\b/i)
  if (m) return Number(m[1])
  if (block.repair) return index + 1
  return 1
}

function attemptStatus(block: ResponseStepBlockPart): ResponseStepAttemptPart["status"] {
  if (block.hasRunning || block.status === "running") return "running"
  if (block.body?.trim()) return "failed"
  return "passed"
}

export function deriveStepBlockOutcome(
  attempts: readonly ResponseStepAttemptPart[],
): StepBlockOutcome {
  if (attempts.some((a) => a.status === "running" || a.hasRunning)) return "running"
  const anyFailed = attempts.some((a) => a.status === "failed")
  const last = attempts[attempts.length - 1]
  if (!last) return "passed"
  if (last.status === "failed") return "failed"
  if (anyFailed && last.status === "passed") return "repaired"
  return "passed"
}

function domainStepTitle(block: ResponseStepBlockPart): string {
  // Strip "Repair · " so the rollup stays the domain step, not a peer repair chip.
  if (block.title.startsWith("Repair · ")) {
    const name = block.title.slice("Repair · ".length)
    return block.subagent ? `Subagent · ${name}` : name
  }
  return block.title
}

function toAttempt(block: ResponseStepBlockPart, index: number): ResponseStepAttemptPart {
  return {
    id: block.id,
    attempt: attemptNumber(block, index),
    repair: Boolean(block.repair),
    status: attemptStatus(block),
    detail: block.detail,
    durationMs: block.durationMs,
    body: block.body,
    tools: block.tools,
    hasRunning: block.hasRunning,
  }
}

function foldBlocks(blocks: ResponseStepBlockPart[]): ResponseStepBlockPart {
  const primary = blocks[0]!
  const attempts = blocks.map((b, i) => toAttempt(b, i))
  const outcome = deriveStepBlockOutcome(attempts)
  const hasRunning = attempts.some((a) => a.hasRunning || a.status === "running")
  const last = attempts[attempts.length - 1]!
  const totalMs = sumAttemptDurationMs(attempts)
  const totalDetail = totalMs > 0 ? formatMs(totalMs) : undefined
  return {
    ...primary,
    title: domainStepTitle(primary),
    // Rollup is never itself a "repair" peer — attempts carry that flag.
    repair: undefined,
    outcome,
    attempts,
    tools: last.tools,
    hasRunning,
    status: hasRunning ? "running" : "done",
    durationMs: totalMs > 0 ? totalMs : primary.durationMs,
    // Error text lives on attempts; header uses outcome + total duration.
    body: outcome === "failed" ? last.body ?? primary.body : undefined,
    detail:
      outcome === "failed"
        ? last.detail ?? primary.detail
        : totalDetail
          ?? (last.detail && !/^attempt\s+\d+/i.test(last.detail.trim())
            ? last.detail
            : primary.detail && !/^attempt\s+\d+/i.test(primary.detail.trim())
              ? primary.detail
              : undefined),
  }
}

function matchingStepName(
  stepName: string,
  humanDetail: string | undefined,
): boolean {
  if (!humanDetail) return false
  return humanizeStepName(stepName) === humanDetail.trim()
}

/**
 * Fold repair peers + attach verify beats under step-name groups.
 * Leaves unmatched verification peers alone (no step block to nest under).
 */
export function reconcilePlannerStepGroups(parts: ResponsePart[]): ResponsePart[] {
  const stepIndices = new Map<string, number[]>()
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.kind !== "step-block" || !part.stepName) continue
    const list = stepIndices.get(part.stepName) ?? []
    list.push(i)
    stepIndices.set(part.stepName, list)
  }

  const remove = new Set<number>()
  const folded = new Map<number, ResponseStepBlockPart>()

  for (const indices of stepIndices.values()) {
    if (indices.length < 2) continue
    const blocks = indices.map((i) => parts[i] as ResponseStepBlockPart)
    const primaryIndex = indices[0]!
    folded.set(primaryIndex, foldBlocks(blocks))
    for (let k = 1; k < indices.length; k++) remove.add(indices[k]!)
  }

  // Attach verification peers to the matching step group; drop "Checked work"
  // from the answer axis when it can nest (or when it is a pure pass with no home).
  const next: ResponsePart[] = []
  for (let i = 0; i < parts.length; i++) {
    if (remove.has(i)) continue
    const part = folded.get(i) ?? parts[i]!

    if (part.kind === "progress" && part.id.startsWith("verification-")) {
      const attached = attachVerification(part, next, folded, parts, remove)
      if (attached) continue
      // Pass with nowhere to nest — omit from answer axis (internal gate).
      if (part.label === "Checked work") continue
    }

    next.push(part)
  }

  return next
}

function attachVerification(
  verify: ResponseProgressPart,
  next: ResponsePart[],
  folded: Map<number, ResponseStepBlockPart>,
  allParts: ResponsePart[],
  remove: Set<number>,
): boolean {
  const check: ResponseStepCheckPart = {
    label: verify.label,
    detail: verify.detail,
    body: verify.body,
    status: verify.status === "running" ? "running" : "done",
  }

  // Prefer detail step name; else first "Name: issue" line in body.
  let targetHuman = verify.detail?.trim()
  if (!targetHuman && verify.body) {
    const first = verify.body.split("\n")[0] ?? ""
    const m = first.match(/^([^:]+):/)
    if (m) targetHuman = m[1]!.trim()
  }

  function tryAttach(step: ResponseStepBlockPart): ResponseStepBlockPart | null {
    if (!step.stepName) return null
    if (targetHuman && !matchingStepName(step.stepName, targetHuman)) return null

    const attempts = step.attempts ?? [toAttempt(step, 0)]
    const outcome = step.outcome ?? deriveStepBlockOutcome(attempts)

    // Final pass after repair: resolve the mid-loop "needs work" so the tree
    // does not end on a failing check while the header says Repaired.
    if (verify.label === "Checked work") {
      const hasStory =
        attempts.length > 1
        || Boolean(step.body?.trim())
        || outcome === "repaired"
        || outcome === "failed"
        || Boolean(step.check)
      if (!hasStory && !targetHuman) return null
      if (outcome === "repaired" || (step.check && attempts.length > 1)) {
        return {
          ...step,
          attempts,
          title: domainStepTitle(step),
          outcome,
          check: {
            label: "Checked work",
            status: "done",
            // Keep slot between fail and repair — not after the successful attempt.
            afterAttemptIndex: step.check?.afterAttemptIndex ?? 0,
          },
        }
      }
      if (step.check) return step
    }

    // Mid-loop "needs work" sits after the latest failed attempt (usually 0).
    let afterAttemptIndex = 0
    if (verify.label.startsWith("Check")) {
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i]!.status === "failed") {
          afterAttemptIndex = i
          break
        }
      }
    }

    const withCheck: ResponseStepBlockPart = {
      ...step,
      check: {
        ...check,
        afterAttemptIndex,
      },
      attempts,
      title: domainStepTitle(step),
      outcome,
    }
    return withCheck
  }

  // Search already-emitted next parts (primary folded steps).
  for (let i = next.length - 1; i >= 0; i--) {
    const p = next[i]!
    if (p.kind !== "step-block") continue
    const attached = tryAttach(p)
    if (!attached) continue
    next[i] = attached
    return true
  }

  // Fallback: still-unfolded single step ahead in the stream (same pass).
  for (let i = 0; i < allParts.length; i++) {
    if (remove.has(i)) continue
    if (folded.has(i)) continue
    const p = allParts[i]!
    if (p.kind !== "step-block") continue
    const attached = tryAttach(p)
    if (!attached) continue
    folded.set(i, attached)
    // If we already pushed this index... we haven't — it's ahead. Mark fold for when we reach it.
    return true
  }

  // "Checked work" with no nest home — caller omits.
  if (verify.label === "Checked work") return true

  return false
}

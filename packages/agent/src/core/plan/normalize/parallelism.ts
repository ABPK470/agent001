/**
 * Parallel plans must actually fan out. The LLM often stamps
 * canRunParallel:false and chains every step with dependsOn/edges even when
 * steps only share a theme (e.g. three independent catalog inspections).
 * ExecutionMode "parallel" then still runs maxParallel=4 against a width-1 DAG.
 *
 * Fix: mark safe investigation peers as parallelizable, then drop edges that
 * are not justified by a real artifact handoff (requiredSourceArtifacts).
 */

import { READ_ONLY_TOOL_NAMES } from "../../../domain/types/agent-constants.js"
import { normalizeSpecPath } from "../blueprint-contract/index.js"
import { isEvidenceArtifact } from "../blueprint-contract/index.js"
import type { Plan, PlanEdge, SubagentTaskStep } from "../types.js"

const WRITEISH_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
  "append_file",
  "run_command",
  "shell",
  "export_query_to_file",
])

function isBlueprintStep(step: SubagentTaskStep): boolean {
  return (
    /blueprint/i.test(step.name) ||
    step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  )
}

function artifactOwnerMap(steps: readonly SubagentTaskStep[]): Map<string, string> {
  const owners = new Map<string, string>()
  for (const step of steps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      owners.set(normalizeSpecPath(artifact), step.name)
    }
  }
  return owners
}

function readsOwnedUpstream(step: SubagentTaskStep, owners: ReadonlyMap<string, string>): boolean {
  return step.executionContext.requiredSourceArtifacts.some((artifact) => {
    const owner = owners.get(normalizeSpecPath(artifact))
    return Boolean(owner && owner !== step.name)
  })
}

function declaredTools(step: SubagentTaskStep): string[] {
  return [
    ...step.requiredToolCapabilities,
    ...step.executionContext.allowedTools,
  ]
}

/**
 * Investigation / evidence peers — safe to fan out.
 *
 * LLM default effectClass is often filesystem_write even for catalog-only
 * steps, and targetArtifacts are often empty. Those must still parallelize
 * or the UI shows one subagent at a time despite executionMode=parallel.
 */
export function isInvestigationParallelCandidate(step: SubagentTaskStep): boolean {
  if (isBlueprintStep(step)) return false
  if (step.executionContext.effectClass === "readonly") return true

  const targets = step.executionContext.targetArtifacts
  if (targets.length > 0 && targets.every((artifact) => isEvidenceArtifact(artifact))) {
    return true
  }

  // No file outputs: treat as investigation unless a write/shell tool is
  // *required*. Ignore loose allowedTools noise (plans often list write_file
  // even for catalog-only probes).
  if (targets.length === 0) {
    const required = step.requiredToolCapabilities
    const tools = required.length > 0 ? required : declaredTools(step)
    if (tools.length === 0) return true
    if (tools.some((name) => WRITEISH_TOOL_NAMES.has(name))) return false
    return tools.every(
      (name) =>
        READ_ONLY_TOOL_NAMES.has(name) ||
        name === "think" ||
        name === "note" ||
        name === "ask_user",
    )
  }

  return false
}

/** Mark independent investigation/evidence steps as canRunParallel. */
export function markSafeStepsParallelizable(plan: Plan): number {
  const subagents = plan.steps.filter(
    (step): step is SubagentTaskStep => step.stepType === "subagent_task",
  )
  const owners = artifactOwnerMap(subagents)
  let marked = 0
  for (const step of subagents) {
    if (step.canRunParallel) continue
    if (!isInvestigationParallelCandidate(step)) continue
    if (readsOwnedUpstream(step, owners)) continue
    ;(step as { canRunParallel: boolean }).canRunParallel = true
    marked++
  }
  return marked
}

function edgeJustifiedByArtifacts(from: SubagentTaskStep, to: SubagentTaskStep): boolean {
  const fromArts = new Set(from.executionContext.targetArtifacts.map(normalizeSpecPath))
  return to.executionContext.requiredSourceArtifacts.some((artifact) =>
    fromArts.has(normalizeSpecPath(artifact)),
  )
}

/**
 * Drop A→B edges when both steps are investigation peers and B does not
 * read A's artifacts. Keeps blueprint → implement edges and true data handoffs.
 *
 * Pure readonly→readonly chains never justify serialization (no file handoff).
 */
export function pruneSpuriousSerialEdges(plan: Plan): number {
  const byName = new Map(
    plan.steps
      .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
      .map((step) => [step.name, step] as const),
  )

  const kept: PlanEdge[] = []
  let pruned = 0
  for (const edge of plan.edges) {
    const from = byName.get(edge.from)
    const to = byName.get(edge.to)
    if (!from || !to) {
      kept.push(edge)
      continue
    }
    if (isBlueprintStep(from)) {
      kept.push(edge)
      continue
    }

    const bothReadonly =
      from.executionContext.effectClass === "readonly" &&
      to.executionContext.effectClass === "readonly"
    if (bothReadonly) {
      pruned++
      continue
    }

    if (edgeJustifiedByArtifacts(from, to)) {
      kept.push(edge)
      continue
    }

    const bothInvestigation =
      isInvestigationParallelCandidate(from) && isInvestigationParallelCandidate(to)
    if (bothInvestigation || (from.canRunParallel && to.canRunParallel)) {
      pruned++
      continue
    }

    kept.push(edge)
  }

  if (pruned === 0) return 0

  ;(plan as unknown as { edges: PlanEdge[] }).edges = kept

  for (const step of byName.values()) {
    if (!step.dependsOn || step.dependsOn.length === 0) continue
    const next = step.dependsOn.filter((dep) =>
      kept.some((edge) => edge.from === dep && edge.to === step.name),
    )
    ;(step as unknown as { dependsOn: string[] }).dependsOn = next
  }

  return pruned
}

/** Prepare a plan so parallel executionMode can actually fan out. */
export function preparePlanParallelism(plan: Plan): { marked: number; prunedEdges: number } {
  const marked = markSafeStepsParallelizable(plan)
  const prunedEdges = pruneSpuriousSerialEdges(plan)
  return { marked, prunedEdges }
}

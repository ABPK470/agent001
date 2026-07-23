/**
 * Parallel plans must actually fan out — without regressing correctness.
 *
 * First principles (hard rules):
 * 1. Real artifact handoffs serialize. If B lists A's target in
 *    requiredSourceArtifacts, A→B stays. Parent/downstream never starts
 *    until upstream completes (pipeline inDegree + Promise.allSettled).
 * 2. Blueprint gates serialize. Anything depending on BLUEPRINT.md waits.
 * 3. Shared write targets are rejected at plan validate (`shared_target_artifact`);
 *    children are also write-scoped to their own targetArtifacts.
 * 4. Thematic dependsOn chains (same topic, no file handoff) are noise —
 *    those edges are pruned so independent peers can run together — including
 *    codegen siblings after a blueprint gate (LLM often chains A→B→C→D with
 *    canRunParallel:false even when targets are distinct).
 *
 * Never prune an edge when a real handoff or shared write target is declared.
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
  return [...step.requiredToolCapabilities, ...step.executionContext.allowedTools]
}

/**
 * Investigation / evidence peers — safe to fan out when there is no
 * justified artifact edge between them.
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
    // Consumer of another step's artifact must wait — do not mark parallel.
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

function shareWriteTarget(from: SubagentTaskStep, to: SubagentTaskStep): boolean {
  const fromArts = new Set(from.executionContext.targetArtifacts.map(normalizeSpecPath))
  return to.executionContext.targetArtifacts.some((artifact) =>
    fromArts.has(normalizeSpecPath(artifact)),
  )
}

/**
 * Drop thematic A→B edges only. Keep:
 * - blueprint → *
 * - real requiredSourceArtifacts handoffs
 * - shared targetArtifact ownership (must not rewrite the same file concurrently)
 *
 * Everything else without a real handoff is noise — including codegen
 * A→B thematic chains with canRunParallel:false. Those kept the DAG at
 * width-1 despite executionMode=parallel (one subagent, then Check, then
 * the next alone).
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

    // (1) Blueprint gate — always serialize.
    if (isBlueprintStep(from)) {
      kept.push(edge)
      continue
    }

    // (2) Real handoff — consumer waits for producer.
    if (edgeJustifiedByArtifacts(from, to)) {
      kept.push(edge)
      continue
    }

    // (3) Same write target — never concurrent (belt + validate error).
    if (shareWriteTarget(from, to)) {
      kept.push(edge)
      continue
    }

    // (4) Thematic / undeclared chain — drop so peers can fan out.
    pruned++
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

/** Prepare a plan so parallel executionMode can actually fan out safely. */
export function preparePlanParallelism(plan: Plan): { marked: number; prunedEdges: number } {
  const marked = markSafeStepsParallelizable(plan)
  const prunedEdges = pruneSpuriousSerialEdges(plan)
  return { marked, prunedEdges }
}

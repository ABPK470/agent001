/**
 * Parallel plans must actually fan out — without regressing correctness.
 *
 * First principles (hard rules):
 * 1. Real deliverable handoffs serialize. If a non-investigation consumer lists
 *    an upstream target in requiredSourceArtifacts, A→B stays (and acceptance
 *    blockers still gate readiness).
 * 2. Blueprint gates serialize. Anything depending on BLUEPRINT.md waits.
 * 3. Shared write targets are rejected at plan validate (`shared_target_artifact`);
 *    children are also write-scoped to their own targetArtifacts.
 * 4. Thematic dependsOn chains (same topic, no real deliverable handoff) are
 *    noise — edges are pruned so independent peers can run together.
 * 5. Investigation/evidence peers that only "hand off" each other's notes
 *    (tmp/*.json, *.md evidence) are also noise. Each peer can re-query the
 *    DB. Those edges AND the matching requiredSourceArtifacts are stripped —
 *    otherwise prune edges alone still leaves acceptance blockers width-1.
 *
 * "Plan · Parallel" means maxParallel>1 for ready steps — not that the DAG
 * is wide. This normalize pass is what makes the DAG honest.
 *
 * The executor fills free slots as soon as any in-flight peer settles — it does
 * not wait for an entire wave before starting the next ready step.
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
 * justified deliverable handoff between them.
 */
export function isInvestigationParallelCandidate(step: SubagentTaskStep): boolean {
  if (isBlueprintStep(step)) return false

  // Required write/shell tools → not a fan-out investigation peer.
  // "Write the client answer" must still wait on analyze notes even when the
  // deliverable is a .md/.json evidence path. Loose allowedTools may still
  // list write_file for catalog probes — only *required* counts here.
  const required = step.requiredToolCapabilities
  if (required.some((name) => WRITEISH_TOOL_NAMES.has(name))) return false

  if (step.executionContext.effectClass === "readonly") return true

  const targets = step.executionContext.targetArtifacts
  if (targets.length > 0 && targets.every((artifact) => isEvidenceArtifact(artifact))) {
    return true
  }

  // No file outputs: treat as investigation unless tools are writeish.
  // Ignore loose allowedTools noise (plans often list write_file even for
  // catalog-only probes) — prefer requiredToolCapabilities when present.
  if (targets.length === 0) {
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

/**
 * Evidence notes between two investigation peers — not a deliverable handoff.
 * Keeping these serializes Type B plans even after thematic edges are pruned
 * (acceptance blockers still wait on the upstream step).
 */
function isInvestigationEvidenceHandoff(from: SubagentTaskStep, to: SubagentTaskStep): boolean {
  if (!isInvestigationParallelCandidate(from) || !isInvestigationParallelCandidate(to)) {
    return false
  }
  const fromArts = from.executionContext.targetArtifacts
  if (fromArts.length === 0) return false
  if (!fromArts.every((artifact) => isEvidenceArtifact(artifact))) return false

  const fromSet = new Set(fromArts.map(normalizeSpecPath))
  const linked = to.executionContext.requiredSourceArtifacts.filter((artifact) =>
    fromSet.has(normalizeSpecPath(artifact)),
  )
  if (linked.length === 0) return false
  return linked.every((artifact) => isEvidenceArtifact(artifact))
}

function edgeJustifiedByArtifacts(from: SubagentTaskStep, to: SubagentTaskStep): boolean {
  if (isInvestigationEvidenceHandoff(from, to)) return false
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
 * Drop investigation↔investigation evidence sources so acceptance blockers
 * match pruned edges. Leave sources that feed a non-investigation consumer
 * (e.g. analyze notes → write client answer).
 */
export function pruneSpuriousInvestigationSources(plan: Plan): number {
  const subagents = plan.steps.filter(
    (step): step is SubagentTaskStep => step.stepType === "subagent_task",
  )
  const byName = new Map(subagents.map((step) => [step.name, step] as const))
  const owners = artifactOwnerMap(subagents)
  let stripped = 0

  for (const step of subagents) {
    if (!isInvestigationParallelCandidate(step)) continue
    if (step.executionContext.requiredSourceArtifacts.length === 0) continue

    const next = step.executionContext.requiredSourceArtifacts.filter((artifact) => {
      const ownerName = owners.get(normalizeSpecPath(artifact))
      if (!ownerName || ownerName === step.name) return true
      const owner = byName.get(ownerName)
      if (!owner) return true
      if (!isInvestigationEvidenceHandoff(owner, step)) return true
      stripped++
      return false
    })

    if (next.length !== step.executionContext.requiredSourceArtifacts.length) {
      ;(step.executionContext as { requiredSourceArtifacts: string[] }).requiredSourceArtifacts = next
    }
  }

  return stripped
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
    // Consumer of a real (non-investigation-evidence) upstream artifact must wait.
    if (readsOwnedUpstream(step, owners)) continue
    ;(step as { canRunParallel: boolean }).canRunParallel = true
    marked++
  }
  return marked
}

/**
 * Drop thematic A→B edges only. Keep:
 * - blueprint → *
 * - real deliverable handoffs (not investigation evidence notes)
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

    // (2) Real deliverable handoff — consumer waits for producer.
    if (edgeJustifiedByArtifacts(from, to)) {
      kept.push(edge)
      continue
    }

    // (3) Same write target — never concurrent (belt + validate error).
    if (shareWriteTarget(from, to)) {
      kept.push(edge)
      continue
    }

    // (4) Thematic / investigation-evidence chain — drop so peers can fan out.
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
export function preparePlanParallelism(plan: Plan): {
  marked: number
  prunedEdges: number
  strippedSources: number
} {
  // Strip investigation evidence sources first so mark/prune see a clean graph
  // and compilePlannerRuntime acceptance deps do not re-serialize peers.
  const strippedSources = pruneSpuriousInvestigationSources(plan)
  const marked = markSafeStepsParallelizable(plan)
  const prunedEdges = pruneSpuriousSerialEdges(plan)
  return { marked, prunedEdges, strippedSources }
}

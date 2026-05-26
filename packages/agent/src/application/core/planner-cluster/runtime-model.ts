import type {
    ArtifactOwnershipNode,
    ExecutionGraphNode,
    Plan,
    PlannerRuntimeModel,
    PlanStep,
    RuntimeEntityDescriptor,
    SubagentTaskStep,
} from "./types.js"

function normalizeArtifactPath(value: string): string {
  return value.replace(/^\.\//, "")
}

function getStepDependencies(step: PlanStep, plan: Plan): string[] {
  const explicit = new Set(step.dependsOn ?? [])
  for (const edge of plan.edges) {
    if (edge.to === step.name) explicit.add(edge.from)
  }
  return [...explicit]
}

function collectArtifactReads(step: SubagentTaskStep): string[] {
  return step.executionContext.artifactRelations
    .filter((relation) => relation.relationType === "read_dependency")
    .map((relation) => normalizeArtifactPath(relation.artifactPath))
}

function collectArtifactWrites(step: SubagentTaskStep): string[] {
  const writes = new Set<string>()
  for (const relation of step.executionContext.artifactRelations) {
    if (relation.relationType === "write_owner") writes.add(normalizeArtifactPath(relation.artifactPath))
  }
  for (const artifact of step.executionContext.targetArtifacts) writes.add(normalizeArtifactPath(artifact))
  return [...writes]
}

export function compilePlannerRuntime(plan: Plan): PlannerRuntimeModel {
  const executionGraph = new Map<string, ExecutionGraphNode>()
  const ownershipGraph = new Map<string, ArtifactOwnershipNode>()
  const runtimeEntities: RuntimeEntityDescriptor[] = [{
    id: "planner-run",
    entityType: "planner_run",
  }]
  const stepAcceptedDependencies = new Map<string, readonly string[]>()

  for (const step of plan.steps) {
    const dependsOn = getStepDependencies(step, plan)
    const downstream = plan.edges.filter((edge) => edge.from === step.name).map((edge) => edge.to)
    executionGraph.set(step.name, {
      stepName: step.name,
      stepType: step.stepType,
      dependsOn,
      downstream,
    })
    runtimeEntities.push({
      id: `step:${step.name}`,
      entityType: "pipeline_step",
      parentId: "planner-run",
      stepName: step.name,
    })
    runtimeEntities.push({
      id: `worker:${step.name}`,
      entityType: "delegated_worker",
      parentId: `step:${step.name}`,
      stepName: step.name,
    })
  }

  const artifactConsumers = new Map<string, Set<string>>()
  const artifactOwners = new Map<string, string>()
  const artifactRelationTypes = new Map<string, Set<"read_dependency" | "write_owner">>()

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const subagentStep = step as SubagentTaskStep

    for (const artifact of collectArtifactWrites(subagentStep)) {
      artifactOwners.set(artifact, step.name)
      const relationTypes = artifactRelationTypes.get(artifact) ?? new Set()
      relationTypes.add("write_owner")
      artifactRelationTypes.set(artifact, relationTypes)
    }

    const readArtifacts = new Set<string>([
      ...collectArtifactReads(subagentStep),
      ...subagentStep.executionContext.requiredSourceArtifacts.map(normalizeArtifactPath),
    ])
    const acceptedDeps = new Set<string>()
    for (const artifact of readArtifacts) {
      const consumers = artifactConsumers.get(artifact) ?? new Set<string>()
      consumers.add(step.name)
      artifactConsumers.set(artifact, consumers)
      const relationTypes = artifactRelationTypes.get(artifact) ?? new Set()
      relationTypes.add("read_dependency")
      artifactRelationTypes.set(artifact, relationTypes)
    }

    for (const artifact of readArtifacts) {
      const owner = artifactOwners.get(artifact)
      if (owner && owner !== step.name) acceptedDeps.add(owner)
    }
    stepAcceptedDependencies.set(step.name, [...acceptedDeps])
  }

  const allArtifacts = new Set<string>([
    ...artifactOwners.keys(),
    ...artifactConsumers.keys(),
  ])

  for (const artifact of allArtifacts) {
    ownershipGraph.set(artifact, {
      artifactPath: artifact,
      ownerStepName: artifactOwners.get(artifact) ?? null,
      consumerStepNames: [...(artifactConsumers.get(artifact) ?? new Set<string>())],
      relationTypes: [...(artifactRelationTypes.get(artifact) ?? new Set())],
    })
  }

  runtimeEntities.push({ id: "verification:current", entityType: "verification_pass", parentId: "planner-run" })
  runtimeEntities.push({ id: "repair:current", entityType: "repair_cycle", parentId: "planner-run" })

  return {
    executionGraph,
    ownershipGraph,
    stepAcceptedDependencies,
    runtimeEntities,
  }
}

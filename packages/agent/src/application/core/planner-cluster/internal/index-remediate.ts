import { StepRole, VerificationMode } from "../../domain/index.js"
/**
 * Plan remediation — step merging, dependency graph traversal, and
 * automatic remediation of validation errors.
 *
 * Extracted from index-normalize.ts for maintainability.
 *
 * @module
 */

import { mostFrequent, normalizePlanOutputDirectory, uniqueList } from "../normalize/index.js"
import type { Plan, PlanDiagnostic, PlanEdge, PlanStep, SubagentTaskStep } from "../types.js"

export function inferOutputDir(steps: readonly SubagentTaskStep[]): string | null {
  const dirs: string[] = []
  for (const step of steps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const normalized = artifact.replace(/^\.\//, "")
      const slash = normalized.lastIndexOf("/")
      if (slash > 0) {
        const topDir = normalized.split("/")[0]
        if (topDir) dirs.push(topDir)
      }
    }
  }
  return mostFrequent(dirs) ?? null
}

function mergeEffectClass(
  left: SubagentTaskStep["executionContext"]["effectClass"],
  right: SubagentTaskStep["executionContext"]["effectClass"]
): SubagentTaskStep["executionContext"]["effectClass"] {
  if (left === right) return left
  if (left === "mixed" || right === "mixed") return "mixed"
  if (left === "shell" || right === "shell") return "mixed"
  if (left === "readonly") return right
  if (right === "readonly") return left
  if (left === "filesystem_scaffold" || right === "filesystem_scaffold") return "filesystem_scaffold"
  return "filesystem_write"
}

function mergeVerificationMode(
  left: SubagentTaskStep["executionContext"]["verificationMode"],
  right: SubagentTaskStep["executionContext"]["verificationMode"]
): SubagentTaskStep["executionContext"]["verificationMode"] {
  const precedence: readonly SubagentTaskStep["executionContext"]["verificationMode"][] = [
    "run_tests",
    "deterministic_followup",
    "mutation_required",
    "none"
  ]
  for (const mode of precedence) {
    if (left === mode || right === mode) return mode
  }
  return left
}

function buildPlannerDependencyMap(plan: Plan): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>()
  for (const step of plan.steps) {
    deps.set(step.name, new Set(step.dependsOn ?? []))
  }
  for (const edge of plan.edges) {
    const set = deps.get(edge.to) ?? new Set<string>()
    set.add(edge.from)
    deps.set(edge.to, set)
  }
  return deps
}

function stepTransitivelyDependsOn(plan: Plan, stepName: string, targetName: string): boolean {
  if (stepName === targetName) return false
  const deps = buildPlannerDependencyMap(plan)
  const seen = new Set<string>()
  const stack = [...(deps.get(stepName) ?? [])]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === targetName) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(deps.get(current) ?? []))
  }

  return false
}

function mergeSubagentSteps(plan: Plan, primaryStepName: string, secondaryStepName: string): boolean {
  if (primaryStepName === secondaryStepName) return false

  const mutableSteps = plan.steps as PlanStep[]
  const primaryIndex = mutableSteps.findIndex((step) => step.name === primaryStepName)
  const secondaryIndex = mutableSteps.findIndex((step) => step.name === secondaryStepName)
  if (primaryIndex < 0 || secondaryIndex < 0) return false

  const primary = mutableSteps[primaryIndex]
  const secondary = mutableSteps[secondaryIndex]
  if (primary.stepType !== "subagent_task" || secondary.stepType !== "subagent_task") return false

  const mergedDependsOn = uniqueList(
    [...(primary.dependsOn ?? []), ...(secondary.dependsOn ?? [])].filter(
      (name) => name !== primary.name && name !== secondary.name
    )
  )

  const mergedTargetArtifacts = uniqueList([
    ...primary.executionContext.targetArtifacts,
    ...secondary.executionContext.targetArtifacts
  ])

  const mergedExecutionContext: SubagentTaskStep["executionContext"] = {
    ...primary.executionContext,
    allowedReadRoots: uniqueList([
      ...primary.executionContext.allowedReadRoots,
      ...secondary.executionContext.allowedReadRoots
    ]),
    allowedWriteRoots: uniqueList([
      ...primary.executionContext.allowedWriteRoots,
      ...secondary.executionContext.allowedWriteRoots
    ]),
    allowedTools: uniqueList([
      ...primary.executionContext.allowedTools,
      ...secondary.executionContext.allowedTools
    ]),
    requiredSourceArtifacts: uniqueList([
      ...primary.executionContext.requiredSourceArtifacts,
      ...secondary.executionContext.requiredSourceArtifacts
    ]),
    targetArtifacts: mergedTargetArtifacts,
    effectClass: mergeEffectClass(
      primary.executionContext.effectClass,
      secondary.executionContext.effectClass
    ),
    verificationMode: mergeVerificationMode(
      primary.executionContext.verificationMode,
      secondary.executionContext.verificationMode
    ),
    artifactRelations: [
      ...new Map(
        [
          ...primary.executionContext.artifactRelations,
          ...secondary.executionContext.artifactRelations,
          ...mergedTargetArtifacts.map((artifactPath) => ({
            relationType: "write_owner" as const,
            artifactPath
          }))
        ].map((relation) => [`${relation.relationType}:${relation.artifactPath}`, relation])
      ).values()
    ],
    role: primary.executionContext.role ?? secondary.executionContext.role,
    sharedStateContract:
      primary.executionContext.sharedStateContract ?? secondary.executionContext.sharedStateContract
  }

  const mergedWorkflowRelations = [
    ...(primary.workflowStep?.artifactRelations ?? []),
    ...(secondary.workflowStep?.artifactRelations ?? [])
  ]

  const mergedStep: SubagentTaskStep = {
    ...primary,
    dependsOn: mergedDependsOn,
    objective: `${primary.objective}\n\nAlso complete the integration follow-up originally scoped to ${secondary.name}: ${secondary.objective}`,
    inputContract: uniqueList([primary.inputContract, secondary.inputContract]).join("\n\n"),
    acceptanceCriteria: uniqueList([...primary.acceptanceCriteria, ...secondary.acceptanceCriteria]),
    requiredToolCapabilities: uniqueList([
      ...primary.requiredToolCapabilities,
      ...secondary.requiredToolCapabilities
    ]),
    contextRequirements: uniqueList([...primary.contextRequirements, ...secondary.contextRequirements]),
    executionContext: mergedExecutionContext,
    maxBudgetHint: primary.maxBudgetHint,
    canRunParallel: false,
    workflowStep:
      mergedWorkflowRelations.length > 0
        ? {
            role:
              primary.workflowStep?.role ??
              secondary.workflowStep?.role ??
              primary.executionContext.role ??
              secondary.executionContext.role ??
              StepRole.Writer,
            artifactRelations: [
              ...new Map(
                mergedWorkflowRelations.map((relation) => [
                  `${relation.relationType}:${relation.artifactPath}`,
                  relation
                ])
              ).values()
            ]
          }
        : primary.workflowStep
  }

  mutableSteps[primaryIndex] = mergedStep
  mutableSteps.splice(secondaryIndex, 1)

  for (const step of mutableSteps) {
    if (!step.dependsOn || step.dependsOn.length === 0) continue
    const rewritten = uniqueList(
      step.dependsOn.map((dep) => (dep === secondaryStepName ? primaryStepName : dep))
    ).filter((dep) => dep !== step.name)
    ;(step as { dependsOn?: string[] }).dependsOn = rewritten.length > 0 ? rewritten : undefined
  }

  const mutableEdges = plan.edges as PlanEdge[]
  const rewrittenEdges = mutableEdges
    .map((edge) => ({
      from: edge.from === secondaryStepName ? primaryStepName : edge.from,
      to: edge.to === secondaryStepName ? primaryStepName : edge.to
    }))
    .filter((edge) => edge.from !== edge.to)

  ;(plan as unknown as { edges: PlanEdge[] }).edges = [
    ...new Map(rewrittenEdges.map((edge) => [`${edge.from}->${edge.to}`, edge])).values()
  ]

  return true
}

function remediateSharedTargetArtifactWriters(plan: Plan): boolean {
  const subagentSteps = plan.steps.filter(
    (step): step is SubagentTaskStep => step.stepType === "subagent_task"
  )
  const writersByArtifact = new Map<string, string[]>()

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const writers = writersByArtifact.get(artifact) ?? []
      if (!writers.includes(step.name)) writers.push(step.name)
      writersByArtifact.set(artifact, writers)
    }
  }

  let changed = false
  for (const [artifact, writers] of writersByArtifact) {
    if (writers.length !== 2) continue
    const [leftName, rightName] = writers
    const leftDependsOnRight = stepTransitivelyDependsOn(plan, leftName, rightName)
    const rightDependsOnLeft = stepTransitivelyDependsOn(plan, rightName, leftName)
    if (leftDependsOnRight === rightDependsOnLeft) continue

    const primaryName = rightDependsOnLeft ? leftName : rightName
    const secondaryName = rightDependsOnLeft ? rightName : leftName
    if (mergeSubagentSteps(plan, primaryName, secondaryName)) {
      changed = true
    }

    if (changed) {
      const remainingWriters = plan.steps
        .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
        .filter((step) => step.executionContext.targetArtifacts.includes(artifact))
      if (remainingWriters.length <= 1) continue
    }
  }

  return changed
}

export function remediateValidationErrors(plan: Plan, errors: readonly PlanDiagnostic[]): boolean {
  let changed = false
  const subagentSteps = plan.steps.filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")

  if (errors.some((e) => e.code === "inconsistent_output_directory" || e.code === "mixed_root_and_subdir")) {
    normalizePlanOutputDirectory(plan)
    changed = true
  }

  if (errors.some((e) => e.code === "shared_target_artifact")) {
    changed = remediateSharedTargetArtifactWriters(plan) || changed
  }

  return changed
}

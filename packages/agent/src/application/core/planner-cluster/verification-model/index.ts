import { VerifierMode, VerifierOutcome } from "../../domain/index.js"
import {
  buildEvidenceId,
  deriveOwnershipAttribution,
  getSubagentStep,
  inferAffectedArtifacts,
  inferIssueCode,
  inferRepairClass,
  inferSeverity,
  inferSourceArtifacts,
  isDependencyGateIssue,
  normalizePath,
  uniqueStrings
} from "../internal/verification-inference.js"
import { compilePlannerRuntime } from "../runtime-model.js"
import type {
  ChildRepairGoal,
  ChildRepairPayload,
  PipelineResult,
  Plan,
  RepairPlan,
  RepairTask,
  StepAcceptanceState,
  VerificationEvidence,
  VerifierDecision,
  VerifierIssue,
  VerifierStepAssessment
} from "../types.js"

export function collectVerificationEvidence(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  source: VerificationEvidence["source"]
): Map<string, VerificationEvidence[]> {
  const evidenceByStep = new Map<string, VerificationEvidence[]>()
  for (const assessment of assessments) {
    const step = getSubagentStep(plan, assessment.stepName)
    const evidence: VerificationEvidence[] = []
    assessment.issues.forEach((summary, index) => {
      const code = inferIssueCode(summary)
      const affectedArtifacts = inferAffectedArtifacts(step, summary)
      const evidenceId = buildEvidenceId(assessment.stepName, source, index + 1, code)
      evidence.push({
        id: evidenceId,
        stepName: assessment.stepName,
        source,
        kind: code,
        message: summary,
        artifactPaths: affectedArtifacts
      })
    })
    evidenceByStep.set(assessment.stepName, evidence)
  }
  return evidenceByStep
}

export function deriveIssuesFromEvidence(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  evidenceByStep: ReadonlyMap<string, readonly VerificationEvidence[]>
): Map<string, VerifierIssue[]> {
  const issuesByStep = new Map<string, VerifierIssue[]>()

  for (const assessment of assessments) {
    const step = getSubagentStep(plan, assessment.stepName)
    const stepEvidence = evidenceByStep.get(assessment.stepName) ?? []
    const issueDetails = stepEvidence.map((evidence) => {
      const affectedArtifacts =
        evidence.artifactPaths.length > 0
          ? [...evidence.artifactPaths]
          : inferAffectedArtifacts(step, evidence.message)
      const sourceArtifacts = inferSourceArtifacts(step, evidence.message)
      const attribution = deriveOwnershipAttribution(
        plan,
        evidence.source,
        assessment.stepName,
        affectedArtifacts,
        sourceArtifacts,
        evidence.message
      )
      return {
        code: evidence.kind,
        severity: inferSeverity(evidence.message),
        retryable: assessment.retryable,
        ownerStepName: attribution.ownerStepName,
        confidence: attribution.confidence,
        ownershipMode: attribution.ownershipMode,
        suspectedOwners: attribution.suspectedOwners,
        primaryOwner: attribution.primaryOwner,
        affectedArtifacts,
        sourceArtifacts,
        evidenceIds: [evidence.id],
        repairClass: inferRepairClass(evidence.message),
        summary: evidence.message
      } satisfies VerifierIssue
    })
    issuesByStep.set(assessment.stepName, issueDetails)
  }

  return issuesByStep
}

export function enrichVerifierAssessments(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  source: VerificationEvidence["source"]
): VerifierStepAssessment[] {
  const evidenceByStep = collectVerificationEvidence(plan, assessments, source)
  const issuesByStep = deriveIssuesFromEvidence(plan, assessments, evidenceByStep)

  return assessments.map((assessment) => {
    return {
      ...assessment,
      evidence: assessment.evidence ?? evidenceByStep.get(assessment.stepName) ?? [],
      issueDetails: assessment.issueDetails ?? issuesByStep.get(assessment.stepName) ?? []
    }
  })
}

export function buildIssueIdentity(assessment: VerifierStepAssessment): string {
  const typed = assessment.issueDetails?.length
    ? assessment.issueDetails
        .map(
          (issue) =>
            `${issue.code}:${issue.severity}:${issue.primaryOwner ?? issue.ownerStepName}:${issue.ownershipMode}:${issue.affectedArtifacts.join(",")}`
        )
        .sort()
    : []
  if (typed.length > 0) return typed.join("|")
  return [...assessment.issues].sort().join("|")
}

export function buildRepairPlan(
  plan: Plan,
  pipelineResult: PipelineResult,
  decision: VerifierDecision
): RepairPlan {
  const runtime = compilePlannerRuntime(plan)
  const defaultAcceptedArtifactsByStep = new Map<string, string[]>()
  for (const assessment of decision.steps) {
    const step = getSubagentStep(plan, assessment.stepName)
    defaultAcceptedArtifactsByStep.set(
      assessment.stepName,
      uniqueStrings([
        ...(step?.executionContext.requiredSourceArtifacts.map(normalizePath) ?? []),
        ...(runtime.stepAcceptedDependencies.get(assessment.stepName) ?? []).flatMap(
          (dependencyStepName) => pipelineResult.stepResults.get(dependencyStepName)?.producedArtifacts ?? []
        )
      ])
    )
  }
  const taskMap = new Map<string, RepairTask>()
  const ensureTask = (stepName: string): RepairTask => {
    const existing = taskMap.get(stepName)
    if (existing) return existing
    const created: RepairTask = {
      stepName,
      mode: VerifierMode.Reverify,
      ownedIssues: [],
      dependencyContext: [],
      requiredAcceptedArtifacts: []
    }
    taskMap.set(stepName, created)
    return created
  }

  for (const assessment of decision.steps) {
    if (assessment.outcome === VerifierOutcome.Pass) continue
    const issueDetails = assessment.issueDetails ?? []
    if (issueDetails.length > 0 && issueDetails.every(isDependencyGateIssue)) continue
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const defaultRequiredAcceptedArtifacts = defaultAcceptedArtifactsByStep.get(assessment.stepName) ?? []

    for (const issue of issueDetails) {
      if (isDependencyGateIssue(issue)) continue
      const impactedSteps = uniqueStrings(
        issue.suspectedOwners.length > 0 ? issue.suspectedOwners : [assessment.stepName]
      )
      const primaryOwner = issue.primaryOwner ?? issue.ownerStepName
      for (const impactedStep of impactedSteps) {
        const task = ensureTask(impactedStep)
        const impactedStepResult = pipelineResult.stepResults.get(impactedStep)
        const impactedDefaultRequiredAcceptedArtifacts =
          defaultAcceptedArtifactsByStep.get(impactedStep) ?? []
        const shouldOwn =
          issue.ownershipMode === "deterministic_owner"
            ? primaryOwner === impactedStep
            : issue.ownershipMode === "planner_fault"
              ? primaryOwner === impactedStep
              : impactedSteps.includes(impactedStep)
        const ownedIssues = shouldOwn ? [...task.ownedIssues, issue] : [...task.ownedIssues]
        const dependencyContext = shouldOwn ? [...task.dependencyContext] : [...task.dependencyContext, issue]
        const externalSourceArtifacts = (issue.sourceArtifacts ?? []).filter((artifact) => {
          const normalized = normalizePath(artifact)
          const owner = runtime.ownershipGraph.get(normalized)?.ownerStepName
          return owner != null && owner !== impactedStep
        })
        const requiredAcceptedArtifacts = uniqueStrings([
          ...task.requiredAcceptedArtifacts,
          ...(!shouldOwn ? (issue.sourceArtifacts ?? []) : externalSourceArtifacts),
          ...impactedDefaultRequiredAcceptedArtifacts
        ])
        taskMap.set(impactedStep, {
          ...task,
          mode: !assessment.retryable
            ? "blocked"
            : impactedStepResult?.acceptanceState === "blocked"
              ? "blocked"
              : ownedIssues.length > 0
                ? "repair"
                : "reverify",
          ownedIssues,
          dependencyContext,
          requiredAcceptedArtifacts
        })
      }
    }

    if (issueDetails.length === 0) {
      const task = ensureTask(assessment.stepName)
      taskMap.set(assessment.stepName, {
        ...task,
        mode: !assessment.retryable
          ? "blocked"
          : stepResult?.acceptanceState === "blocked"
            ? "blocked"
            : "repair",
        requiredAcceptedArtifacts: uniqueStrings([
          ...task.requiredAcceptedArtifacts,
          ...defaultRequiredAcceptedArtifacts
        ])
      })
    }
  }

  const tasks = [...taskMap.values()]

  const rerunOrder = plan.steps
    .map((step) => step.name)
    .filter((name) => tasks.some((task) => task.stepName === name && task.mode !== "blocked"))

  return {
    tasks,
    rerunOrder,
    skippedVerifiedSteps: decision.steps
      .filter((step) => step.outcome === VerifierOutcome.Pass)
      .map((step) => step.stepName)
  }
}

export function deriveAcceptanceState(
  assessment: VerifierStepAssessment | undefined,
  prior: StepAcceptanceState | undefined
): StepAcceptanceState {
  if (!assessment) return prior ?? "pending_verification"
  if (assessment.outcome === VerifierOutcome.Pass) return "accepted"
  if (assessment.retryable === false) return "rejected"
  return "repair_required"
}

function buildRepairGoal(issue: VerifierIssue): ChildRepairGoal {
  return {
    issueCode: issue.code,
    summary: issue.summary,
    severity: issue.severity,
    repairClass: issue.repairClass,
    confidence: issue.confidence,
    ownershipMode: issue.ownershipMode,
    suspectedOwners: [...issue.suspectedOwners],
    primaryOwner: issue.primaryOwner,
    affectedArtifacts: [...issue.affectedArtifacts],
    sourceArtifacts: [...(issue.sourceArtifacts ?? [])]
  }
}

export function buildChildRepairPayload(task: RepairTask): ChildRepairPayload {
  const unresolvedDependencyBlockers =
    task.mode === "blocked" ? task.dependencyContext.map((issue) => issue.summary) : []

  return {
    mode:
      task.mode === "repair" || task.mode === "reverify" || task.mode === "blocked" ? task.mode : "initial",
    goals: task.ownedIssues.map(buildRepairGoal),
    dependencyGoals: task.dependencyContext.map(buildRepairGoal),
    requiredAcceptedArtifacts: [...task.requiredAcceptedArtifacts],
    unresolvedDependencyBlockers,
    preserveArchitecture: task.preserveArchitecture,
    architectureSummary: task.architectureSummary,
    sharedContracts: task.sharedContracts,
    invariants: task.invariants
  }
}

export { buildSystemChecks } from "./system-checks.js"

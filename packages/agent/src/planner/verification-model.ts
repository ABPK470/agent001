import { compilePlannerRuntime } from "./runtime-model.js"
import type {
    ChildRepairGoal,
    ChildRepairPayload,
    LegacyRetryPlan,
    PipelineResult,
    Plan,
    PlannerRepairCompatibilityMode,
    RepairPlan,
    RepairPlanCompatibilityReport,
    RepairTask,
    StepAcceptanceState,
    VerificationEvidence,
    VerifierDecision,
    VerifierIssue,
    VerifierStepAssessment,
    VerifierSystemCheck
} from "./types.js"
import {
    buildEvidenceId,
    deriveOwnershipAttribution,
    getArchitectureRepairContext,
    getSubagentStep,
    inferAffectedArtifacts,
    inferIssueCode,
    inferRepairClass,
    inferSeverity,
    inferSourceArtifacts,
    isDependencyGateIssue,
    normalizePath,
    uniqueStrings,
} from "./verification-inference.js"

export function collectVerificationEvidence(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  source: VerificationEvidence["source"],
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
        artifactPaths: affectedArtifacts,
      })
    })
    evidenceByStep.set(assessment.stepName, evidence)
  }
  return evidenceByStep
}

export function deriveIssuesFromEvidence(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  evidenceByStep: ReadonlyMap<string, readonly VerificationEvidence[]>,
): Map<string, VerifierIssue[]> {
  const issuesByStep = new Map<string, VerifierIssue[]>()

  for (const assessment of assessments) {
    const step = getSubagentStep(plan, assessment.stepName)
    const stepEvidence = evidenceByStep.get(assessment.stepName) ?? []
    const issueDetails = stepEvidence.map((evidence) => {
      const affectedArtifacts = evidence.artifactPaths.length > 0
        ? [...evidence.artifactPaths]
        : inferAffectedArtifacts(step, evidence.message)
      const sourceArtifacts = inferSourceArtifacts(step, evidence.message)
      const attribution = deriveOwnershipAttribution(plan, evidence.source, assessment.stepName, affectedArtifacts, sourceArtifacts, evidence.message)
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
        summary: evidence.message,
      } satisfies VerifierIssue
    })
    issuesByStep.set(assessment.stepName, issueDetails)
  }

  return issuesByStep
}

export function enrichVerifierAssessments(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  source: VerificationEvidence["source"],
): VerifierStepAssessment[] {
  const evidenceByStep = collectVerificationEvidence(plan, assessments, source)
  const issuesByStep = deriveIssuesFromEvidence(plan, assessments, evidenceByStep)

  return assessments.map((assessment) => {
    return {
      ...assessment,
      evidence: assessment.evidence ?? evidenceByStep.get(assessment.stepName) ?? [],
      issueDetails: assessment.issueDetails ?? issuesByStep.get(assessment.stepName) ?? [],
    }
  })
}

export function buildIssueIdentity(assessment: VerifierStepAssessment): string {
  const typed = assessment.issueDetails?.length
    ? assessment.issueDetails.map((issue) => `${issue.code}:${issue.severity}:${issue.primaryOwner ?? issue.ownerStepName}:${issue.ownershipMode}:${issue.affectedArtifacts.join(",")}`).sort()
    : []
  if (typed.length > 0) return typed.join("|")
  return [...assessment.issues].sort().join("|")
}

export function buildRepairPlan(
  plan: Plan,
  pipelineResult: PipelineResult,
  decision: VerifierDecision,
): RepairPlan {
  const runtime = compilePlannerRuntime(plan)
  const architectureContext = getArchitectureRepairContext(plan)
  const defaultAcceptedArtifactsByStep = new Map<string, string[]>()
  for (const assessment of decision.steps) {
    const step = getSubagentStep(plan, assessment.stepName)
    defaultAcceptedArtifactsByStep.set(assessment.stepName, uniqueStrings([
      ...(step?.executionContext.requiredSourceArtifacts.map(normalizePath) ?? []),
      ...((runtime.stepAcceptedDependencies.get(assessment.stepName) ?? [])
        .flatMap((dependencyStepName) => pipelineResult.stepResults.get(dependencyStepName)?.producedArtifacts ?? [])),
    ]))
  }
  const taskMap = new Map<string, RepairTask>()
  const ensureTask = (stepName: string): RepairTask => {
    const existing = taskMap.get(stepName)
    if (existing) return existing
    const created: RepairTask = {
      stepName,
      mode: "reverify",
      ownedIssues: [],
      dependencyContext: [],
      requiredAcceptedArtifacts: [],
      preserveArchitecture: architectureContext?.preserveArchitecture,
      architectureSummary: architectureContext?.architectureSummary,
      sharedContracts: architectureContext?.sharedContracts,
      invariants: architectureContext?.invariants,
    }
    taskMap.set(stepName, created)
    return created
  }

  for (const assessment of decision.steps) {
    if (assessment.outcome === "pass") continue
    const issueDetails = assessment.issueDetails ?? []
    if (issueDetails.length > 0 && issueDetails.every(isDependencyGateIssue)) continue
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const defaultRequiredAcceptedArtifacts = defaultAcceptedArtifactsByStep.get(assessment.stepName) ?? []

    for (const issue of issueDetails) {
      if (isDependencyGateIssue(issue)) continue
      const impactedSteps = uniqueStrings(issue.suspectedOwners.length > 0 ? issue.suspectedOwners : [assessment.stepName])
      const primaryOwner = issue.primaryOwner ?? issue.ownerStepName
      for (const impactedStep of impactedSteps) {
        const task = ensureTask(impactedStep)
        const impactedStepResult = pipelineResult.stepResults.get(impactedStep)
        const impactedDefaultRequiredAcceptedArtifacts = defaultAcceptedArtifactsByStep.get(impactedStep) ?? []
        const shouldOwn = issue.ownershipMode === "deterministic_owner"
          ? primaryOwner === impactedStep
          : issue.ownershipMode === "planner_fault"
            ? primaryOwner === impactedStep
            : impactedSteps.includes(impactedStep)
        const ownedIssues = shouldOwn ? [...task.ownedIssues, issue] : [...task.ownedIssues]
        const dependencyContext = shouldOwn
          ? [...task.dependencyContext]
          : [...task.dependencyContext, issue]
        const externalSourceArtifacts = (issue.sourceArtifacts ?? []).filter((artifact) => {
          const normalized = normalizePath(artifact)
          const owner = runtime.ownershipGraph.get(normalized)?.ownerStepName
          return owner != null && owner !== impactedStep
        })
        const requiredAcceptedArtifacts = uniqueStrings([
          ...task.requiredAcceptedArtifacts,
          ...(!shouldOwn ? (issue.sourceArtifacts ?? []) : externalSourceArtifacts),
          ...impactedDefaultRequiredAcceptedArtifacts,
        ])
        taskMap.set(impactedStep, {
          ...task,
          mode: !assessment.retryable
            ? "blocked"
            : (impactedStepResult?.acceptanceState === "blocked" ? "blocked" : ownedIssues.length > 0 ? "repair" : "reverify"),
          ownedIssues,
          dependencyContext,
          requiredAcceptedArtifacts,
        })
      }
    }

    if (issueDetails.length === 0) {
      const task = ensureTask(assessment.stepName)
      taskMap.set(assessment.stepName, {
        ...task,
        mode: !assessment.retryable
          ? "blocked"
          : (stepResult?.acceptanceState === "blocked" ? "blocked" : "repair"),
        requiredAcceptedArtifacts: uniqueStrings([...task.requiredAcceptedArtifacts, ...defaultRequiredAcceptedArtifacts]),
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
    skippedVerifiedSteps: decision.steps.filter((step) => step.outcome === "pass").map((step) => step.stepName),
  }
}

export function buildLegacyRetryPlan(
  plan: Plan,
  pipelineResult: PipelineResult,
  decision: VerifierDecision,
): LegacyRetryPlan {
  const nonRetryableFailureClasses = new Set(["cancelled", "spawn_error"])
  const architectureContext = getArchitectureRepairContext(plan)
  const tasks: RepairTask[] = []

  for (const assessment of decision.steps) {
    if (assessment.outcome === "pass") continue
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const isBlocked = assessment.retryable === false
      || (stepResult?.failureClass != null && nonRetryableFailureClasses.has(stepResult.failureClass))
      || stepResult?.acceptanceState === "blocked"

    tasks.push({
      stepName: assessment.stepName,
      mode: isBlocked ? "blocked" : "repair",
      ownedIssues: [...(assessment.issueDetails ?? [])],
      dependencyContext: [],
      requiredAcceptedArtifacts: [],
      preserveArchitecture: architectureContext?.preserveArchitecture,
      architectureSummary: architectureContext?.architectureSummary,
      sharedContracts: architectureContext?.sharedContracts,
      invariants: architectureContext?.invariants,
    })
  }

  const rerunOrder = plan.steps
    .map((step) => step.name)
    .filter((name) => tasks.some((task) => task.stepName === name && task.mode !== "blocked"))

  return {
    tasks,
    rerunOrder,
    skippedVerifiedSteps: decision.steps.filter((step) => step.outcome === "pass").map((step) => step.stepName),
  }
}

function taskCodes(task: RepairTask): string[] {
  return uniqueStrings(task.ownedIssues.map((issue) => issue.code)).sort()
}

export function compareRepairPlanCompatibility(
  mode: PlannerRepairCompatibilityMode,
  legacyPlan: LegacyRetryPlan,
  repairPlan: RepairPlan,
): RepairPlanCompatibilityReport {
  const reasons: string[] = []
  const activePath = mode === "legacy" ? "legacy" : "repair"

  const legacyTasks = new Map(legacyPlan.tasks.map((task) => [task.stepName, task]))
  const repairTasks = new Map(repairPlan.tasks.map((task) => [task.stepName, task]))

  const legacyRerun = new Set(legacyPlan.rerunOrder)
  const repairRerun = new Set(repairPlan.rerunOrder)
  const legacyOnly = [...legacyRerun].filter((stepName) => !repairRerun.has(stepName))
  const repairOnly = [...repairRerun].filter((stepName) => !legacyRerun.has(stepName))

  if (legacyOnly.length > 0) {
    reasons.push(`Legacy retry would rerun ${legacyOnly.join(", ")} but repair-plan scheduling would skip them.`)
  }
  if (repairOnly.length > 0) {
    reasons.push(`Repair-plan scheduling adds ${repairOnly.join(", ")} beyond the direct failing-step legacy retry set.`)
  }
  if (legacyPlan.rerunOrder.join("|") !== repairPlan.rerunOrder.join("|")) {
    reasons.push(`Rerun order diverged: legacy=${legacyPlan.rerunOrder.join(" -> ") || "none"}; repair=${repairPlan.rerunOrder.join(" -> ") || "none"}.`)
  }

  for (const stepName of [...new Set([...legacyTasks.keys(), ...repairTasks.keys()])]) {
    const legacyTask = legacyTasks.get(stepName)
    const repairTask = repairTasks.get(stepName)
    if (!legacyTask || !repairTask) continue

    if (legacyTask.mode !== repairTask.mode) {
      reasons.push(`Step ${stepName} mode diverged: legacy=${legacyTask.mode}, repair=${repairTask.mode}.`)
    }
    if (taskCodes(legacyTask).join("|") !== taskCodes(repairTask).join("|")) {
      reasons.push(`Step ${stepName} issue ownership diverged between legacy retry targeting and repair-plan targeting.`)
    }
    if (legacyTask.requiredAcceptedArtifacts.length !== repairTask.requiredAcceptedArtifacts.length) {
      reasons.push(`Step ${stepName} gained acceptance gates in repair-plan scheduling (${repairTask.requiredAcceptedArtifacts.length}) that legacy retry did not enforce.`)
    }
    if (legacyTask.dependencyContext.length !== repairTask.dependencyContext.length) {
      reasons.push(`Step ${stepName} gained dependency context in repair-plan scheduling (${repairTask.dependencyContext.length} issue(s)).`)
    }
  }

  return {
    mode,
    activePath,
    diverged: reasons.length > 0,
    divergenceScore: reasons.length,
    reasons,
    legacyPlan,
    repairPlan,
  }
}

export function deriveAcceptanceState(assessment: VerifierStepAssessment | undefined, prior: StepAcceptanceState | undefined): StepAcceptanceState {
  if (!assessment) return prior ?? "pending_verification"
  if (assessment.outcome === "pass") return "accepted"
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
    sourceArtifacts: [...(issue.sourceArtifacts ?? [])],
  }
}

export function buildChildRepairPayload(task: RepairTask): ChildRepairPayload {
  const unresolvedDependencyBlockers = task.mode === "blocked"
    ? task.dependencyContext.map((issue) => issue.summary)
    : []

  return {
    mode: task.mode === "repair" || task.mode === "reverify" || task.mode === "blocked" ? task.mode : "initial",
    goals: task.ownedIssues.map(buildRepairGoal),
    dependencyGoals: task.dependencyContext.map(buildRepairGoal),
    requiredAcceptedArtifacts: [...task.requiredAcceptedArtifacts],
    unresolvedDependencyBlockers,
    preserveArchitecture: task.preserveArchitecture,
    architectureSummary: task.architectureSummary,
    sharedContracts: task.sharedContracts,
    invariants: task.invariants,
  }
}

export function buildSystemChecks(decision: VerifierDecision): VerifierSystemCheck[] {
  const checks: VerifierSystemCheck[] = []
  const allIssues = decision.steps.flatMap((step) => step.issueDetails ?? [])

  const ambiguousIssues = allIssues.filter((issue) => issue.ownershipMode !== "deterministic_owner")
  if (ambiguousIssues.length > 0) {
    checks.push({
      code: "system_ownership_ambiguity",
      severity: ambiguousIssues.some((issue) => issue.severity === "fatal") ? "fatal" : "error",
      summary: `Multiple issues have ambiguous/shared ownership (${ambiguousIssues.length} issue(s)); repair convergence depends on coordination across suspected owners.`,
      confidence: Math.max(0.4, Math.min(0.9, ambiguousIssues.reduce((acc, issue) => acc + issue.confidence, 0) / ambiguousIssues.length)),
      affectedStepNames: uniqueStrings(ambiguousIssues.flatMap((issue) => issue.suspectedOwners)),
      affectedArtifacts: uniqueStrings(ambiguousIssues.flatMap((issue) => issue.affectedArtifacts)),
    })
  }

  const integrationArtifacts = allIssues.filter((issue) => issue.repairClass === "integration_wiring")
  if (integrationArtifacts.length > 1) {
    checks.push({
      code: "system_integration_drift",
      severity: "error",
      summary: `Cross-step integration invariants are failing across ${uniqueStrings(integrationArtifacts.flatMap((issue) => issue.affectedArtifacts)).length} artifact(s).`,
      confidence: 0.78,
      affectedStepNames: uniqueStrings(integrationArtifacts.flatMap((issue) => issue.suspectedOwners)),
      affectedArtifacts: uniqueStrings(integrationArtifacts.flatMap((issue) => issue.affectedArtifacts)),
    })
  }

  return checks
}
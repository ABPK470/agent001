import { compilePlannerRuntime } from "./runtime-model.js"
import type {
    ChildRepairGoal,
    ChildRepairPayload,
    PipelineResult,
    Plan,
    RepairPlan,
    RepairTask,
    StepAcceptanceState,
    SubagentTaskStep,
    VerificationEvidence,
    VerifierDecision,
    VerifierIssue,
    VerifierIssueSeverity,
    VerifierOwnershipMode,
    VerifierRepairClass,
    VerifierStepAssessment,
    VerifierSystemCheck,
} from "./types.js"

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "")
}

function extractPaths(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})/g) ?? []
  return uniqueStrings(matches.map(normalizePath))
}

function inferIssueCode(summary: string): string {
  const contractMatch = summary.match(/^\[contract:(\w+)\]/)
  if (contractMatch?.[1]) return `contract_${contractMatch[1]}`
  if (/Cross-file signature mismatch/i.test(summary)) return "cross_file_signature_mismatch"
  if (/Import\/export mismatch/i.test(summary)) return "import_export_mismatch"
  if (/Integration gap/i.test(summary)) return "integration_gap"
  if (/Browser module mismatch/i.test(summary)) return "browser_module_mismatch"
  if (/Style integration gap/i.test(summary)) return "style_integration_gap"
  if (/SPEC FUNCTION MISMATCH/i.test(summary)) return "spec_function_mismatch"
  if (/SPEC STRUCTURE MISMATCH/i.test(summary)) return "spec_structure_mismatch"
  if (/SPEC MAPPING MISSING/i.test(summary)) return "spec_mapping_missing"
  if (/PATH MISMATCH/i.test(summary)) return "path_mismatch"
  if (/SCOPE VIOLATION/i.test(summary)) return "scope_violation"
  if (/Browser check/i.test(summary)) return "browser_check_failure"
  if (/Syntax error|Syntax validation failed/i.test(summary)) return "syntax_failure"
  if (/Placeholder|stub/i.test(summary)) return "placeholder_logic"
  if (/VERIFICATION MODALITY GAP|CRITERIA PROOF MISSING/i.test(summary)) return "verification_gap"
  if (/FUNCTION LOSS/i.test(summary)) return "function_loss"
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "verification_issue"
}

function inferSeverity(summary: string): VerifierIssueSeverity {
  if (/FUNCTION LOSS|contradictory_completion_claim|unresolved_handoff_output|fatal/i.test(summary)) return "fatal"
  if (/fail|error|mismatch|missing|violation|corrupted|gibberish|syntax|rejected/i.test(summary)) return "error"
  return "warning"
}

function inferRepairClass(summary: string): VerifierRepairClass {
  if (/Cross-file signature mismatch|Import\/export mismatch|Integration gap|Browser module mismatch|Style integration gap/i.test(summary)) return "integration_wiring"
  if (/Browser check|runtime|Uncaught Exceptions|Console Errors|Network Failures/i.test(summary)) return "runtime_failure"
  if (/Syntax error|Syntax validation failed/i.test(summary)) return "syntax_failure"
  if (/Placeholder|stub|trivial return|returns constant/i.test(summary)) return "placeholder_logic"
  if (/PATH MISMATCH|SCOPE VIOLATION/i.test(summary)) return "path_scope"
  if (/SPEC FUNCTION MISMATCH|SPEC STRUCTURE MISMATCH|BLUEPRINT|contract/i.test(summary)) return "contract_drift"
  if (/Integration gap|module mismatch|wiring|load|stylesheet rules/i.test(summary)) return "integration_wiring"
  if (/VERIFICATION MODALITY GAP|CRITERIA PROOF MISSING/i.test(summary)) return "verification_gap"
  return "owner_implementation"
}

function inferIssueConfidence(source: VerificationEvidence["source"], summary: string, ownershipMode: VerifierOwnershipMode, suspectedOwners: readonly string[]): number {
  const sourceBase = source === "contract" ? 0.95 : source === "deterministic" ? 0.85 : 0.65
  const ambiguityPenalty = ownershipMode === "deterministic_owner" ? 0 : ownershipMode === "shared_owners" ? 0.12 : ownershipMode === "integration_layer" ? 0.18 : ownershipMode === "planner_fault" ? 0.15 : 0.22
  const ownerPenalty = suspectedOwners.length <= 1 ? 0 : Math.min(0.2, (suspectedOwners.length - 1) * 0.07)
  const wordingPenalty = /maybe|appears|likely|suggests|possible/i.test(summary) ? 0.08 : 0
  return Math.max(0.2, Math.min(0.99, sourceBase - ambiguityPenalty - ownerPenalty - wordingPenalty))
}

function buildEvidenceId(stepName: string, source: VerificationEvidence["source"], index: number, code: string): string {
  return `${stepName}:${source}:${index}:${code}`
}

function getSubagentStep(plan: Plan, stepName: string): SubagentTaskStep | undefined {
  const step = plan.steps.find((candidate) => candidate.name === stepName)
  return step?.stepType === "subagent_task" ? step as SubagentTaskStep : undefined
}

function inferAffectedArtifacts(step: SubagentTaskStep | undefined, summary: string): string[] {
  const extracted = extractPaths(summary)
  if (extracted.length > 0) return extracted
  return step?.executionContext.targetArtifacts.map(normalizePath) ?? []
}

function inferSourceArtifacts(step: SubagentTaskStep | undefined, summary: string): string[] {
  const extracted = extractPaths(summary)
  const targetSet = new Set(step?.executionContext.targetArtifacts.map(normalizePath) ?? [])
  const sourceArtifacts = extracted.filter((path) => !targetSet.has(path))
  if (sourceArtifacts.length > 0) return sourceArtifacts
  return step?.executionContext.requiredSourceArtifacts.map(normalizePath) ?? []
}

function deriveOwnershipAttribution(
  plan: Plan,
  source: VerificationEvidence["source"],
  assessmentStepName: string,
  affectedArtifacts: readonly string[],
  sourceArtifacts: readonly string[],
  summary: string,
): { ownerStepName: string; suspectedOwners: string[]; primaryOwner?: string; ownershipMode: VerifierOwnershipMode; confidence: number } {
  const runtime = compilePlannerRuntime(plan)
  const candidateArtifacts = uniqueStrings([...affectedArtifacts, ...sourceArtifacts].map(normalizePath))
  const candidateOwners = uniqueStrings(candidateArtifacts
    .map((artifact) => runtime.ownershipGraph.get(artifact)?.ownerStepName ?? undefined)
    .filter((owner): owner is string => Boolean(owner)))

  const mentionsPlanner = /blueprint|plan|planner/i.test(summary) && /drift|missing|mapping|coverage/i.test(summary)
  const isIntegration = /Cross-file signature mismatch|Import\/export mismatch|Integration gap|Browser module mismatch|Style integration gap/i.test(summary)

  let ownershipMode: VerifierOwnershipMode
  let suspectedOwners: string[]
  let primaryOwner: string | undefined

  if (mentionsPlanner) {
    ownershipMode = "planner_fault"
    suspectedOwners = uniqueStrings([assessmentStepName, ...candidateOwners])
    primaryOwner = candidateOwners[0] ?? assessmentStepName
  } else if (isIntegration && candidateOwners.length > 1) {
    ownershipMode = "integration_layer"
    suspectedOwners = candidateOwners
    primaryOwner = undefined
  } else if (candidateOwners.length > 1) {
    ownershipMode = "shared_owners"
    suspectedOwners = candidateOwners
    primaryOwner = candidateOwners[0]
  } else if (candidateOwners.length === 1) {
    ownershipMode = "deterministic_owner"
    suspectedOwners = candidateOwners
    primaryOwner = candidateOwners[0]
  } else {
    ownershipMode = isIntegration ? "integration_layer" : "ambiguous"
    suspectedOwners = [assessmentStepName]
    primaryOwner = assessmentStepName
  }

  const confidence = inferIssueConfidence(source, summary, ownershipMode, suspectedOwners)

  return {
    ownerStepName: primaryOwner ?? suspectedOwners[0] ?? assessmentStepName,
    suspectedOwners,
    primaryOwner,
    ownershipMode,
    confidence,
  }
}

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
    }
    taskMap.set(stepName, created)
    return created
  }

  for (const assessment of decision.steps) {
    if (assessment.outcome === "pass") continue
    const step = getSubagentStep(plan, assessment.stepName)
    const issueDetails = assessment.issueDetails ?? []
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const defaultRequiredAcceptedArtifacts = uniqueStrings([
      ...(step?.executionContext.requiredSourceArtifacts.map(normalizePath) ?? []),
      ...((runtime.stepAcceptedDependencies.get(assessment.stepName) ?? [])
        .flatMap((dependencyStepName) => pipelineResult.stepResults.get(dependencyStepName)?.producedArtifacts ?? [])),
    ])

    for (const issue of issueDetails) {
      const impactedSteps = uniqueStrings(issue.suspectedOwners.length > 0 ? issue.suspectedOwners : [assessment.stepName])
      const primaryOwner = issue.primaryOwner ?? issue.ownerStepName
      for (const impactedStep of impactedSteps) {
        const task = ensureTask(impactedStep)
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
          ...defaultRequiredAcceptedArtifacts,
        ])
        taskMap.set(impactedStep, {
          ...task,
          mode: !assessment.retryable
            ? "blocked"
            : (stepResult?.acceptanceState === "blocked" ? "blocked" : ownedIssues.length > 0 ? "repair" : "reverify"),
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
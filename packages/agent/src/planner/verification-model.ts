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
    VerifierRepairClass,
    VerifierStepAssessment,
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

function selectOwnerStepName(
  plan: Plan,
  assessmentStepName: string,
  affectedArtifacts: readonly string[],
  sourceArtifacts: readonly string[],
): string {
  const runtime = compilePlannerRuntime(plan)
  const candidateArtifacts = [...affectedArtifacts, ...sourceArtifacts]
  for (const artifact of candidateArtifacts) {
    const owner = runtime.ownershipGraph.get(normalizePath(artifact))?.ownerStepName
    if (owner) return owner
  }
  return assessmentStepName
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
      return {
        code: evidence.kind,
        severity: inferSeverity(evidence.message),
        retryable: assessment.retryable,
        ownerStepName: selectOwnerStepName(plan, assessment.stepName, affectedArtifacts, sourceArtifacts),
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
    ? assessment.issueDetails.map((issue) => `${issue.code}:${issue.severity}:${issue.affectedArtifacts.join(",")}`).sort()
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
  const tasks: RepairTask[] = []

  for (const assessment of decision.steps) {
    if (assessment.outcome === "pass") continue
    const step = getSubagentStep(plan, assessment.stepName)
    const issueDetails = assessment.issueDetails ?? []
    const ownedIssues = issueDetails.filter((issue) => issue.ownerStepName === assessment.stepName)
    const dependencyContext = issueDetails.filter((issue) => issue.ownerStepName !== assessment.stepName)
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const requiredAcceptedArtifacts = uniqueStrings([
      ...dependencyContext.flatMap((issue) => issue.sourceArtifacts ?? []),
      ...(step?.executionContext.requiredSourceArtifacts.map(normalizePath) ?? []),
      ...((runtime.stepAcceptedDependencies.get(assessment.stepName) ?? [])
        .flatMap((dependencyStepName) => pipelineResult.stepResults.get(dependencyStepName)?.producedArtifacts ?? [])),
    ])

    const mode: RepairTask["mode"] = !assessment.retryable
      ? "blocked"
      : ownedIssues.length === 0 && dependencyContext.length > 0
        ? "reverify"
        : (stepResult?.acceptanceState === "blocked" ? "blocked" : "repair")

    tasks.push({
      stepName: assessment.stepName,
      mode,
      ownedIssues,
      dependencyContext,
      requiredAcceptedArtifacts,
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
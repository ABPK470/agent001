/**
 * buildRepairStep — inject verifier feedback (primary issues, autonomous
 * repair guidance, stub remediation, blueprint instructions, and retry
 * rules) into a SubagentTaskStep before re-execution.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import {
    buildAutonomousRepairBlock,
    buildBlueprintRetryGuidance,
    getUnresolvedAcceptanceBlockers,
    summarizeRepairTask,
} from "../internal/pipeline-repair.js"
import { isGibberishIssue } from "../pipeline-validation/index.js"
import type { PipelineExecutorOptions } from "../pipeline/index.js"
import type {
    PipelineStepResult,
    Plan,
    PlannerRuntimeModel,
    RepairPlan,
    SubagentTaskStep,
} from "../types.js"
import { buildChildRepairPayload } from "../verification-model/index.js"

export function buildRepairStep(
  sa: SubagentTaskStep,
  name: string,
  repairTask: NonNullable<RepairPlan["tasks"][number]>,
  runtimeModel: PlannerRuntimeModel,
  acceptedArtifacts: ReadonlySet<string>,
  toolMap: Map<string, Tool>,
  plan: Plan,
  opts?: PipelineExecutorOptions,
): SubagentTaskStep {
  const typedFeedback = summarizeRepairTask(repairTask)
  const primaryFeedback = typedFeedback.primary.filter((issue) => !isGibberishIssue(issue))
  const referenceFeedback = typedFeedback.reference.filter((issue) => !isGibberishIssue(issue))
  const priorStep = opts?.priorResults?.get(name) as PipelineStepResult | undefined
  const priorReplaceMisses = (priorStep?.toolCalls ?? []).filter(
    c => c.name === "replace_in_file" && /old_string not found/i.test(c.result),
  ).length
  const avoidReplaceInFile = priorReplaceMisses >= 2

  const existingSource = new Set(sa.executionContext.requiredSourceArtifacts)
  for (const artifact of sa.executionContext.targetArtifacts) {
    existingSource.add(artifact)
  }

  const hasStubIssues = primaryFeedback.some(f =>
    /stub|placeholder|empty array|empty object|returns constant|catch-all|trivial return|degeneration/i.test(f),
  )
  const stubRemediationBlock = hasStubIssues
    ? `\n\n⚠️ STUB FUNCTION REMEDIATION — THIS IS YOUR PRIMARY TASK:\nThe verifier detected functions that are stubs or contain degeneration comments (e.g. "// Other code as per existing logic", "// rest of the code here", "// same as above"). These comments mean NO CODE WAS ACTUALLY WRITTEN — the function body is empty/incomplete.\nFor EACH stub/degenerated function you MUST:\n1. Read the file that contains it\n2. Locate the function by name\n3. Replace the stub body with a REAL, COMPLETE algorithm — DO NOT use comments like "existing logic" or "same as above"\n4. The function NAME tells you WHAT it must do — implement the FULL algorithm. Example: "getLegalMoves" must compute legal moves for ALL piece types with proper board bounds checking.\n5. Do NOT change the function signature — only replace the body\n6. After implementing, re-read the file and verify the stub is gone`
    : ""
  const autonomousRepairBlock = buildAutonomousRepairBlock(sa, primaryFeedback)
  const contextualFeedbackBlock = referenceFeedback.length > 0
    ? `\n\nReference context from verifier (do not treat these as your primary owned fixes unless you confirm they require integration work from your step):\n${referenceFeedback.map(f => `- ${f}`).join("\n")}`
    : ""

  const hasReplaceInFile = toolMap.has("replace_in_file")
  const docsOnlyTargets = sa.executionContext.targetArtifacts.length > 0 &&
    sa.executionContext.targetArtifacts.every((artifact) => /\.(?:md|markdown|txt|rst|adoc)$/i.test(artifact))
  const blueprintRetryGuidance = docsOnlyTargets || /blueprint/i.test(sa.name)
    ? `\n\n⚠️ BLUEPRINT/DOCUMENT RETRY GUIDANCE:\n- Do NOT mutate the document to add fake runtime-verification, test-plan, or execution-history sections.\n- Verification for this step is deterministic artifact inspection: write the document, then use read_file on the written artifact and confirm the required contracts are present.\n- Fix only the missing architectural depth: signatures, shared data, dependencies, algorithmic contracts, and edge cases.\n- Do NOT claim runtime behavior for a documentation-only step.${buildBlueprintRetryGuidance(sa, plan, primaryFeedback)}`
    : ""
  const retryRules = buildRetryRules(docsOnlyTargets, sa, hasReplaceInFile, avoidReplaceInFile)

  const unresolvedDependencyBlockers = getUnresolvedAcceptanceBlockers(name, runtimeModel, repairTask, acceptedArtifacts)
  return {
    ...sa,
    objective: `${sa.objective}\n\n[RETRY — fix these step-owned issues from the previous attempt]:\n${primaryFeedback.map(f => `- ${f}`).join("\n")}${contextualFeedbackBlock}${autonomousRepairBlock}${stubRemediationBlock}${blueprintRetryGuidance}\n\n${retryRules}`,
    executionContext: {
      ...sa.executionContext,
      requiredSourceArtifacts: [...existingSource],
      forbiddenArtifacts: [...new Set([...runtimeModel.ownershipGraph.values()]
        .filter((artifact) => artifact.ownerStepName && artifact.ownerStepName !== sa.name)
        .map((artifact) => artifact.artifactPath))],
      requiredChecks: [sa.executionContext.verificationMode, ...sa.acceptanceCriteria],
      upstreamAcceptedArtifacts: [...acceptedArtifacts],
      unresolvedDependencyBlockers,
      repairContext: buildChildRepairPayload(repairTask),
    },
  }
}

function buildRetryRules(
  docsOnlyTargets: boolean,
  sa: SubagentTaskStep,
  hasReplaceInFile: boolean,
  avoidReplaceInFile: boolean,
): string {
  if (docsOnlyTargets || /blueprint/i.test(sa.name)) {
    return hasReplaceInFile
      ? "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. If the target document already exists, read it first. If it does not exist yet, write the full document from the provided template.\n2. For blueprint/document repair, a full-file rewrite of the single target document is expected; do not force replace_in_file unless you are preserving an already-accepted document.\n3. After writing, immediately read the same document back and compare it against the required contract fields and exact artifact paths.\n4. Keep the content architectural/documentary only; do not add fake runtime verification, test-plan, or execution-history sections.\n5. Fix the listed contract gaps directly in the document before finishing."
      : "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. If the target document already exists, read it first. If it does not exist yet, write the full document from the provided template.\n2. replace_in_file is unavailable in this environment. Write the full document carefully and preserve any already-correct sections.\n3. After writing, immediately read the same document back and compare it against the required contract fields and exact artifact paths.\n4. Keep the content architectural/documentary only; do not add fake runtime verification, test-plan, or execution-history sections.\n5. Fix the listed contract gaps directly in the document before finishing."
  }
  if (hasReplaceInFile) {
    return avoidReplaceInFile
      ? "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. replace_in_file appears brittle in this step (repeated old_string misses). Use write_file with FULL-FILE preservation instead.\n3. Build from the latest file content: keep all existing working code and apply only the requested fixes.\n4. write_file REPLACES the entire file — never output partial fragments.\n5. Do not introduce placeholders, stubs, or narrative comments in code."
      : "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. Use replace_in_file for SURGICAL fixes to specific functions — this preserves all other code automatically.\n3. NEVER call write_file with a complete file rewrite. Your prior code is 90%+ correct. Find the specific broken part and fix ONLY that.\n4. write_file REPLACES the entire file — if you rewrite from scratch, you WILL lose working functions and create new bugs\n5. If you must use write_file, include ALL existing code plus your fix — do not drop any existing functions"
  }
  return "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. replace_in_file is unavailable in this environment. Use write_file carefully and preserve all existing code.\n3. write_file REPLACES the entire file — include the full current file plus your fix, never partial fragments.\n4. Make the smallest targeted correction needed for the listed issues.\n5. Do not introduce placeholders, stubs, or narrative comments in code."
}

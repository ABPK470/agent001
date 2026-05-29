import { VerifierOutcome } from "../../../domain/index.js"
/**
 * Verification-failure remediation helper. Extracted from planner-routing.ts.
 *
 * @module
 */

import { MessageRole } from "../../../domain/enums/message.js"
import * as log from "../../../internal/index.js"
import type { PlannerContext, PlannerResult, SubagentTaskStep } from "../planner.js"
import { executePlannerPath } from "../planner.js"
import type { PlannerRoutingContext } from "./index.js"

export async function handleVerificationFailure(
  ctx: PlannerRoutingContext,
  plannerResult: PlannerResult,
  plannerCtx: PlannerContext,
): Promise<string | undefined> {
  const { messages, config } = ctx
  const decision = plannerResult.verifierDecision!

  const unresolvedIssues = decision.steps
    .filter(s => s.outcome !== VerifierOutcome.Pass)
    .flatMap(s => s.issues.filter(i => !i.startsWith("[non-blocking]")))

  const planStepCount = plannerResult.plan?.steps.length ?? 0
  const uniqueTargetArtifacts = new Set(
    (plannerResult.plan?.steps ?? [])
      .flatMap((step) => step.stepType === "subagent_task"
        ? (step as SubagentTaskStep).executionContext.targetArtifacts
        : [])
      .map((a) => a.replace(/^\.\//, "")),
  )
  const isSmallSingleArtifactFallback =
    planStepCount <= 1 && decision.steps.length <= 1 && uniqueTargetArtifacts.size <= 1
  const isComplexPlannerRun = !isSmallSingleArtifactFallback

  if (isComplexPlannerRun) {
    const remediationContext =
      `Planner remediation context:\n` +
      `A previous structured execution failed verification. Generate a revised plan that fixes these exact issues without rewriting unrelated files:\n` +
      unresolvedIssues.map(i => `- ${i}`).join("\n")

    const remediationResult = await executePlannerPath(
      `${ctx.goal}\n\n${remediationContext}`,
      {
        ...plannerCtx,
        history: [
          ...messages,
          { role: MessageRole.System, content: remediationContext, section: "history" },
        ],
      },
      config.plannerDelegateFn!,
    )

    if (remediationResult.handled) {
      const answer = remediationResult.answer ?? "(planner remediation produced no answer)"
      if (config.verbose) log.logFinalAnswer(answer)
      return answer
    }

    return (
      remediationResult.answer
      ?? plannerResult.answer
      ?? "Planner verification failed after remediation attempts. Structured execution halted to avoid destructive rewrites."
    )
  }

  // Low-complexity fallback: inject repair context for direct loop
  if (unresolvedIssues.length > 0) {
    const hasReplaceInFile = ctx.toolList.some(t => t.name === "replace_in_file")
    const editInstruction = hasReplaceInFile
      ? "3. Use replace_in_file for surgical fixes — do NOT rewrite entire files"
      : "3. Use write_file only for minimal targeted updates; preserve all existing working code and avoid full-file rewrites"

    const repairMsg =
      `⚠️ AUTONOMOUS REPAIR REQUIRED — ACT IMMEDIATELY, DO NOT ASK PERMISSION.\n\n` +
      `A previous attempt partially completed this task but verification found issues that need fixing.\n` +
      `The files already exist on disk — do NOT rewrite from scratch. Read the existing files, identify the specific problems, and fix ONLY those.\n\n` +
      `Issues to fix:\n${unresolvedIssues.map(i => `- ${i}`).join("\n")}\n\n` +
      `Steps:\n1. read_file each file mentioned in the issues\n` +
      `2. Identify the specific stub/placeholder/missing logic\n` +
      `${editInstruction}\n` +
      `4. Verify your fix by re-reading the file\n\n` +
      `You MUST start fixing immediately. Do NOT respond with a question or ask the user for permission. You are fully authorized to read, modify, and fix these files right now.`
    messages.push({ role: MessageRole.User, content: repairMsg })
  }

  return undefined
}

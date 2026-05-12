/**
 * Blueprint-specific repair, retry guidance, and post-step validation.
 *
 * Extracted from reconcile.ts to keep reconcile focused on generic
 * post-execution contract reconciliation.
 *
 * @module
 */

import type { ToolCallRecord } from "../../recovery/index.js"
import { normalizeToolExecutionOutput } from "../../tool-helpers/index.js"
import type { Tool } from "../../types.js"
import {
    buildBlueprintSeedTemplate,
    getPlannedBlueprintArtifacts,
    validateBlueprintArtifactContract,
} from "../blueprint-contract.js"
import type { Plan, SubagentTaskStep } from "../types.js"
import type { SubagentStepValidationContext } from "./artifacts.js"
import { normalizeToolCallPath } from "./reconcile.js"

export interface SubagentValidationFailure {
  code?: import("../../delegation/validation.js").DelegationOutputValidationCode
  message: string
}

export function isBlueprintLikeStep(step: SubagentTaskStep): boolean {
  return /blueprint/i.test(step.name)
    || step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

export async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

export function buildBlueprintRetryGuidance(
  step: SubagentTaskStep,
  plan: Plan,
  feedback: readonly string[],
): string {
  if (!isBlueprintLikeStep(step)) return ""
  const blueprintPath = step.executionContext.targetArtifacts.find((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  if (!blueprintPath) return ""
  const plannedArtifacts = getPlannedBlueprintArtifacts(plan)
  const template = buildBlueprintSeedTemplate(blueprintPath, plannedArtifacts)
  const exactTargetList = plannedArtifacts.map((artifact, index) => `${index + 1}. ${artifact}`).join("\n")

  return [
    "",
    "⚠️ BLUEPRINT CONTRACT REPAIR — FOLLOW THESE INSTRUCTIONS EXACTLY:",
    `- Rewrite only \"${blueprintPath}\".`,
    "- REQUIRED machine-readable fence name: `blueprint-contract`.",
    "- REQUIRED exact planned artifact paths:",
    exactTargetList,
    "- REQUIRED top-level machine fields: `version`, `files`, and `sharedTypes`.",
    "- REQUIRED per-file machine fields: `path`, `purpose`, and `functions` (use [] when no exported functions exist).",
    "- Remove any invented file paths or substitute module names from the prior attempt.",
    "- After writing the file, immediately call read_file on the same BLUEPRINT.md and compare the read-back content against the exact path list above.",
    "- If the read-back file is missing the `blueprint-contract` fence, any path differs, or any required field is omitted, rewrite it and read it again before finishing.",
    ...(feedback.length > 0
      ? ["- Previous failure details:", ...feedback.map((item) => `  - ${item}`)]
      : []),
    "",
    "MANDATORY TEMPLATE TO FILL:",
    template,
  ].join("\n")
}

export function hasSuccessfulReadBackAfterWrite(
  calls: readonly ToolCallRecord[],
  targetPath: string,
): boolean {
  const normalizedTarget = normalizeToolCallPath(targetPath)
  const basename = normalizedTarget.split("/").pop() ?? normalizedTarget
  let lastWriteIndex = -1

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    if (call.isError) continue
    if (call.name !== "write_file" && call.name !== "replace_in_file") continue
    const callPath = normalizeToolCallPath(call.args.path)
    if (callPath === normalizedTarget || callPath === basename) {
      lastWriteIndex = index
    }
  }

  if (lastWriteIndex < 0) return false

  for (let index = lastWriteIndex + 1; index < calls.length; index += 1) {
    const call = calls[index]
    if (call.isError || call.name !== "read_file") continue
    const callPath = normalizeToolCallPath(call.args.path)
    if (callPath === normalizedTarget || callPath === basename) {
      return true
    }
  }

  return false
}

export async function validateBlueprintStepCompletion(
  step: SubagentTaskStep,
  calls: readonly ToolCallRecord[],
  validationCtx?: SubagentStepValidationContext,
): Promise<SubagentValidationFailure | null> {
  if (!isBlueprintLikeStep(step)) return null
  const blueprintPath = step.executionContext.targetArtifacts.find((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  const readFileTool = validationCtx?.readFileTool
  if (!blueprintPath || !readFileTool) return null

  if (!hasSuccessfulReadBackAfterWrite(calls, blueprintPath)) {
    return {
      code: "acceptance_evidence_missing",
      message:
        `BLUEPRINT SELF-CHECK MISSING: Step \"${step.name}\" must read back ${blueprintPath} after writing it and repair the same file until the \`blueprint-contract\` fence and exact planned targetArtifacts are present.`,
    }
  }

  const blueprintContent = await executeToolForText(readFileTool, { path: blueprintPath })
  if (/^Error:\s*(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|Path|Symlink|A parent directory)/i.test(blueprintContent)) {
    return {
      code: "acceptance_evidence_missing",
      message: `BLUEPRINT CONTRACT UNREADABLE: could not read ${blueprintPath} after generation (${blueprintContent})`,
    }
  }

  if (validationCtx) {
    const blueprintIssues = validateBlueprintArtifactContract(step, validationCtx.plan, blueprintPath, blueprintContent)
    if (blueprintIssues.length > 0) {
      return {
        code: "acceptance_evidence_missing",
        message: blueprintIssues.join("; "),
      }
    }
  }

  return null
}

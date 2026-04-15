/**
 * Pipeline validation — subagent completion checks, artifact quality gates,
 * syntax validation, and gibberish detection.
 *
 * Extracted from pipeline.ts for maintainability.
 *
 * @module
 */

import { detectInconsistentBranches, detectPlaceholderPatterns } from "../code-quality.js"
import {
    buildContractSpec,
    getCorrectionGuidance,
    specRequiresFileMutationEvidence,
    specRequiresSuccessfulToolEvidence,
    validateDelegatedOutputContract,
} from "../delegation-validation.js"
import type { ToolCallRecord } from "../recovery.js"
import type { Tool } from "../types.js"
import {
    type SubagentStepValidationContext,
    type SubagentValidationFailure,
    validateBlueprintStepCompletion
} from "./pipeline-repair.js"
import type {
    SubagentTaskStep
} from "./types.js"

// ============================================================================
// Tool call analysis
// ============================================================================

export function getMutatedArtifactPaths(calls: readonly ToolCallRecord[]): Set<string> {
  const paths = new Set<string>()
  for (const c of calls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (!path) continue
    paths.add(path)
    paths.add(path.replace(/^\.\//, ""))
    const base = path.split("/").pop()
    if (base) paths.add(base)
  }
  return paths
}

function isVerificationRunCommand(call: ToolCallRecord): boolean {
  if (call.name !== "run_command") return false
  const command = typeof call.args.command === "string" ? call.args.command.trim().toLowerCase() : ""
  if (!command) return false

  return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck|verify)\b/.test(command)
    || /(?:^|\s)(?:npx\s+)?(?:vitest|jest|tsc|pytest|ruff)\b/.test(command)
    || /(?:^|\s)node\s+--check\b/.test(command)
}

function findFailedVerificationToolCall(calls: readonly ToolCallRecord[]): ToolCallRecord | null {
  for (const call of calls) {
    const isVerificationCall = call.name === "browser_check" || isVerificationRunCommand(call)
    if (!isVerificationCall) continue

    if (call.isError) return call
    if (/Uncaught Exceptions|Console Errors|Network Failures|SyntaxError|Total:\s*[1-9]\d*\s+error|Error:/i.test(call.result)) {
      return call
    }
  }
  return null
}

// ============================================================================
// Subagent completion validation
// ============================================================================

export async function validateSubagentCompletion(
  step: SubagentTaskStep,
  output: string,
  toolCalls: readonly ToolCallRecord[] | undefined,
  validationCtx?: SubagentStepValidationContext,
): Promise<SubagentValidationFailure | null> {
  const calls = toolCalls ?? []

  const lastWriteByPath = new Map<string, ToolCallRecord>()
  for (const c of calls) {
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (path) lastWriteByPath.set(path, c)
  }
  const finalWriteWarning = [...lastWriteByPath.values()].find(c =>
    c.outcome?.severity === "fatal"
    || c.outcome?.errorCode === "artifact_incomplete_mutation"
    || /WRITE REJECTED|WRITTEN WITH ERRORS|WRITTEN WITH ISSUES|STUB\/PLACEHOLDER|CORRUPTED/i.test(c.result),
  )
  if (finalWriteWarning) {
    const path = typeof finalWriteWarning.args.path === "string" ? finalWriteWarning.args.path : "(unknown)"
    return {
      message:
        `Step "${step.name}" final write to "${path}" has integrity violations via ${finalWriteWarning.name}. ` +
        `The step is rejected until file writes are clean and free of placeholder/corruption warnings.`,
    }
  }

  const failedVerificationCall = findFailedVerificationToolCall(calls)
  if (failedVerificationCall) {
    return {
      code: "acceptance_evidence_missing",
      message:
        `Step "${step.name}" ran ${failedVerificationCall.name} but verification failed. ` +
        `The step cannot complete until the reported runtime/check errors are fixed. ` +
        `Last verification output: ${failedVerificationCall.result}`,
    }
  }

  const enrichedSpec = buildContractSpec(
    step,
    step.executionContext,
    undefined,
    validationCtx?.knownProjectArtifacts,
  )
  if (specRequiresSuccessfulToolEvidence(enrichedSpec) && calls.length === 0) {
    return {
      code: "missing_successful_tool_evidence",
      message:
        `Step "${step.name}" produced zero tool-call evidence. ` +
        `Completion is rejected until at least one successful tool execution is recorded.`,
    }
  }
  if (specRequiresFileMutationEvidence(enrichedSpec) && calls.length === 0) {
    return {
      code: "missing_file_mutation_evidence",
      message:
        `Step "${step.name}" requires file mutation evidence but recorded no tool calls. ` +
        `Completion is rejected until file creation/modification is proven.`,
    }
  }

  const contract = validateDelegatedOutputContract({
    spec: enrichedSpec,
    output,
    toolCalls: calls,
  })
  if (!contract.ok) {
    const guidance = contract.code ? getCorrectionGuidance(contract.code) : "Child output violated delegation contract."
    return {
      code: contract.code,
      message:
        `Step "${step.name}" violated delegation contract` +
        `${contract.code ? ` [${contract.code}]` : ""}: ${contract.message ?? "unknown contract failure"}. ` +
        `Required correction: ${guidance}`,
    }
  }

  const readFileTool = validationCtx?.readFileTool
  if (!readFileTool) return null

  const blueprintFailure = await validateBlueprintStepCompletion(step, calls, validationCtx)
  if (blueprintFailure) return blueprintFailure

  const codeTargets = step.executionContext.targetArtifacts.filter((a) => /\.(js|jsx|ts|tsx|py)$/i.test(a))
  const strictQualityScope =
    step.executionContext.verificationMode !== "none"
    || step.executionContext.role === "validator"
    || step.executionContext.role === "reviewer"

  const mutatedPaths = getMutatedArtifactPaths(calls)
  const qualityTargets = strictQualityScope
    ? codeTargets
    : codeTargets.filter((artifact) => {
        const normalized = artifact.replace(/^\.\//, "")
        const base = normalized.split("/").pop() ?? normalized
        return mutatedPaths.has(artifact) || mutatedPaths.has(normalized) || mutatedPaths.has(base)
      })

  for (const artifact of qualityTargets) {
    const content = await tryReadArtifact(readFileTool, artifact, validationCtx?.workspaceRoot)
    if (!content) {
      if (strictQualityScope) {
        return {
          code: "missing_target_artifact_coverage",
          message: `Step "${step.name}" did not produce readable target artifact: ${artifact}`,
        }
      }
      continue
    }

    const placeholders = detectPlaceholderPatterns(content)
    const branchInconsistencies = detectInconsistentBranches(content)
    const findings = [...placeholders, ...branchInconsistencies]
    if (findings.length > 0) {
      return {
        code: "acceptance_evidence_missing",
        message:
          `Step "${step.name}" produced non-executable or incomplete code in ${artifact}: ` +
          `${findings.slice(0, 5).join("; ")}`,
      }
    }
  }

  return null
}

// ============================================================================
// Artifact I/O helpers
// ============================================================================

/** Resolve an artifact path for file I/O, prepending workspace root if needed. */
export function resolveArtifactPath(artifact: string, wsRoot?: string): string {
  if (!wsRoot || artifact.startsWith("/") || artifact.startsWith(wsRoot)) return artifact
  return wsRoot.endsWith("/") ? `${wsRoot}${artifact}` : `${wsRoot}/${artifact}`
}

/** Try to read an artifact, attempting workspace-rooted path then bare path. */
export async function tryReadArtifact(readFileTool: Tool, artifact: string, wsRoot?: string): Promise<string | null> {
  if (wsRoot) {
    const wsPath = resolveArtifactPath(artifact, wsRoot)
    try {
      const content = await readFileTool.execute({ path: wsPath })
      if (typeof content === "string" && !content.startsWith("Error:")) return content
    } catch { /* fall through */ }
  }
  try {
    const content = await readFileTool.execute({ path: artifact })
    if (typeof content === "string" && !content.startsWith("Error:")) return content
  } catch { /* fall through */ }
  return null
}

// ============================================================================
// Post-step syntax validation
// ============================================================================

export async function runPostStepSyntaxValidation(
  step: SubagentTaskStep,
  toolCalls: readonly ToolCallRecord[],
  validationCtx?: SubagentStepValidationContext,
): Promise<string[]> {
  const errors: string[] = []
  const wsRoot = validationCtx?.workspaceRoot

  const jsTargets = step.executionContext.targetArtifacts.filter(a => /\.js$/i.test(a))
  const mutatedJsPaths = new Set<string>()

  for (const c of toolCalls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (/\.js$/i.test(path)) mutatedJsPaths.add(path)
  }

  const pathsToCheck = new Set<string>([...jsTargets, ...mutatedJsPaths])
  if (pathsToCheck.size === 0) return errors

  const { execSync } = await import("node:child_process")

  for (const artifact of pathsToCheck) {
    let checkPath = artifact
    if (wsRoot && !checkPath.startsWith("/")) {
      checkPath = wsRoot.endsWith("/") ? `${wsRoot}${checkPath}` : `${wsRoot}/${checkPath}`
    }

    try {
      const { accessSync } = await import("node:fs")
      accessSync(checkPath)

      execSync(`node --check ${JSON.stringify(checkPath)}`, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err)
      if (/SyntaxError|Unexpected token|Unexpected identifier/i.test(errMsg)) {
        const errorLines = errMsg.trim().split("\n").slice(0, 5).join(" | ")
        errors.push(`Syntax error in "${artifact}": ${errorLines}`)
      }
    }
  }

  return errors
}

// ============================================================================
// Gibberish detection
// ============================================================================

export function isGibberishIssue(issue: string): boolean {
  const words = issue.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 8) return false

  const tripleCompound = (issue.match(/[a-z]+-[a-z]+-[a-z]+/gi) ?? []).length
  if (tripleCompound >= 3) return true

  const doubleCompound = (issue.match(/[a-z]{3,}-[a-z]{3,}/gi) ?? []).length

  const functionWords = (issue.match(/\b(the|is|a|an|and|to|of|in|for|with|that|was|it|this|are|not|but|be|has|have|can|does|should|must)\b/gi) ?? []).length
  const ratio = functionWords / words.length
  if (ratio < 0.04 && words.length >= 15) return true

  const hasCodeRefs = /[/\\]|\.(?:js|ts|html|css|py)\b|`[^`]+`|\bfunction\b|\bclass\b|\bconst\b|\bread_file\b|\bwrite_file\b|\breplace_in_file\b/i.test(issue)
  if (!hasCodeRefs && doubleCompound >= 4 && ratio < 0.08) return true

  return false
}

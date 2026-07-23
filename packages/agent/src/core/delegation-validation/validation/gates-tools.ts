/**
 * Gates 4-7: tool-evidence checks.
 *   - successful-tool / all-tools-failed
 *   - file mutation evidence (write/replace/append OR shell write)
 *   - workspace inspection evidence
 *   - required-source-artifact reads
 *
 * @module
 */

import { DelegationOutputValidationCode } from "../../../domain/enums/delegation.js"
import {
  isFileMutationToolCall,
  isWorkspaceInspectionToolCall,
  NARRATIVE_FILE_CLAIM_RE,
  specRequiresFileMutationEvidence,
  specRequiresSuccessfulToolEvidence,
  specRequiresWorkspaceInspection
} from "../validation-patterns/index.js"
import {
  FILE_READ_TOOLS,
  SHELL_FILE_WRITE_RE,
  SHELL_IN_PLACE_EDIT_RE,
  SHELL_SCAFFOLD_RE,
  type DelegationOutputValidationResult,
  type GateParams
} from "./types.js"

export function gateSuccessfulTool(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, outputLower, toolCalls } = p

  if (specRequiresSuccessfulToolEvidence(spec) && toolCalls.length > 0) {
    const successfulCalls = toolCalls.filter((tc) => !tc.isError)
    if (successfulCalls.length === 0) {
      return {
        ok: false,
        code: DelegationOutputValidationCode.AllToolsFailed,
        message: `All ${toolCalls.length} tool calls failed — zero successful executions`
      }
    }
  }

  if (specRequiresSuccessfulToolEvidence(spec) && toolCalls.length === 0) {
    if (NARRATIVE_FILE_CLAIM_RE.test(outputLower)) {
      return {
        ok: false,
        code: DelegationOutputValidationCode.MissingSuccessfulToolEvidence,
        message: "Child claims to have created/modified files but made zero tool calls"
      }
    }
  }
  return null
}

export function gateFileMutation(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, toolCalls } = p
  if (!specRequiresFileMutationEvidence(spec)) return null

  const hasMutation = toolCalls.some((tc) => isFileMutationToolCall(tc) && !tc.isError)
  if (hasMutation || toolCalls.length === 0) return null

  const hasShellMutation = toolCalls.some((tc) => {
    if (tc.name !== "run_command") return false
    const cmd = typeof tc.args.command === "string" ? tc.args.command : ""
    return (
      (SHELL_FILE_WRITE_RE.test(cmd) || SHELL_IN_PLACE_EDIT_RE.test(cmd) || SHELL_SCAFFOLD_RE.test(cmd)) &&
      !tc.isError
    )
  })
  if (hasShellMutation) return null

  return {
    ok: false,
    code: DelegationOutputValidationCode.MissingFileMutationEvidence,
    message: `Contract requires file creation/modification (${spec.targetArtifacts.length} target artifacts) but no file mutation tools were used successfully`
  }
}

export function gateWorkspaceInspection(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, toolCalls } = p
  if (!specRequiresWorkspaceInspection(spec) || toolCalls.length === 0) return null
  const hasInspection = toolCalls.some((tc) => isWorkspaceInspectionToolCall(tc) && !tc.isError)
  if (hasInspection) return null
  return {
    ok: false,
    code: DelegationOutputValidationCode.MissingWorkspaceInspectionEvidence,
    message:
      "Contract requires workspace inspection (source files listed or reviewer role) but no read/inspection tools were used"
  }
}

export function gateRequiredSourceEvidence(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, toolCalls } = p
  if (spec.requiredSourceArtifacts.length === 0 || toolCalls.length === 0) return null

  const readPaths = new Set<string>()
  for (const tc of toolCalls) {
    if (FILE_READ_TOOLS.has(tc.name) && !tc.isError) {
      const path = typeof tc.args.path === "string" ? tc.args.path : ""
      if (path) readPaths.add(path)
    }
  }
  const readCount = spec.requiredSourceArtifacts.filter((src) => {
    const srcBasename = src.split("/").pop() ?? src
    return [...readPaths].some((rp) => rp === src || rp.endsWith(`/${srcBasename}`))
  }).length

  if (readCount === 0) {
    return {
      ok: false,
      code: DelegationOutputValidationCode.MissingRequiredSourceEvidence,
      message: `Child was required to read ${spec.requiredSourceArtifacts.length} source files but read none: ${spec.requiredSourceArtifacts.slice(0, 3).join(", ")}`
    }
  }
  return null
}

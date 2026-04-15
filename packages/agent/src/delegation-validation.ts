/**
 * Delegation output contract validation — structured evidence-based checks.
 *
 * Deterministic, code-level validation of child agent outputs BEFORE the LLM
 * verifier runs. Cross-references tool calls, file paths, acceptance criteria,
 * and completion claims.
 *
 * Pattern/evidence helpers are in delegation-validation-patterns.ts.
 * Correction guidance is in delegation-validation-correction.ts.
 *
 * @module
 */

import {
  BLOCKED_PHASE_RE,
  BROWSER_RUNTIME_FAILURE_RE,
  classifyTaskIntent,
  COMPLETION_CLAIM_RE,
  CONTEXT_SENSITIVE_MARKERS,
  EMPTY_VALUES,
  extractAcceptanceTokens,
  extractLocalArtifactReferences,
  FILE_ARTIFACT_RE,
  getToolCallPathArg,
  hasMutationPathEvidence,
  hasPostMutationArtifactInspection,
  isExecutableVerificationToolCall,
  isFileMutationToolCall,
  isLowSignalBrowserToolCall,
  isWorkspaceInspectionToolCall,
  MEANINGFUL_BROWSER_TOOLS,
  NARRATIVE_FILE_CLAIM_RE,
  normalizeArtifactPath,
  specRequiresBrowserEvidence,
  specRequiresFileMutationEvidence,
  specRequiresSuccessfulToolEvidence,
  specRequiresWorkspaceInspection,
  UNRESOLVED_HANDOFF_RE,
  UNRESOLVED_WORK_RE
} from "./delegation-validation-patterns.js"
import type { ToolCallRecord } from "./tool-result.js"

// Re-export everything from sub-modules for backwards compatibility
export { getCorrectionGuidance } from "./delegation-validation-correction.js"
export {
  classifyTaskIntent,
  extractAcceptanceTokens,
  isFileMutationToolCall,
  isLowSignalBrowserToolCall,
  isWorkspaceInspectionToolCall,
  specRequiresBrowserEvidence,
  specRequiresFileMutationEvidence,
  specRequiresSuccessfulToolEvidence,
  specRequiresWorkspaceInspection,
  type TaskIntent
} from "./delegation-validation-patterns.js"
export type { ToolCallRecord } from "./tool-result.js"

// Re-export from tool-result for backwards compatibility
export { buildSemanticToolCallKey, didToolCallFail, extractToolFailureText, parseToolResultObject } from "./tool-result.js"

// Re-export from quality-proxy for backwards compatibility
export { computeQualityProxy } from "./quality-proxy.js"
export type { QualityProxyInput } from "./quality-proxy.js"

// ============================================================================
// Validation codes — the contract enforcement taxonomy
// ============================================================================

export const DELEGATION_OUTPUT_VALIDATION_CODES = [
  "empty_output",
  "empty_structured_payload",
  "acceptance_evidence_missing",
  "contradictory_completion_claim",
  "missing_file_mutation_evidence",
  "missing_successful_tool_evidence",
  "blocked_phase_output",
  "missing_file_artifact_evidence",
  "missing_workspace_inspection_evidence",
  "missing_required_source_evidence",
  "all_tools_failed",
  "low_signal_browser_evidence",
  "missing_executable_verification_evidence",
  "unresolved_handoff_output",
  "missing_target_artifact_coverage",
  "unresolved_artifact_references",
] as const

export type DelegationOutputValidationCode =
  typeof DELEGATION_OUTPUT_VALIDATION_CODES[number]

// ============================================================================
// Core interfaces
// ============================================================================

export interface DelegationContractSpec {
  readonly task: string
  readonly acceptanceCriteria: readonly string[]
  readonly targetArtifacts: readonly string[]
  readonly requiredSourceArtifacts: readonly string[]
  readonly tools: readonly string[]
  readonly effectClass: "readonly" | "filesystem_write" | "filesystem_scaffold" | "shell" | "mixed"
  readonly verificationMode: string
  readonly role: "writer" | "reviewer" | "validator" | "grounding"
  readonly lastValidationCode?: DelegationOutputValidationCode
  readonly knownProjectArtifacts?: readonly string[]
}

export interface DelegationOutputValidationResult {
  readonly ok: boolean
  readonly code?: DelegationOutputValidationCode
  readonly message?: string
}

// ============================================================================
// File-tool sets (used only by validateDelegatedOutputContract)
// ============================================================================

const FILE_READ_TOOLS = new Set([
  "read_file", "list_directory", "search_files",
])

const SHELL_FILE_WRITE_RE =
  /\b(?:tee|touch|cp|mv|install)\b|\bcat\b[^\n]*\s(?:>|>>|<<)\s*\S|(?:^|[^>])>{1,2}\s*\S/i
const SHELL_IN_PLACE_EDIT_RE =
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i
const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone)\b/i

const LOW_SIGNAL_BROWSER_TOOLS = new Set<string>([
  // Reserved for future browser sub-tools
])

// ============================================================================
// Master validation function
// ============================================================================

export function validateDelegatedOutputContract(params: {
  spec: DelegationContractSpec
  output: string
  toolCalls?: readonly ToolCallRecord[]
}): DelegationOutputValidationResult {
  const { spec, output, toolCalls = [] } = params
  const trimmed = output.trim()
  const outputLower = trimmed.toLowerCase()

  // ── 1. Empty output ──
  if (trimmed.length === 0) {
    return { ok: false, code: "empty_output", message: "Child agent produced no output" }
  }
  if (EMPTY_VALUES.has(trimmed)) {
    return { ok: false, code: "empty_structured_payload", message: `Child output is empty value: ${trimmed}` }
  }

  // ── 2. Blocked phase output ──
  if (BLOCKED_PHASE_RE.test(outputLower) && !COMPLETION_CLAIM_RE.test(outputLower)) {
    const blockMatchCount = [...outputLower.matchAll(new RegExp(BLOCKED_PHASE_RE.source, "gi"))].length
    const lines = trimmed.split("\n").length
    if (blockMatchCount >= 2 && lines < 10) {
      const firstMatch = outputLower.match(BLOCKED_PHASE_RE)
      return {
        ok: false,
        code: "blocked_phase_output",
        message: `Child agent reported blocked/incomplete state: "${firstMatch?.[0]}"`,
      }
    }
  }

  // ── 3. Unresolved handoff / partial output ──
  const intent = classifyTaskIntent(spec)
  const isImplementationLike = intent === "implementation" || intent === "mixed"
  if (isImplementationLike && specRequiresFileMutationEvidence(spec) && UNRESOLVED_HANDOFF_RE.test(trimmed)) {
    const handoffMatch = trimmed.match(UNRESOLVED_HANDOFF_RE)
    return {
      ok: false,
      code: "unresolved_handoff_output",
      message: `Output contains unresolved handoff/partial language: "${handoffMatch?.[0]}"`,
    }
  }

  // ── 4. Successful tool evidence ──
  if (specRequiresSuccessfulToolEvidence(spec) && toolCalls.length > 0) {
    const successfulCalls = toolCalls.filter(tc => !tc.isError)
    if (successfulCalls.length === 0) {
      return {
        ok: false,
        code: "all_tools_failed",
        message: `All ${toolCalls.length} tool calls failed — zero successful executions`,
      }
    }
  }

  if (specRequiresSuccessfulToolEvidence(spec) && toolCalls.length === 0) {
    if (NARRATIVE_FILE_CLAIM_RE.test(outputLower)) {
      return {
        ok: false,
        code: "missing_successful_tool_evidence",
        message: "Child claims to have created/modified files but made zero tool calls",
      }
    }
  }

  // ── 5. File mutation evidence ──
  if (specRequiresFileMutationEvidence(spec)) {
    const hasMutation = toolCalls.some(tc => isFileMutationToolCall(tc) && !tc.isError)
    if (!hasMutation && toolCalls.length > 0) {
      const hasShellMutation = toolCalls.some(tc => {
        if (tc.name !== "run_command") return false
        const cmd = typeof tc.args.command === "string" ? tc.args.command : ""
        return (SHELL_FILE_WRITE_RE.test(cmd) || SHELL_IN_PLACE_EDIT_RE.test(cmd) || SHELL_SCAFFOLD_RE.test(cmd)) && !tc.isError
      })
      if (!hasShellMutation) {
        return {
          ok: false,
          code: "missing_file_mutation_evidence",
          message: `Contract requires file creation/modification (${spec.targetArtifacts.length} target artifacts) but no file mutation tools were used successfully`,
        }
      }
    }
  }

  // ── 6. Workspace inspection evidence ──
  if (specRequiresWorkspaceInspection(spec) && toolCalls.length > 0) {
    const hasInspection = toolCalls.some(tc => isWorkspaceInspectionToolCall(tc) && !tc.isError)
    if (!hasInspection) {
      return {
        ok: false,
        code: "missing_workspace_inspection_evidence",
        message: "Contract requires workspace inspection (source files listed or reviewer role) but no read/inspection tools were used",
      }
    }
  }

  // ── 7. Required source artifact evidence ──
  if (spec.requiredSourceArtifacts.length > 0 && toolCalls.length > 0) {
    const readPaths = new Set<string>()
    for (const tc of toolCalls) {
      if (FILE_READ_TOOLS.has(tc.name) && !tc.isError) {
        const path = typeof tc.args.path === "string" ? tc.args.path : ""
        if (path) readPaths.add(path)
      }
    }
    const readCount = spec.requiredSourceArtifacts.filter(src => {
      const srcBasename = src.split("/").pop() ?? src
      return [...readPaths].some(rp => rp === src || rp.endsWith(`/${srcBasename}`))
    }).length
    if (readCount === 0 && spec.requiredSourceArtifacts.length > 0) {
      return {
        ok: false,
        code: "missing_required_source_evidence",
        message: `Child was required to read ${spec.requiredSourceArtifacts.length} source files but read none: ${spec.requiredSourceArtifacts.slice(0, 3).join(", ")}`,
      }
    }
  }

  // ── 8. File artifact evidence in output ──
  if (specRequiresFileMutationEvidence(spec) && toolCalls.some(tc => isFileMutationToolCall(tc) && !tc.isError)) {
    const successfulMutations = toolCalls.filter(tc => isFileMutationToolCall(tc) && !tc.isError)
    const hasToolPathEvidence = successfulMutations.some(hasMutationPathEvidence)
    if (!FILE_ARTIFACT_RE.test(trimmed) && !hasToolPathEvidence) {
      return {
        ok: false,
        code: "missing_file_artifact_evidence",
        message: "File mutation tools were used but no artifact path evidence was found in output or tool results",
      }
    }
  }

  // ── 8b. Target artifact coverage + reference integrity ──
  if (isImplementationLike && spec.targetArtifacts.length > 0) {
    const successfulMutations = toolCalls.filter(tc => isFileMutationToolCall(tc) && !tc.isError)
    const mutatedPaths = new Set<string>()
    const unresolvedReferences = new Set<string>()
    let hasUnknownMutationPath = false

    for (const tc of successfulMutations) {
      const pathArg = getToolCallPathArg(tc)
      if (pathArg) {
        mutatedPaths.add(normalizeArtifactPath(pathArg))
      } else {
        hasUnknownMutationPath = true
      }
    }

    const normalizedTargets = spec.targetArtifacts.map(normalizeArtifactPath)
    const touchedTargets = normalizedTargets.filter(target => {
      const targetBase = target.split("/").pop() ?? target
      return [...mutatedPaths].some(mp => mp === target || mp.endsWith(`/${targetBase}`))
    })

    if (successfulMutations.length > 0 && touchedTargets.length === 0 && !hasUnknownMutationPath) {
      return {
        ok: false,
        code: "missing_target_artifact_coverage",
        message: `Mutation tools ran, but none of the declared target artifacts were touched: ${spec.targetArtifacts.slice(0, 3).join(", ")}`,
      }
    }

    const knownArtifacts = new Set<string>([
      ...normalizedTargets,
      ...spec.requiredSourceArtifacts.map(normalizeArtifactPath),
      ...(spec.knownProjectArtifacts ?? []).map(normalizeArtifactPath),
      ...[...mutatedPaths],
    ])

    for (const tc of successfulMutations) {
      const pathArg = getToolCallPathArg(tc)
      const content = typeof tc.args.content === "string" ? tc.args.content : ""
      if (!pathArg || content.length === 0) continue

      const baseDir = normalizeArtifactPath(pathArg).split("/").slice(0, -1).join("/")
      const refs = extractLocalArtifactReferences(content)
      for (const ref of refs) {
        const normalizedRef = normalizeArtifactPath(ref)
        const resolved = normalizedRef.startsWith("../") || normalizedRef.startsWith("./")
          ? normalizeArtifactPath(`${baseDir}/${normalizedRef}`)
          : normalizedRef
        const refBase = resolved.split("/").pop() ?? resolved
        const isKnown = [...knownArtifacts].some(k => k === resolved || k.endsWith(`/${refBase}`))
        if (!isKnown) {
          unresolvedReferences.add(ref)
        }
      }
    }

    const shouldEnforceReferenceIntegrity =
      spec.verificationMode !== "none" || spec.role !== "writer"

    if (unresolvedReferences.size > 0 && shouldEnforceReferenceIntegrity) {
      const sample = [...unresolvedReferences].slice(0, 4).join(", ")
      return {
        ok: false,
        code: "unresolved_artifact_references",
        message: `Created/edited content references local artifacts without evidence they exist: ${sample}`,
      }
    }
  }

  // ── 9. Browser evidence quality ──
  if (specRequiresBrowserEvidence(spec) && toolCalls.length > 0) {
    const browserCalls = toolCalls.filter(tc =>
      MEANINGFUL_BROWSER_TOOLS.has(tc.name) || LOW_SIGNAL_BROWSER_TOOLS.has(tc.name),
    )
    if (browserCalls.length > 0) {
      const hasFailedMeaningfulBrowserEvidence = browserCalls.some((tc) =>
        MEANINGFUL_BROWSER_TOOLS.has(tc.name) && (tc.isError || BROWSER_RUNTIME_FAILURE_RE.test(tc.result)),
      )
      if (hasFailedMeaningfulBrowserEvidence) {
        return {
          ok: false,
          code: "missing_executable_verification_evidence",
          message: "browser_check evidence contains runtime/load errors — fix those errors before claiming completion",
        }
      }

      const allLowSignal = browserCalls.every(tc => isLowSignalBrowserToolCall(tc))
      if (allLowSignal) {
        return {
          ok: false,
          code: "low_signal_browser_evidence",
          message: "Browser tools were used but only low-signal actions (about:blank, tab listing) — no meaningful browser evidence",
        }
      }
    }
  }

  // ── 11. Contradictory completion claim ──
  if (COMPLETION_CLAIM_RE.test(outputLower)) {
    if (UNRESOLVED_WORK_RE.test(trimmed)) {
      const unresolvedMatch = trimmed.match(UNRESOLVED_WORK_RE)
      return {
        ok: false,
        code: "contradictory_completion_claim",
        message: `Child claims completion but output contains unresolved work: "${unresolvedMatch?.[0]}"`,
      }
    }
    for (const { re, label } of CONTEXT_SENSITIVE_MARKERS) {
      if (re.test(trimmed)) {
        return {
          ok: false,
          code: "contradictory_completion_claim",
          message: `Child claims completion but output contains unresolved work: "${label}"`,
        }
      }
    }
  }

  // ── 12. Executable verification evidence (implementation tasks) ──
  if (isImplementationLike && specRequiresFileMutationEvidence(spec) && toolCalls.length > 0) {
    const hasVerificationCall = toolCalls.some(tc => !tc.isError && isExecutableVerificationToolCall(tc))
    const hasPostWriteInspection = hasPostMutationArtifactInspection(toolCalls, spec.targetArtifacts)
    if (!hasVerificationCall && !hasPostWriteInspection) {
      return {
        ok: false,
        code: "missing_executable_verification_evidence",
        message: "Implementation output lacks executable verification evidence (runtime/test check or post-write artifact inspection)",
      }
    }
  }

  // ── 13. Acceptance criteria evidence ──
  if (spec.acceptanceCriteria.length > 0) {
    if (isImplementationLike) {
      return { ok: true }
    }
    const tokens = extractAcceptanceTokens(spec.acceptanceCriteria)
    if (tokens.length > 0) {
      const matchedTokens = tokens.filter(t => outputLower.includes(t))
      const coverageRatio = matchedTokens.length / tokens.length
      if (coverageRatio < 0.1 && tokens.length >= 3) {
        return {
          ok: false,
          code: "acceptance_evidence_missing",
          message: `Only ${matchedTokens.length}/${tokens.length} acceptance criteria tokens found in output (coverage: ${(coverageRatio * 100).toFixed(0)}%)`,
        }
      }
    }
  }

  return { ok: true }
}

// ============================================================================
// Convenience: build spec from SubagentTaskStep + ExecutionEnvelope
// ============================================================================

export function buildContractSpec(
  step: { objective: string; acceptanceCriteria: readonly string[]; requiredToolCapabilities: readonly string[] },
  envelope: { targetArtifacts: readonly string[]; requiredSourceArtifacts: readonly string[]; allowedTools: readonly string[]; effectClass: string; verificationMode: string; role?: string },
  lastValidationCode?: DelegationOutputValidationCode,
  knownProjectArtifacts?: readonly string[],
): DelegationContractSpec {
  return {
    task: step.objective,
    acceptanceCriteria: step.acceptanceCriteria,
    targetArtifacts: envelope.targetArtifacts,
    requiredSourceArtifacts: envelope.requiredSourceArtifacts,
    tools: [
      ...envelope.allowedTools,
      ...step.requiredToolCapabilities,
    ],
    effectClass: envelope.effectClass as DelegationContractSpec["effectClass"],
    verificationMode: envelope.verificationMode,
    role: (envelope.role ?? "writer") as DelegationContractSpec["role"],
    lastValidationCode,
    knownProjectArtifacts,
  }
}

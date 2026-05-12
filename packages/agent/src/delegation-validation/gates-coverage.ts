/**
 * Gates 8 + 8b: file-artifact evidence + target-artifact coverage
 * + reference integrity, and gate 9: browser-evidence quality.
 *
 * @module
 */

import {
    BROWSER_RUNTIME_FAILURE_RE,
    classifyTaskIntent,
    extractLocalArtifactReferences,
    FILE_ARTIFACT_RE,
    getToolCallPathArg,
    hasMutationPathEvidence,
    isFileMutationToolCall,
    isLowSignalBrowserToolCall,
    MEANINGFUL_BROWSER_TOOLS,
    normalizeArtifactPath,
    specRequiresBrowserEvidence,
    specRequiresFileMutationEvidence,
} from "../delegation-validation-patterns.js"
import {
    LOW_SIGNAL_BROWSER_TOOLS,
    type DelegationOutputValidationResult,
    type GateParams,
} from "./types.js"

export function gateFileArtifactEvidence(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, trimmed, toolCalls } = p
  if (!specRequiresFileMutationEvidence(spec)) return null
  const successfulMutations = toolCalls.filter(tc => isFileMutationToolCall(tc) && !tc.isError)
  if (successfulMutations.length === 0) return null

  const hasToolPathEvidence = successfulMutations.some(hasMutationPathEvidence)
  if (FILE_ARTIFACT_RE.test(trimmed) || hasToolPathEvidence) return null

  return {
    ok: false,
    code: "missing_file_artifact_evidence",
    message: "File mutation tools were used but no artifact path evidence was found in output or tool results",
  }
}

export function gateTargetCoverage(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, toolCalls } = p
  const intent = classifyTaskIntent(spec)
  const isImplementationLike = intent === "implementation" || intent === "mixed"
  if (!isImplementationLike || spec.targetArtifacts.length === 0) return null

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

  // Reference integrity: scan content for local artifact references whose targets
  // can't be resolved against any known artifact path.
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
      if (!isKnown) unresolvedReferences.add(ref)
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
  return null
}

export function gateBrowserEvidence(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, toolCalls } = p
  if (!specRequiresBrowserEvidence(spec) || toolCalls.length === 0) return null

  const browserCalls = toolCalls.filter(tc =>
    MEANINGFUL_BROWSER_TOOLS.has(tc.name) || LOW_SIGNAL_BROWSER_TOOLS.has(tc.name),
  )
  if (browserCalls.length === 0) return null

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
  return null
}

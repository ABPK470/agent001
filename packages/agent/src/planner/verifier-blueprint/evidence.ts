/**
 * Blueprint evidence helpers, contract issue builders, and main step spec evidence entry point.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import {
    normalizeBasename,
    normalizeSpecPath,
    uniqueStrings,
} from "../blueprint-contract.js"
import type { PipelineStepResult, Plan, SubagentTaskStep } from "../types.js"
import { escapeRegExp } from "../verifier-helpers.js"
import {
    type ArtifactSpecMapping,
    type BlueprintFunctionSpec,
    type StepSpecEvidence,
    collectSpecAuditIssues,
    detectStructuralMarkersInArtifact,
    parseBlueprintSpec,
} from "./core.js"
import {
    buildBlueprintArtifactCoverageIssues,
    buildBlueprintFunctionContractIssues,
    buildBlueprintSharedTypeContractIssues,
    isBlueprintLikeStepForVerifier,
} from "./contract-issues.js"

export {
    buildBlueprintArtifactCoverageIssues,
    collectPlannedBlueprintArtifacts,
    isBlueprintLikeStepForVerifier,
} from "./contract-issues.js"

// ============================================================================
// Blueprint evidence helpers
// ============================================================================

function collectSourceReadEvidence(stepResult: PipelineStepResult, blueprintPath: string): string[] {
  const reads = (stepResult.toolCalls ?? [])
    .filter(call => call.name === "read_file" || call.name === "search_files")
    .map(call => {
      const pathArg = typeof call.args.path === "string"
        ? call.args.path
        : typeof call.args.pattern === "string"
          ? call.args.pattern
          : null
      return pathArg ? normalizeSpecPath(pathArg) : null
    })
    .filter((value): value is string => Boolean(value))

  const normalizedBlueprint = normalizeSpecPath(blueprintPath)
  return uniqueStrings(reads.filter(read => read.includes("BLUEPRINT.md") || read === normalizedBlueprint))
}

export function findBlueprintForStep(step: SubagentTaskStep): string | null {
  return step.executionContext.requiredSourceArtifacts.find(
    (artifact: string) => /(^|\/)BLUEPRINT\.md$/iu.test(artifact),
  )
    ?? step.executionContext.targetArtifacts.find(
      (artifact: string) => /(^|\/)BLUEPRINT\.md$/iu.test(artifact),
    )
    ?? null
}

function detectFunctionsInArtifact(
  content: string,
  functions: readonly BlueprintFunctionSpec[],
): { found: string[]; missing: string[] } {
  const found: string[] = []
  const missing: string[] = []

  for (const spec of functions) {
    const pattern = new RegExp(`\\b${escapeRegExp(spec.name)}\\s*\\(`, "u")
    if (pattern.test(content)) found.push(spec.name)
    else missing.push(spec.name)
  }

  return { found, missing }
}

// Contract issue builders extracted to ./contract-issues.ts


// ============================================================================
// Build step spec evidence (main entry point)
// ============================================================================

export async function buildStepSpecEvidence(
  step: SubagentTaskStep,
  stepResult: PipelineStepResult,
  plan: Plan,
  readFile: Tool,
  readArtifactContent: (readFile: Tool, path: string, runCommand?: Tool) => Promise<string | null>,
  probeArtifact: (readFile: Tool, path: string, actualPaths: string[], wsRoot?: string, runCommand?: Tool, allowedWriteRoots?: readonly string[]) => Promise<{ found: boolean; resolvedPath: string }>,
  runCommand?: Tool,
  actualPaths: string[] = [],
): Promise<StepSpecEvidence | null> {
  const blueprintPath = findBlueprintForStep(step)
  if (!blueprintPath) return null

  const blueprintContent = await readArtifactContent(readFile, blueprintPath, runCommand)
  if (!blueprintContent) {
    return {
      stepName: step.name,
      blueprintPath,
      sourceReads: collectSourceReadEvidence(stepResult, blueprintPath),
      mappings: [],
      contractSharedTypes: [],
      sharedTypes: [],
      algorithmicContracts: [],
      structuralIssues: [`SPEC INGESTION FAILED: could not read ${blueprintPath} for step ${step.name}`],
      processAuditIssues: collectSpecAuditIssues(step, stepResult, blueprintPath),
    }
  }

  const spec = parseBlueprintSpec(blueprintPath, blueprintContent)
  const structuralIssues: string[] = []
  const mappings: ArtifactSpecMapping[] = []
  const sourceReads = collectSourceReadEvidence(stepResult, blueprintPath)
  const processAuditIssues = collectSpecAuditIssues(step, stepResult, blueprintPath)

  if (sourceReads.length === 0) {
    structuralIssues.push(
      `SPEC EVIDENCE MISSING: step ${step.name} did not read ${blueprintPath} before producing artifacts`,
    )
  }

  if (spec.files.length === 0) {
    structuralIssues.push(
      `SPEC INGESTION WEAK: ${blueprintPath} did not yield any declared file structure for step ${step.name}`,
    )
  }

  structuralIssues.push(...buildBlueprintArtifactCoverageIssues(step, spec, plan, blueprintPath))
  structuralIssues.push(...buildBlueprintFunctionContractIssues(step, spec, blueprintPath))
  structuralIssues.push(...buildBlueprintSharedTypeContractIssues(step, spec, plan, blueprintPath))

  for (const artifact of step.executionContext.targetArtifacts) {
    const normalizedArtifact = normalizeSpecPath(artifact)
    if (isBlueprintLikeStepForVerifier(step) && normalizedArtifact === normalizeSpecPath(blueprintPath)) {
      continue
    }
    const exactMatch = spec.files.find(file => normalizeSpecPath(file.declaredPath) === normalizedArtifact)
    const basenameMatch = exactMatch
      ? null
      : spec.files.find(file => file.basename === normalizeBasename(normalizedArtifact))
    const matchedSpec = exactMatch ?? basenameMatch ?? null
    const probe = await probeArtifact(
      readFile,
      artifact,
      actualPaths,
      step.executionContext.workspaceRoot || undefined,
      runCommand,
      step.executionContext.allowedWriteRoots,
    )
    const resolvedArtifactPath = probe.found ? probe.resolvedPath : null
    const content = resolvedArtifactPath
      ? await readArtifactContent(readFile, resolvedArtifactPath, runCommand)
      : null
    const functionEvidence = matchedSpec && content
      ? detectFunctionsInArtifact(content, matchedSpec.functions)
      : { found: [], missing: matchedSpec?.functions.map(fn => fn.name) ?? [] }
    const actualStructuralMarkers = content ? detectStructuralMarkersInArtifact(artifact, content) : []
    const requiredStructuralMarkers = matchedSpec?.structuralMarkers ?? []
    const foundStructuralMarkers = requiredStructuralMarkers.filter(marker => actualStructuralMarkers.includes(marker))
    const missingStructuralMarkers = requiredStructuralMarkers.filter(marker => !actualStructuralMarkers.includes(marker))

    mappings.push({
      targetArtifact: artifact,
      actualArtifactPath: resolvedArtifactPath,
      matchedSpecPath: matchedSpec?.declaredPath ?? null,
      pathMatch: exactMatch ? "exact" : basenameMatch ? "basename" : "none",
      foundFunctions: functionEvidence.found,
      missingFunctions: functionEvidence.missing,
      foundStructuralMarkers,
      missingStructuralMarkers,
    })

    if (!matchedSpec) {
      structuralIssues.push(
        `SPEC MAPPING MISSING: target artifact ${artifact} does not map to any file declared in ${blueprintPath}`,
      )
      continue
    }

    if (!exactMatch && basenameMatch) {
      structuralIssues.push(
        `SPEC PATH MISMATCH: target artifact ${artifact} only matches blueprint file ${matchedSpec.declaredPath} by basename`,
      )
    }

    if (content && functionEvidence.missing.length > 0) {
      structuralIssues.push(
        `SPEC FUNCTION MISMATCH: ${artifact} is missing blueprint functions ${functionEvidence.missing.join(", ")} from ${matchedSpec.declaredPath}`,
      )
    }

    if (content && missingStructuralMarkers.length > 0) {
      structuralIssues.push(
        `SPEC STRUCTURE MISMATCH: ${artifact} is missing blueprint structure markers ${missingStructuralMarkers.join(", ")} from ${matchedSpec.declaredPath}`,
      )
    }
  }

  return {
    stepName: step.name,
    blueprintPath,
    sourceReads,
    mappings,
    contractSharedTypes: spec.contractSharedTypes,
    sharedTypes: spec.sharedTypes,
    algorithmicContracts: spec.algorithmicContracts,
    structuralIssues,
    processAuditIssues,
  }
}

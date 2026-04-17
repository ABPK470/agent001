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
    type BlueprintSpec,
    type StepSpecEvidence,
    collectSpecAuditIssues,
    detectStructuralMarkersInArtifact,
    parseBlueprintSpec,
} from "./core.js"

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

function isCodeLikeBlueprintArtifact(path: string): boolean {
  return /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|php|rb|swift|scala|sh|bash|zsh|ps1)$/i.test(path)
}

function isWeakFunctionContract(spec: BlueprintFunctionSpec): boolean {
  const signature = spec.signature.trim()
  if (!signature) return true
  if (signature === `${spec.name}()`) return true
  if (/\b(?:todo|tbd|placeholder)\b|\.\.\./i.test(signature)) return true
  return false
}

export function isBlueprintLikeStepForVerifier(step: SubagentTaskStep): boolean {
  return /blueprint/i.test(step.name)
    || step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

export function collectPlannedBlueprintArtifacts(plan: Plan): string[] {
  return uniqueStrings(
    plan.steps
      .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
      .filter((step) => !isBlueprintLikeStepForVerifier(step))
      .flatMap((step) => step.executionContext.targetArtifacts)
      .map(normalizeSpecPath)
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
}

export function buildBlueprintArtifactCoverageIssues(
  step: SubagentTaskStep,
  spec: BlueprintSpec,
  plan: Plan,
  blueprintPath: string,
): string[] {
  if (!isBlueprintLikeStepForVerifier(step)) return []
  if (!spec.contractBlockPresent) {
    return [
      `BLUEPRINT CONTRACT MISSING: ${blueprintPath} must include a machine-readable \`blueprint-contract\` JSON block with the exact planned artifact paths before implementation steps can run`,
    ]
  }
  if (spec.contractBlockErrors.length > 0) return [...spec.contractBlockErrors]

  const declaredArtifacts = uniqueStrings(
    spec.contractFiles
      .map((file) => normalizeSpecPath(file.declaredPath))
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
  const plannedArtifacts = collectPlannedBlueprintArtifacts(plan)
  const missingPlanned = plannedArtifacts.filter((artifact) => !declaredArtifacts.includes(artifact))
  const undeclaredExtras = declaredArtifacts.filter((artifact) => !plannedArtifacts.includes(artifact))

  const issues: string[] = []
  if (missingPlanned.length > 0) {
    issues.push(
      `BLUEPRINT ARTIFACT COVERAGE FAILED: ${blueprintPath} is missing planned artifact declarations ${missingPlanned.join(", ")}`,
    )
  }
  if (undeclaredExtras.length > 0) {
    issues.push(
      `BLUEPRINT ARTIFACT DRIFT: ${blueprintPath} declares files not present in the plan targetArtifacts (${undeclaredExtras.join(", ")})`,
    )
  }
  return issues
}

// ============================================================================
// Blueprint contract issue builders
// ============================================================================

function buildBlueprintFunctionContractIssues(
  step: SubagentTaskStep,
  spec: BlueprintSpec,
  blueprintPath: string,
): string[] {
  if (!isBlueprintLikeStepForVerifier(step)) return []

  const issues: string[] = []
  const mergedFiles = new Map(spec.files.map((file) => [normalizeSpecPath(file.declaredPath), file]))

  for (const contractFile of spec.contractFiles) {
    const normalizedPath = normalizeSpecPath(contractFile.declaredPath)
    const merged = mergedFiles.get(normalizedPath)
    const contractNames = new Set(contractFile.functions.map((fn) => fn.name))
    const proseOnlyFunctions = (merged?.functions ?? []).filter((fn) => !contractNames.has(fn.name))
    const weakFunctions = contractFile.functions.filter((fn) => isWeakFunctionContract(fn))

    if (proseOnlyFunctions.length > 0) {
      issues.push(
        `BLUEPRINT FUNCTION CONTRACT DRIFT: machine contract for ${contractFile.declaredPath} omits functions declared elsewhere in ${blueprintPath} (${proseOnlyFunctions.map((fn) => fn.name).join(", ")})`,
      )
    }

    if (weakFunctions.length > 0 && isCodeLikeBlueprintArtifact(contractFile.declaredPath)) {
      issues.push(
        `BLUEPRINT FUNCTION CONTRACT WEAK: ${contractFile.declaredPath} contains underspecified machine contract signatures (${weakFunctions.map((fn) => fn.signature).join(", ")})`,
      )
    }
  }

  return issues
}

function buildBlueprintSharedTypeContractIssues(
  step: SubagentTaskStep,
  spec: BlueprintSpec,
  plan: Plan,
  blueprintPath: string,
): string[] {
  if (!isBlueprintLikeStepForVerifier(step)) return []

  const issues: string[] = []
  const plannedArtifacts = new Set(collectPlannedBlueprintArtifacts(plan))
  const declaredArtifacts = new Set(
    spec.contractFiles
      .map((file) => normalizeSpecPath(file.declaredPath))
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
  const contractTypeNames = new Set(spec.contractSharedTypes.map((type) => type.name))
  const proseOnlyTypes = spec.sharedTypes.filter((type) => !contractTypeNames.has(type))

  if (proseOnlyTypes.length > 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE DRIFT: ${blueprintPath} describes shared types outside the machine contract (${proseOnlyTypes.join(", ")})`,
    )
  }

  const weakSharedTypes = spec.contractSharedTypes.filter((type) => !type.definition.trim())
  if (weakSharedTypes.length > 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE CONTRACT WEAK: sharedTypes entries must include a concrete definition (${weakSharedTypes.map((type) => type.name).join(", ")})`,
    )
  }

  const driftedUsage = spec.contractSharedTypes.filter((type) => type.usedBy.length > 0 &&
    type.usedBy.some((path) => {
      const normalized = normalizeSpecPath(path)
      return !declaredArtifacts.has(normalized) && !plannedArtifacts.has(normalized)
    }),
  )
  if (driftedUsage.length > 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE DRIFT: sharedTypes.usedBy references undeclared artifacts (${driftedUsage.map((type) => type.name).join(", ")})`,
    )
  }

  const sharedTypeRequired = /\bshared\s+(?:data|types?|state|schema|model|structure|contract)\b/i.test(
    [step.objective, ...step.acceptanceCriteria].join(" "),
  )
  if (sharedTypeRequired && spec.contractSharedTypes.length === 0) {
    issues.push(
      `BLUEPRINT SHARED TYPE CONTRACT WEAK: ${blueprintPath} declares no sharedTypes even though the blueprint contract requires shared data coordination`,
    )
  }

  return issues
}

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

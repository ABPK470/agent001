/**
 * Blueprint contract issue builders — coverage, function, and shared-type
 * contract drift detectors. Extracted from evidence.ts.
 *
 * @module
 */

import {
    normalizeSpecPath,
    uniqueStrings,
} from "../blueprint-contract/index.js"
import type { Plan, SubagentTaskStep } from "../types.js"
import {
    type BlueprintFunctionSpec,
    type BlueprintSpec,
} from "./core.js"

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

export function buildBlueprintFunctionContractIssues(
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

export function buildBlueprintSharedTypeContractIssues(
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

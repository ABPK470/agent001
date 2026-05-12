/**
 * Blueprint types, structural marker extraction, spec audit, and blueprint parsing.
 *
 * @module
 */

import type { BlueprintSharedTypeSpec } from "../blueprint-contract.js"
import {
    normalizeBasename,
    normalizeSpecPath,
    parseBlueprintContractBlock,
    uniqueStrings,
} from "../blueprint-contract.js"
import type { PipelineStepResult, SubagentTaskStep } from "../types.js"
import {
    BLUEPRINT_FILE_PATH_RE,
    BLUEPRINT_TREE_FILE_RE,
    extractStructureMarkersFromText,
} from "./structural-markers.js"

export { detectStructuralMarkersInArtifact } from "./structural-markers.js"

// ============================================================================
// Types
// ============================================================================

export interface BlueprintFunctionSpec {
  readonly name: string
  readonly signature: string
}

export interface BlueprintFileSpec {
  readonly declaredPath: string
  readonly basename: string
  readonly functions: readonly BlueprintFunctionSpec[]
  readonly structuralMarkers: readonly string[]
}

export interface BlueprintSpec {
  readonly blueprintPath: string
  readonly files: readonly BlueprintFileSpec[]
  readonly contractFiles: readonly BlueprintFileSpec[]
  readonly contractSharedTypes: readonly BlueprintSharedTypeSpec[]
  readonly contractBlockPresent: boolean
  readonly contractBlockErrors: readonly string[]
  readonly sharedTypes: readonly string[]
  readonly algorithmicContracts: readonly string[]
}

export interface ArtifactSpecMapping {
  readonly targetArtifact: string
  readonly actualArtifactPath: string | null
  readonly matchedSpecPath: string | null
  readonly pathMatch: "exact" | "basename" | "none"
  readonly foundFunctions: readonly string[]
  readonly missingFunctions: readonly string[]
  readonly foundStructuralMarkers: readonly string[]
  readonly missingStructuralMarkers: readonly string[]
}

export interface StepSpecEvidence {
  readonly stepName: string
  readonly blueprintPath: string
  readonly sourceReads: readonly string[]
  readonly mappings: readonly ArtifactSpecMapping[]
  readonly contractSharedTypes: readonly BlueprintSharedTypeSpec[]
  readonly sharedTypes: readonly string[]
  readonly algorithmicContracts: readonly string[]
  readonly structuralIssues: readonly string[]
  readonly processAuditIssues: readonly string[]
}

// ============================================================================
// Structural marker extraction lives in structural-markers.ts
// ============================================================================

// ============================================================================
// Spec audit & process checks
// ============================================================================

/** Shell mutation pattern — commands that indicate workspace modifications. */
const SHELL_MUTATION_RE =
  /(?:^|[;&|]\s*|\n)\s*(?:cp|mv|rm|mkdir|touch|tee|sed|perl|python|node|ruby|go|cargo|npm|pnpm|yarn|make|cmake|cat|echo|printf)\b|>>?/i
/** Direct mutation tool names. */
const DIRECT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "append_file"])

export function collectSpecAuditIssues(
  step: SubagentTaskStep,
  stepResult: PipelineStepResult,
  blueprintPath: string,
): string[] {
  const calls = stepResult.toolCalls ?? []
  const normalizedBlueprint = normalizeSpecPath(blueprintPath)
  const issues: string[] = []
  const blueprintIsTargetArtifact = step.executionContext.targetArtifacts
    .map(normalizeSpecPath)
    .includes(normalizedBlueprint)

  const firstBlueprintReadIndex = calls.findIndex(call => {
    if (call.name !== "read_file") return false
    const path = typeof call.args.path === "string" ? normalizeSpecPath(call.args.path) : ""
    return path === normalizedBlueprint || /(?:^|\/)BLUEPRINT\.md$/i.test(path)
  })

  if (firstBlueprintReadIndex === -1) {
    if (!blueprintIsTargetArtifact) {
      issues.push(`PROCESS AUDIT FAILED: step ${step.name} never read ${blueprintPath}`)
    }
    return issues
  }

  const firstMutationIndex = calls.findIndex(call => {
    if (DIRECT_MUTATION_TOOLS.has(call.name)) return true
    if (call.name !== "run_command") return false
    const command = typeof call.args.command === "string" ? call.args.command : ""
    return SHELL_MUTATION_RE.test(command)
  })

  if (firstMutationIndex !== -1 && firstBlueprintReadIndex > firstMutationIndex && !blueprintIsTargetArtifact) {
    issues.push(
      `PROCESS AUDIT FAILED: step ${step.name} read ${blueprintPath} only after starting file mutations`,
    )
  }

  const targetReads = new Set(
    calls.flatMap(call => {
      if (call.name !== "read_file") return []
      const path = typeof call.args.path === "string" ? normalizeSpecPath(call.args.path) : ""
      return path ? [path] : []
    }),
  )
  const replaceInFileTargets = new Set(
    calls.flatMap(call => {
      if (call.name !== "replace_in_file") return []
      const path = typeof call.args.path === "string" ? normalizeSpecPath(call.args.path) : ""
      return path ? [path] : []
    }),
  )
  const readRequiredTargets = new Set(step.executionContext.requiredSourceArtifacts.map(normalizeSpecPath))
  const missingTargetReads = step.executionContext.targetArtifacts
    .map(normalizeSpecPath)
    .filter(path => readRequiredTargets.has(path) || replaceInFileTargets.has(path))
    .filter(path => !targetReads.has(path))

  if (missingTargetReads.length > 0) {
    issues.push(
      `PROCESS AUDIT WEAK: step ${step.name} mutated or produced artifacts without reading target files first (${missingTargetReads.slice(0, 4).join(", ")})`,
    )
  }

  return issues
}

// ============================================================================
// Blueprint parsing
// ============================================================================

export function parseBlueprintSpec(blueprintPath: string, content: string): BlueprintSpec {
  const fileMap = new Map<string, BlueprintFileSpec>()
  const contractBlock = parseBlueprintContractBlock(content)
  const sharedTypes = new Set<string>(contractBlock.sharedTypes.map((type) => type.name))
  const algorithmicContracts = new Set<string>()
  let currentFile: string | null = null
  let inSharedTypes = false
  let inAlgorithmSection = false

  const ensureFile = (declaredPath: string): BlueprintFileSpec => {
    const normalizedPath = normalizeSpecPath(declaredPath)
    const existing = fileMap.get(normalizedPath)
    if (existing) return existing
    const created: BlueprintFileSpec = {
      declaredPath: normalizedPath,
      basename: normalizeBasename(normalizedPath),
      functions: [],
      structuralMarkers: [],
    }
    fileMap.set(normalizedPath, created)
    return created
  }

  const appendFunction = (declaredPath: string, spec: BlueprintFunctionSpec) => {
    const normalizedPath = normalizeSpecPath(declaredPath)
    const existing = ensureFile(normalizedPath)
    if (existing.functions.some(fn => fn.name === spec.name)) return
    fileMap.set(normalizedPath, {
      ...existing,
      functions: [...existing.functions, spec],
    })
  }

  const appendStructuralMarkers = (declaredPath: string, markers: readonly string[]) => {
    const normalizedPath = normalizeSpecPath(declaredPath)
    const existing = ensureFile(normalizedPath)
    fileMap.set(normalizedPath, {
      ...existing,
      structuralMarkers: uniqueStrings([...existing.structuralMarkers, ...markers]),
    })
  }

  for (const contractFile of contractBlock.files) {
    ensureFile(contractFile.declaredPath)
    if (contractFile.functions.length > 0) {
      for (const spec of contractFile.functions) appendFunction(contractFile.declaredPath, spec)
    }
    if (contractFile.structuralMarkers.length > 0) {
      appendStructuralMarkers(contractFile.declaredPath, contractFile.structuralMarkers)
    }
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^#{1,6}\s+/u.test(line)) {
      const heading = line.replace(/^#{1,6}\s+/u, "").trim().toLowerCase()
      inSharedTypes = heading.includes("shared data") || heading.includes("data structures")
      inAlgorithmSection = heading.includes("algorithm") || heading.includes("logic") || heading.includes("flow")
      currentFile = null
    }

    const inlineFileMatch = line.match(BLUEPRINT_FILE_PATH_RE)
    if (inlineFileMatch) {
      currentFile = normalizeSpecPath(inlineFileMatch[1])
      ensureFile(currentFile)
    }

    const treeMatch = line.match(BLUEPRINT_TREE_FILE_RE)
    if (treeMatch) {
      currentFile = normalizeSpecPath(treeMatch[1])
      ensureFile(currentFile)
    }

    if (currentFile) {
      const markers = extractStructureMarkersFromText(line)
      if (markers.length > 0) appendStructuralMarkers(currentFile, markers)
    }

    const functionMatch = line.match(/^(?:[-*]\s*|\d+\.\s*)(?:(?:function|method|proc(?:edure)?|subroutine|handler|command|cmdlet|def|fn|lambda|label|target)\s+)?`?([A-Za-z_.$@?-][\w.$@?-]*)\s*\(([^)]*)\)`?(?::|\s|$)/iu)
    if (functionMatch && currentFile) {
      appendFunction(currentFile, {
        name: functionMatch[1],
        signature: `${functionMatch[1]}(${functionMatch[2].trim()})`,
      })
    }

    const sharedTypeMatch = line.match(/`([A-Z][A-Za-z0-9_]+)`/u)
    if (sharedTypeMatch && inSharedTypes) {
      sharedTypes.add(sharedTypeMatch[1])
    }

    if (inAlgorithmSection && /^[-*]\s+/u.test(line)) {
      algorithmicContracts.add(line.replace(/^[-*]\s+/u, "").trim())
    }
  }

  return {
    blueprintPath,
    files: Array.from(fileMap.values()),
    contractFiles: contractBlock.files,
    contractSharedTypes: contractBlock.sharedTypes,
    contractBlockPresent: contractBlock.present,
    contractBlockErrors: Array.from(contractBlock.errors),
    sharedTypes: Array.from(sharedTypes),
    algorithmicContracts: Array.from(algorithmicContracts),
  }
}

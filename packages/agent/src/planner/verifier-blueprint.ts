/**
 * Verifier blueprint — blueprint parsing, structural marker detection,
 * spec evidence building, and artifact coverage analysis.
 *
 * Extracted from verifier.ts.
 *
 * @module
 */

import type { Tool } from "../types.js"
import type { BlueprintSharedTypeSpec } from "./blueprint-contract.js"
import {
    normalizeBasename,
    normalizeSpecPath,
    parseBlueprintContractBlock,
    uniqueStrings,
} from "./blueprint-contract.js"
import type {
    PipelineStepResult,
    Plan,
    SubagentTaskStep,
} from "./types.js"
import { escapeRegExp } from "./verifier-helpers.js"

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
// Structural marker extraction
// ============================================================================

function normalizeStructuralMarker(kind: string, value: string): string {
  return `${kind}:${value.trim().toLowerCase()}`
}

function collectRegexMarkers(content: string, kind: string, pattern: RegExp, group = 1): string[] {
  const markers: string[] = []
  for (const match of content.matchAll(pattern)) {
    const value = match[group]
    if (typeof value === "string" && value.trim().length > 0) {
      markers.push(normalizeStructuralMarker(kind, value))
    }
  }
  return markers
}

const BLUEPRINT_FILE_PATH_RE = /`([^`]*?(?:index\.[A-Za-z0-9]+|[\w./-]+\.(?:[A-Za-z0-9]{1,8})))`/u
const BLUEPRINT_TREE_FILE_RE = /^[|`'\-+*\\/ ]*([A-Za-z0-9_./-]+\.(?:[A-Za-z0-9]{1,8}))$/u

function extractStructureMarkersFromText(text: string): string[] {
  const markers: string[] = []

  const snippets = [text, ...(Array.from(text.matchAll(/`([^`]+)`/g), match => match[1]))]
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(/<([a-z][a-z0-9-]*)\b/giu)) {
      markers.push(normalizeStructuralMarker("tag", match[1]))
    }
    for (const match of snippet.matchAll(/(^|\s)#([a-z][\w-]*)/giu)) {
      markers.push(normalizeStructuralMarker("id", match[2]))
    }
    for (const match of snippet.matchAll(/(^|\s)\.([a-z][\w-]*)/giu)) {
      markers.push(normalizeStructuralMarker("class", match[2]))
    }
    for (const match of snippet.matchAll(/\b(data-[a-z0-9-]+)\b/giu)) {
      markers.push(normalizeStructuralMarker("data", match[1]))
    }
    for (const match of snippet.matchAll(/\[\s*(data-[a-z0-9-]+)(?:=[^\]]+)?\]/giu)) {
      markers.push(normalizeStructuralMarker("data", match[1]))
    }
    for (const match of snippet.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Panel|View|Component|Layout|Widget|Page|Dialog|Modal|Card|List|Form|Header|Footer|Sidebar|Board|Canvas|Grid))\b/g)) {
      markers.push(normalizeStructuralMarker("component", match[1]))
    }
    for (const match of snippet.matchAll(/\b(?:function|method|proc(?:edure)?|subroutine|def|fn|lambda|handler|command|cmdlet|label|target)\s+`?([A-Za-z_.$@?-][\w.$@-]*)`?/giu)) {
      markers.push(normalizeStructuralMarker("function", match[1]))
    }
    for (const match of snippet.matchAll(/\b(?:class|struct|interface|trait|enum|record|module|namespace|package|type)\s+`?([A-Za-z_.$@?-][\w.$@-]*)`?/giu)) {
      markers.push(normalizeStructuralMarker("type", match[1]))
    }
  }

  return uniqueStrings(markers)
}

function extractHtmlStructureMarkers(content: string): string[] {
  const markers: string[] = []

  for (const match of content.matchAll(/<([a-z][a-z0-9-]*)\b/giu)) {
    markers.push(normalizeStructuralMarker("tag", match[1]))
  }
  for (const match of content.matchAll(/\sid=["']([^"']+)["']/giu)) {
    markers.push(...match[1].split(/\s+/).filter(Boolean).map(value => normalizeStructuralMarker("id", value)))
  }
  for (const match of content.matchAll(/\sclass=["']([^"']+)["']/giu)) {
    markers.push(...match[1].split(/\s+/).filter(Boolean).map(value => normalizeStructuralMarker("class", value)))
  }
  for (const match of content.matchAll(/\s(data-[a-z0-9-]+)(?:=["'][^"']*["'])?/giu)) {
    markers.push(normalizeStructuralMarker("data", match[1]))
  }
  for (const match of content.matchAll(/<script[^>]+src=["']([^"']+)["']/giu)) {
    markers.push(normalizeStructuralMarker("script", normalizeSpecPath(match[1])))
  }
  for (const match of content.matchAll(/<link[^>]+href=["']([^"']+)["']/giu)) {
    markers.push(normalizeStructuralMarker("asset", normalizeSpecPath(match[1])))
  }

  return uniqueStrings(markers)
}

function extractCodeStructureMarkers(content: string): string[] {
  const markers: string[] = []

  markers.push(...collectRegexMarkers(content, "function", /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*fn\s+([A-Za-z_][\w]*)\s*\(/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:public|private|protected|internal|static|final|virtual|override|abstract|sealed|async|partial|inline|constexpr|synchronized|extern|unsafe|new|shared|friend|mut|pub|open|operator|default|class)?(?:\s+(?:public|private|protected|internal|static|final|virtual|override|abstract|sealed|async|partial|inline|constexpr|synchronized|extern|unsafe|new|shared|friend|mut|pub|open|operator|default))*\s*[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_][\w]*)\s*\([^;\n{}]*\)\s*(?:\{|=>)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\b/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\s*\{/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*function\s+([A-Za-z_][\w-]*)\b/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*sub\s+([A-Za-z_][\w]*)\b/gi))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*proc(?:edure)?\s+([A-Za-z_][\w]*)\b/gi))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*\.?(?:globl|global)\s+([A-Za-z_.$@?][\w.$@?]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*([A-Za-z_.$@?][\w.$@?]*)\s*:/g))
  markers.push(...collectRegexMarkers(content, "function", /\(defun\s+([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /\(defmacro\s+([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /\(define\s+\(([A-Za-z_.*:+!<>?-][^\s()]*)/g))
  markers.push(...collectRegexMarkers(content, "function", /(?:^|\n)\s*(?:function|filter|workflow)\s+([A-Za-z_][\w-]*)\b/gi))

  markers.push(...collectRegexMarkers(content, "type", /export\s+class\s+([A-Za-z_$][\w$]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*(?:class|struct|interface|trait|enum|record|module|namespace|package)\s+([A-Za-z_][\w.]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:abstract\s+|final\s+|sealed\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)\b/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|=)/g))
  markers.push(...collectRegexMarkers(content, "type", /(?:^|\n)\s*New-Alias\s+-Name\s+([A-Za-z_][\w-]*)\b/gi))

  markers.push(...collectRegexMarkers(content, "component", /(?:^|\n)\s*const\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*\([^)]*\)\s*=>\s*</g))
  markers.push(...collectRegexMarkers(content, "component", /(?:^|\n)\s*function\s+([A-Z][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{?[\s\S]{0,120}?return\s*\(/g))
  markers.push(...collectRegexMarkers(content, "component", /<([A-Z][A-Za-z0-9_]*)\b/g))
  markers.push(...collectRegexMarkers(content, "tag", /<([a-z][a-z0-9-]*)\b/g))

  return uniqueStrings(markers)
}

export function detectStructuralMarkersInArtifact(path: string, content: string): string[] {
  if (/\.html?$/i.test(path)) return extractHtmlStructureMarkers(content)
  if (/\.(?:tsx|jsx)$/i.test(path)) return uniqueStrings([...extractHtmlStructureMarkers(content), ...extractCodeStructureMarkers(content)])
  if (/\.(?:ts|js|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|vb|php|rb|swift|scala|sh|bash|zsh|fish|ps1|psm1|psd1|pl|pm|lua|r|jl|clj|cljs|cljc|lisp|el|asm|s|S|c|cc|cpp|cxx|h|hpp|hh)$/i.test(path)) return extractCodeStructureMarkers(content)
  if (/\.(?:xml|xaml|csproj|fsproj|vbproj|gradle|properties|toml|yaml|yml|json|ini|cfg|conf|sql|md|txt)$/i.test(path)) return uniqueStrings([...extractStructureMarkersFromText(content), ...extractCodeStructureMarkers(content)])
  return []
}

// ============================================================================
// Spec audit & process checks
// ============================================================================

/** Shell mutation pattern — commands that indicate workspace modifications. */
const SHELL_MUTATION_RE =
  /(?:^|[;&|]\s*|\n)\s*(?:cp|mv|rm|mkdir|touch|tee|sed|perl|python|node|ruby|go|cargo|npm|pnpm|yarn|make|cmake|cat|echo|printf)\b|>>?/i
/** Direct mutation tool names. */
const DIRECT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "delete"])

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

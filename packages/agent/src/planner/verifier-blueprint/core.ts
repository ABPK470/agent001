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

import type { Plan, SubagentTaskStep } from "./types.js"

export interface BlueprintFunctionSpec {
  readonly name: string
  readonly signature: string
}

export interface BlueprintSharedTypeSpec {
  readonly name: string
  readonly definition: string
  readonly usedBy: readonly string[]
}

export interface BlueprintFileSpec {
  readonly declaredPath: string
  readonly basename: string
  readonly functions: readonly BlueprintFunctionSpec[]
  readonly structuralMarkers: readonly string[]
}

export interface BlueprintContractBlock {
  readonly version: number
  readonly files: readonly BlueprintFileSpec[]
  readonly sharedTypes: readonly BlueprintSharedTypeSpec[]
}

export interface ParsedBlueprintContractBlock {
  readonly present: boolean
  readonly files: readonly BlueprintFileSpec[]
  readonly sharedTypes: readonly BlueprintSharedTypeSpec[]
  readonly errors: readonly string[]
}

const BLUEPRINT_CONTRACT_BLOCK_RE = /```blueprint-contract\s*([\s\S]*?)```/iu

export function normalizeSpecPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

export function normalizeBasename(value: string): string {
  const normalized = normalizeSpecPath(value)
  const parts = normalized.split("/")
  return (parts[parts.length - 1] ?? normalized).toLowerCase()
}

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
}

function normalizeFunctionSpec(input: unknown): BlueprintFunctionSpec | null {
  const normalizeParameter = (parameter: unknown): string | null => {
    if (typeof parameter === "string") {
      const normalized = parameter.trim()
      return normalized || null
    }
    if (!parameter || typeof parameter !== "object") return null
    const rawParameter = parameter as Record<string, unknown>
    const name = typeof rawParameter.name === "string" ? rawParameter.name.trim() : ""
    const type = typeof rawParameter.type === "string"
      ? rawParameter.type.trim()
      : typeof rawParameter.schema === "string"
        ? rawParameter.schema.trim()
        : ""
    if (!name && !type) return null
    if (!name) return type || null
    return type ? `${name}: ${type}` : name
  }

  const buildSignature = (name: string, raw: Record<string, unknown>): string => {
    const providedSignature = typeof raw.signature === "string" ? raw.signature.trim() : ""
    if (providedSignature) return providedSignature

    const rawParameters = Array.isArray(raw.parameters)
      ? raw.parameters
      : Array.isArray(raw.params)
        ? raw.params
        : Array.isArray(raw.arguments)
          ? raw.arguments
          : []
    const parameters = rawParameters
      .map(normalizeParameter)
      .filter((value): value is string => Boolean(value))
    const returnType = typeof raw.returnType === "string"
      ? raw.returnType.trim()
      : typeof raw.returns === "string"
        ? raw.returns.trim()
        : ""
    const parameterBlock = parameters.join(", ")
    return returnType ? `${name}(${parameterBlock}): ${returnType}` : `${name}(${parameterBlock})`
  }

  if (typeof input === "string") {
    const name = input.trim()
    if (!name) return null
    return {
      name,
      signature: `${name}()`,
    }
  }
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null
  return {
    name,
    signature: buildSignature(name, raw),
  }
}

function normalizeSharedTypeSpec(input: unknown): BlueprintSharedTypeSpec | null {
  const normalizeDefinition = (raw: Record<string, unknown>): string => {
    if (typeof raw.definition === "string" && raw.definition.trim()) return raw.definition.trim()
    if (typeof raw.shape === "string" && raw.shape.trim()) return raw.shape.trim()
    if (Array.isArray(raw.properties) && raw.properties.length > 0) {
      const propertyPairs = raw.properties.flatMap((property) => {
        if (!property || typeof property !== "object") return []
        const rawProperty = property as Record<string, unknown>
        const name = typeof rawProperty.name === "string" ? rawProperty.name.trim() : ""
        const type = typeof rawProperty.type === "string" ? rawProperty.type.trim() : "unknown"
        return name ? [`${name}: ${type}`] : []
      })
      if (propertyPairs.length > 0) return `{ ${propertyPairs.join("; ")} }`
    }
    if (typeof raw.type === "string" && raw.type.trim()) return raw.type.trim()
    if (raw.schema && typeof raw.schema === "object") {
      try {
        return JSON.stringify(raw.schema)
      } catch {
        return ""
      }
    }
    return ""
  }

  if (typeof input === "string") {
    const name = input.trim()
    if (!name) return null
    return {
      name,
      definition: "",
      usedBy: [],
    }
  }
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  const definition = normalizeDefinition(raw)
  if (!name) return null
  return {
    name,
    definition,
    usedBy: normalizeMarkerList(raw.usedBy ?? raw.used_by ?? raw.consumers ?? raw.paths),
  }
}

function normalizeMarkerList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return uniqueStrings(input.filter((value): value is string => typeof value === "string"))
}

function normalizeFileSpec(input: unknown): BlueprintFileSpec | null {
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const declaredPath = typeof raw.path === "string"
    ? normalizeSpecPath(raw.path)
    : typeof raw.declaredPath === "string"
      ? normalizeSpecPath(raw.declaredPath)
      : ""
  if (!declaredPath) return null
  const rawFunctions = Array.isArray(raw.functions)
    ? raw.functions
    : Array.isArray(raw.exports)
      ? raw.exports
      : Array.isArray(raw.exportedFunctions)
        ? raw.exportedFunctions
        : null
  if (!rawFunctions) return null
  const functions = rawFunctions
    .map(normalizeFunctionSpec)
    .filter((value): value is BlueprintFunctionSpec => Boolean(value))
  if (functions.length !== rawFunctions.length) return null
  return {
    declaredPath,
    basename: normalizeBasename(declaredPath),
    functions,
    structuralMarkers: normalizeMarkerList(raw.structuralMarkers),
  }
}

export function parseBlueprintContractBlock(content: string): ParsedBlueprintContractBlock {
  const match = content.match(BLUEPRINT_CONTRACT_BLOCK_RE)
  if (!match) {
    return { present: false, files: [], sharedTypes: [], errors: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch (error) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: [
        `BLUEPRINT CONTRACT INVALID: machine-readable blueprint-contract block is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      ],
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract block must be a JSON object"],
    }
  }

  const raw = parsed as Record<string, unknown>
  const version = raw.version
  if (version !== 1) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract block must declare \"version\": 1"],
    }
  }

  if (!Array.isArray(raw.files)) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract block must declare a \"files\" array"],
    }
  }

  if (!Array.isArray(raw.sharedTypes)) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract block must declare a \"sharedTypes\" array (use [] when none are shared)"],
    }
  }

  const files = raw.files.map(normalizeFileSpec).filter((value): value is BlueprintFileSpec => Boolean(value))
  if (files.length !== raw.files.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: every blueprint-contract file entry must declare a non-empty exact path and a \"functions\" array (use [] when the file exports no functions)"],
    }
  }

  const sharedTypes = raw.sharedTypes
    .map(normalizeSharedTypeSpec)
    .filter((value): value is BlueprintSharedTypeSpec => Boolean(value))
  if (sharedTypes.length !== raw.sharedTypes.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: every sharedTypes entry must declare a non-empty name"],
    }
  }

  const normalizedPaths = files.map(file => file.declaredPath)
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: blueprint-contract file paths must be unique"],
    }
  }

  const normalizedSharedTypeNames = sharedTypes.map((type) => type.name.toLowerCase())
  if (new Set(normalizedSharedTypeNames).size !== normalizedSharedTypeNames.length) {
    return {
      present: true,
      files: [],
      sharedTypes: [],
      errors: ["BLUEPRINT CONTRACT INVALID: sharedTypes names must be unique"],
    }
  }

  return { present: true, files, sharedTypes, errors: [] }
}

function isBlueprintLikeStep(step: SubagentTaskStep): boolean {
  return /blueprint/i.test(step.name)
    || step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

function collectPlannedBlueprintArtifacts(plan: Plan): string[] {
  return uniqueStrings(
    plan.steps
      .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
      .filter((step) => !isBlueprintLikeStep(step))
      .flatMap((step) => step.executionContext.targetArtifacts)
      .map(normalizeSpecPath)
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )
}

export function getPlannedBlueprintArtifacts(plan: Plan): string[] {
  return collectPlannedBlueprintArtifacts(plan)
}

export function buildBlueprintSeedTemplate(
  blueprintPath: string,
  plannedArtifacts: readonly string[],
): string {
  const contract = {
    version: 1,
    files: plannedArtifacts.map((path) => ({
      path,
      purpose: `TODO: purpose for ${path}`,
      functions: [],
    })),
    sharedTypes: [],
  }

  const fileSections = plannedArtifacts.map((path) => [
    `### ${path}`,
    "- Purpose: TODO",
    "- Exports/entrypoints:",
    "  - TODO",
    "- Depends on:",
    "  - TODO",
    "- Used by:",
    "  - TODO",
    "- Algorithmic contracts:",
    "  - TODO",
  ].join("\n")).join("\n\n")

  return [
    `# Blueprint for ${blueprintPath}`,
    "",
    "Replace every TODO below, but keep the headings, fence names, and exact file paths unchanged.",
    "Do not add extra files. Do not rename listed paths. Do not remove the blueprint-contract block.",
    "",
    "## Planned Artifacts",
    ...plannedArtifacts.map((path) => `- ${path}`),
    "",
    "## Machine Contract",
    "```blueprint-contract",
    JSON.stringify(contract, null, 2),
    "```",
    "",
    "## Shared Data Types",
    "- If none, write `None` and keep `sharedTypes: []` in the machine contract.",
    "- In the machine contract, each sharedTypes entry should use `{ \"name\": \"TypeName\", \"definition\": \"exact shape\", \"usedBy\": [\"path/to/file\"] }`.",
    "- TODO",
    "",
    "## File Contracts",
    fileSections,
    "",
    "## Initialization Order",
    "- TODO",
    "",
    "## Cross-File Dependency Notes",
    "- TODO",
  ].join("\n")
}

export function validateBlueprintArtifactContract(
  step: SubagentTaskStep,
  plan: Plan,
  blueprintPath: string,
  content: string,
): string[] {
  if (!isBlueprintLikeStep(step)) return []

  const contract = parseBlueprintContractBlock(content)
  if (!contract.present) {
    return [
      `BLUEPRINT CONTRACT MISSING: ${blueprintPath} must include a machine-readable \`blueprint-contract\` JSON block with the exact planned artifact paths before implementation steps can run`,
    ]
  }
  if (contract.errors.length > 0) return [...contract.errors]

  const plannedArtifacts = collectPlannedBlueprintArtifacts(plan)
  const declaredArtifacts = uniqueStrings(
    contract.files
      .map((file) => normalizeSpecPath(file.declaredPath))
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact)),
  )

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
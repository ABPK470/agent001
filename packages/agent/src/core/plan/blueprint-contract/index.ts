import { canonicalizeRelative } from "../../internal/index.js"
import type { Plan, SubagentTaskStep } from "../types.js"

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

import { parseBlueprintContractBlock } from "./parse.js"
export { parseBlueprintContractBlock } from "./parse.js"

export function normalizeSpecPath(value: string): string {
  return canonicalizeRelative(value).trim()
}

export function normalizeBasename(value: string): string {
  const normalized = normalizeSpecPath(value)
  const parts = normalized.split("/")
  return (parts[parts.length - 1] ?? normalized).toLowerCase()
}

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

// normalizers + parseBlueprintContractBlock moved to ./blueprint-contract/parse.ts

function isBlueprintLikeStep(step: SubagentTaskStep): boolean {
  return (
    /blueprint/i.test(step.name) ||
    step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  )
}

function collectPlannedBlueprintArtifacts(plan: Plan): string[] {
  return uniqueStrings(
    plan.steps
      .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
      .filter((step) => !isBlueprintLikeStep(step))
      .flatMap((step) => step.executionContext.targetArtifacts)
      .map(normalizeSpecPath)
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  )
}

export function getPlannedBlueprintArtifacts(plan: Plan): string[] {
  return collectPlannedBlueprintArtifacts(plan)
}

export function buildBlueprintSeedTemplate(
  blueprintPath: string,
  plannedArtifacts: readonly string[]
): string {
  const contract = {
    version: 1,
    files: plannedArtifacts.map((path) => ({
      path,
      purpose: `TODO: purpose for ${path}`,
      functions: []
    })),
    sharedTypes: []
  }

  const fileSections = plannedArtifacts
    .map((path) =>
      [
        `### ${path}`,
        "- Purpose: TODO",
        "- Exports/entrypoints:",
        "  - TODO",
        "- Depends on:",
        "  - TODO",
        "- Used by:",
        "  - TODO",
        "- Algorithmic contracts:",
        "  - TODO"
      ].join("\n")
    )
    .join("\n\n")

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
    '- In the machine contract, each sharedTypes entry should use `{ "name": "TypeName", "definition": "exact shape", "usedBy": ["path/to/file"] }`.',
    "- TODO",
    "",
    "## File Contracts",
    fileSections,
    "",
    "## Initialization Order",
    "- TODO",
    "",
    "## Cross-File Dependency Notes",
    "- TODO"
  ].join("\n")
}

export function validateBlueprintArtifactContract(
  step: SubagentTaskStep,
  plan: Plan,
  blueprintPath: string,
  content: string
): string[] {
  if (!isBlueprintLikeStep(step)) return []

  const contract = parseBlueprintContractBlock(content)
  if (!contract.present) {
    return [
      `BLUEPRINT CONTRACT MISSING: ${blueprintPath} must include a machine-readable \`blueprint-contract\` JSON block with the exact planned artifact paths before implementation steps can run`
    ]
  }
  if (contract.errors.length > 0) return [...contract.errors]

  const plannedArtifacts = collectPlannedBlueprintArtifacts(plan)
  const declaredArtifacts = uniqueStrings(
    contract.files
      .map((file) => normalizeSpecPath(file.declaredPath))
      .filter((artifact) => !/(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  )

  const missingPlanned = plannedArtifacts.filter((artifact) => !declaredArtifacts.includes(artifact))
  const undeclaredExtras = declaredArtifacts.filter((artifact) => !plannedArtifacts.includes(artifact))

  const issues: string[] = []
  if (missingPlanned.length > 0) {
    issues.push(
      `BLUEPRINT ARTIFACT COVERAGE FAILED: ${blueprintPath} is missing planned artifact declarations ${missingPlanned.join(", ")}`
    )
  }
  if (undeclaredExtras.length > 0) {
    issues.push(
      `BLUEPRINT ARTIFACT DRIFT: ${blueprintPath} declares files not present in the plan targetArtifacts (${undeclaredExtras.join(", ")})`
    )
  }

  return issues
}

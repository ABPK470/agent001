import type { Plan, SubagentTaskStep } from "../types.js"
import { normalizeSpecPath, uniqueStrings } from "./normalize.js"
import { parseBlueprintContractBlock } from "./parse.js"

export type {
  BlueprintContractBlock,
  BlueprintFileSpec,
  BlueprintFunctionSpec,
  BlueprintSharedTypeSpec,
  ParsedBlueprintContractBlock
} from "./types.js"
export { normalizeBasename, normalizeSpecPath, uniqueStrings } from "./normalize.js"
export { parseBlueprintContractBlock } from "./parse.js"

/**
 * True when an artifact is executable/source code that can host function
 * contracts. JSON/MD evidence files are NOT code — inventing functions for
 * them creates unsatisfiable SPEC FUNCTION MISMATCH loops.
 */
export function isCodeLikeArtifact(path: string): boolean {
  return /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|cs|php|rb|swift|scala|sh|bash|zsh|ps1)$/i.test(
    path
  )
}

/**
 * True when an artifact is a multi-file build deliverable (code or browser
 * presentation). Investigation evidence (.json/.md/.csv/…) is not.
 */
export function isImplementationArtifact(path: string): boolean {
  return isCodeLikeArtifact(path) || /\.(?:html?|css|scss|sass|less)$/i.test(path)
}

/**
 * True when an artifact is investigation/docs evidence — not executable code.
 * These must not be graded as runtime/codegen contracts.
 */
export function isEvidenceArtifact(path: string): boolean {
  return /\.(?:md|markdown|txt|rst|adoc|json|ya?ml|csv|tsv|xml)$/i.test(path)
}

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

/** Planned build deliverables that participate in multi-file codegen. */
export function getPlannedImplementationArtifacts(plan: Plan): string[] {
  return getPlannedBlueprintArtifacts(plan).filter(isImplementationArtifact)
}

export function getPlannedCodeArtifacts(plan: Plan): string[] {
  return getPlannedBlueprintArtifacts(plan).filter(isCodeLikeArtifact)
}

/**
 * Codegen blueprint is for multi-module *code* (or HTML+script apps).
 * Pure static HTML/CSS or JSON/MD evidence plans must not get one.
 */
export function planNeedsCodegenBlueprint(plan: Plan): boolean {
  const implementation = getPlannedImplementationArtifacts(plan)
  const code = getPlannedCodeArtifacts(plan)
  return code.length >= 2 || (code.length >= 1 && implementation.length >= 2)
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

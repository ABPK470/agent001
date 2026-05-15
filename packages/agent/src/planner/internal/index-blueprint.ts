import { EffectClass, StepRole, VerificationMode } from "@mia/agent"
/**
 * Blueprint step injection — auto-inject contract-first blueprint steps
 * for multi-file code generation plans.
 *
 * Extracted from planner/index.ts for maintainability.
 *
 * @module
 */

import { buildBlueprintSeedTemplate, getPlannedBlueprintArtifacts } from "../blueprint-contract/index.js"
import { inferOutputDir } from "../normalize/index.js"
import type {
  Plan,
  PlanEdge,
  PlanStep,
  SubagentTaskStep,
} from "../types.js"

// ============================================================================
// Blueprint step injection
// ============================================================================

export function isBlueprintLikeStep(step: PlanStep): step is SubagentTaskStep {
  if (step.stepType !== "subagent_task") return false
  const sa = step as SubagentTaskStep
  if (/blueprint/i.test(sa.name)) return true
  return sa.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

export function injectBlueprintStep(plan: Plan, workspaceRoot: string, forcedOutputDir: string | null): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  const stepsWithArtifacts = subagentSteps.filter(s =>
    s.executionContext.targetArtifacts.length > 0,
  )
  if (stepsWithArtifacts.length < 2) return

  if (plan.steps.some(s => s.name === "generate_blueprint" || s.name.includes("blueprint"))) return

  const outputDir = forcedOutputDir ?? inferOutputDir(subagentSteps) ?? "tmp"
  const blueprintPath = `${outputDir}/BLUEPRINT.md`

  const plannedArtifacts = getPlannedBlueprintArtifacts(plan)
  const artifactList = plannedArtifacts.join(", ")
  const blueprintTemplate = buildBlueprintSeedTemplate(blueprintPath, plannedArtifacts)

  const blueprintStep: SubagentTaskStep = {
    name: "generate_blueprint",
    stepType: "subagent_task",
    dependsOn: [],
    objective:
      `Create a detailed architectural blueprint file at "${blueprintPath}" for a multi-file project.\n\n` +
      `The project will contain these files: ${artifactList}\n\n` +
      `CRITICAL FILE CONTRACT: The blueprint MUST declare the EXACT same artifact paths listed above. ` +
      `Do NOT rename files, move them into a different directory, or invent extra modules. ` +
      `If the plan says \`tmp/game_logic.js\`, the blueprint must declare \`tmp/game_logic.js\` exactly, not \`game/rules.js\` or any other substitute.\n\n` +
      `MANDATORY AUTHORING WORKFLOW:\n` +
      `1. Use write_file on \"${blueprintPath}\" with the completed blueprint template below.\n` +
      `2. Immediately read \"${blueprintPath}\" back with read_file.\n` +
      `3. If the \`blueprint-contract\` fence is missing, if any listed path differs from the planned artifact list, or if \`sharedTypes\`/\`functions\` are omitted, rewrite the SAME file and read it again before finishing.\n` +
      `4. Do not return success until the read-back BLUEPRINT.md contains the exact \`blueprint-contract\` block and exact planned artifact paths.\n\n` +
      `MANDATORY TEMPLATE — fill this exact template instead of writing free-form markdown:\n` +
      `${blueprintTemplate}\n\n` +
      `The BLUEPRINT.md MUST include this exact machine-readable block so artifact paths can be validated deterministically:\n` +
      `\`\`\`blueprint-contract\n` +
      `{\n` +
      `  "version": 1,\n` +
      `  "files": [\n` +
      `    {\n` +
      `      "path": "first/exact/path.ext",\n` +
      `      "purpose": "one-line purpose",\n` +
      `      "functions": [\n` +
      `        { "name": "exportedFunctionName", "signature": "exportedFunctionName(param: Type): ReturnType" }\n` +
      `      ]\n` +
      `    }\n` +
      `  ],\n` +
      `  "sharedTypes": [\n` +
      `    { "name": "SharedTypeName", "definition": "{ field: Type }", "usedBy": ["first/exact/path.ext"] }\n` +
      `  ]\n` +
      `}\n` +
      `\`\`\`\n` +
      `Replace the example entries with the EXACT planned artifact paths listed above, include every planned artifact exactly once, ` +
      `declare each file's exported functions in the \"functions\" array, and declare shared data contracts in \"sharedTypes\". Use empty arrays when none exist; never omit these fields.\n\n` +
      `The BLUEPRINT.md must define:\n` +
      `1. **File Structure**: List every file with a one-line purpose description\n` +
      `2. **Function Signatures**: For EVERY exported function and class method, define the EXACT signature:\n` +
      `   - Function name\n` +
      `   - Parameter names and types (e.g., \`board: string[][], fromRow: number, fromCol: number\`)\n` +
      `   - Return type\n` +
      `   - One-line description of what it does\n` +
      `3. **Shared Data Types**: Define every data structure shared between files:\n` +
      `   - Object shapes with field names and types\n` +
      `   - Enum/constant values\n` +
      `   - State shape (if applicable)\n` +
      `4. **Inter-File Dependencies**: Which file imports/uses what from which other file\n` +
      `5. **Initialization Order**: Which module initializes first and how they connect\n\n` +
      `Format each function signature as:\n` +
      `\`\`\`\n` +
      `function functionName(param1: type, param2: type): returnType\n` +
      `  // Brief description\n` +
      `\`\`\`\n\n` +
      `Think carefully about the COMPLETE set of functions needed. For a chess game, this means ALL move validation, ` +
      `ALL piece-specific movement, king safety, check/checkmate/stalemate detection, UI rendering, event handling, etc.\n` +
      `Do NOT write implementation code. ONLY write the blueprint document with signatures and types. ` +
      `The blueprint is invalid if its declared file list does not match the planned artifact list exactly.`,
    inputContract: "Project goal and file list",
    acceptanceCriteria: [
      "Defines complete function signatures for ALL planned modules — every function that will be called across files must appear with exact parameter names and types",
      `Declares the exact planned artifact paths and only those paths: ${artifactList}`,
      "Specifies shared data types used across files — board representation, piece types, game state shape",
      "Lists inter-file dependencies — which file exports what and which file imports it",
      "Function signatures are specific enough that two independent developers could implement compatible code from them alone",
      "Each function handling complex logic includes a complete algorithmic contract listing all cases/rules it must handle",
      "Shared data structures include all metadata needed for the declared rules and edge cases",
      "No function contract is a one-line summary like 'returns true if valid' — every contract specifies what makes the result correct",
      "No implementation code — only signatures, types, and descriptions",
    ],
    requiredToolCapabilities: ["write_file", "think"],
    contextRequirements: [],
    executionContext: {
      workspaceRoot,
      allowedReadRoots: [workspaceRoot],
      allowedWriteRoots: [`${workspaceRoot}/${outputDir}`],
      allowedTools: ["write_file", "read_file", "think"],
      requiredSourceArtifacts: [],
      targetArtifacts: [blueprintPath],
      effectClass: EffectClass.FilesystemWrite,
      verificationMode: VerificationMode.None,
      artifactRelations: [{ relationType: "write_owner", artifactPath: blueprintPath }],
      role: StepRole.Writer,
    },
    maxBudgetHint: "10 iterations",
    canRunParallel: false,
    workflowStep: {
      role: StepRole.Grounding,
      artifactRelations: [{ relationType: "write_owner", artifactPath: blueprintPath }],
    },
  }

  ;(plan as unknown as { steps: PlanStep[] }).steps = [blueprintStep, ...plan.steps]

  const newEdges = [...plan.edges]
  for (const step of plan.steps) {
    if (step.name === "generate_blueprint") continue
    newEdges.push({ from: "generate_blueprint", to: step.name })
  }
  ;(plan as unknown as { edges: PlanEdge[] }).edges = newEdges

  for (const step of subagentSteps) {
    const deps = step.dependsOn ? [...step.dependsOn] : []
    if (!deps.includes("generate_blueprint")) {
      deps.push("generate_blueprint")
    }
    ;(step as unknown as { dependsOn: string[] }).dependsOn = deps

    const sources = new Set(step.executionContext.requiredSourceArtifacts)
    sources.add(blueprintPath)
    ;(step.executionContext as unknown as { requiredSourceArtifacts: string[] }).requiredSourceArtifacts = [...sources]

    ;(step as { objective: string }).objective =
      `${step.objective}\n\n` +
      `📋 MANDATORY: Read "${blueprintPath}" FIRST. Follow the function signatures defined there EXACTLY — ` +
      `same function names, same parameter names, same parameter order, same return types. ` +
      `Do NOT invent new function signatures or rename parameters. The blueprint is the Single Source of Truth.`
  }
}

// ============================================================================
// Blueprint strengthening
// ============================================================================

export function strengthenExistingBlueprintSteps(plan: Plan, workspaceRoot: string, forcedOutputDir: string | null): void {
  const blueprintSteps = plan.steps.filter(isBlueprintLikeStep)
  if (blueprintSteps.length === 0) return

  const outputDir = forcedOutputDir ?? inferOutputDir(blueprintSteps) ?? "tmp"
  const blueprintPath = blueprintSteps[0].executionContext.targetArtifacts.find((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
    ?? `${outputDir}/BLUEPRINT.md`

  for (const step of blueprintSteps) {
    const criteria = new Set(step.acceptanceCriteria)
    criteria.add("Defines complete function signatures for ALL planned modules — every function that will be called across files must appear with exact parameter names and types")
    criteria.add("Specifies shared data types used across files — including all state metadata needed for the declared rules and edge cases")
    criteria.add("Each function handling complex logic includes a complete algorithmic contract listing all cases/rules it must handle")
    criteria.add("No function contract is a one-line summary like 'returns true if valid' — every contract specifies what makes the result correct")

    ;(step as unknown as { acceptanceCriteria: string[] }).acceptanceCriteria = [...criteria]
    if (!step.objective.includes("BLUEPRINT DEPTH REQUIREMENTS:")) {
      const plannedArtifacts = getPlannedBlueprintArtifacts(plan)
      const blueprintTemplate = buildBlueprintSeedTemplate(blueprintPath, plannedArtifacts)
      ;(step as unknown as { objective: string }).objective =
        `${step.objective}\n\n` +
        `BLUEPRINT DEPTH REQUIREMENTS:\n` +
        `- This is a CONTRACT document, not implementation code.\n` +
        `- For every non-trivial function, enumerate the full algorithmic contract: all cases, rules, constraints, and edge cases.\n` +
        `- The declared file structure MUST match the planned targetArtifacts exactly; do NOT rename paths or invent extra modules.\n` +
        `- Include a \`blueprint-contract\` JSON block with \`version: 1\`, per-file \`functions\` arrays, and a top-level \`sharedTypes\` array; this block is the machine-readable source of truth. Use empty arrays when needed, never omit the fields.\n` +
        `- For code files, each machine-contract function entry should include at least \`name\` plus a concrete \`signature\` (or equivalent \`parameters\` + \`returnType\`) and should match the prose file contract.\n` +
        `- For sharedTypes, provide a concrete definition/shape and, when practical, list the exact \`usedBy\` artifact paths that consume the type.\n` +
        `- Do NOT add fake runtime-verification sections, test plans, or execution-history prose.\n` +
        `- Verification for a blueprint step is satisfied by writing the document and then re-reading BLUEPRINT.md with read_file to confirm the contract is present.\n` +
        `- Use the exact seeded template below; replace TODOs only, preserve the fence name \`blueprint-contract\`, and preserve the exact planned paths.\n\n` +
        `${blueprintTemplate}`
    }
    ;(step.executionContext as unknown as { workspaceRoot: string }).workspaceRoot = step.executionContext.workspaceRoot || workspaceRoot
    if (!step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))) {
      ;(step.executionContext as unknown as { targetArtifacts: string[] }).targetArtifacts = [blueprintPath, ...step.executionContext.targetArtifacts]
    }
    if (!step.executionContext.allowedTools.includes("read_file")) {
      ;(step.executionContext as unknown as { allowedTools: string[] }).allowedTools = [...step.executionContext.allowedTools, "read_file"]
    }
    if (!step.requiredToolCapabilities.includes("read_file")) {
      ;(step as unknown as { requiredToolCapabilities: string[] }).requiredToolCapabilities = [...step.requiredToolCapabilities, "read_file"]
    }
    ;(step.executionContext as unknown as { verificationMode: VerificationMode }).verificationMode = VerificationMode.None
  }

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    if (blueprintSteps.some((blueprint) => blueprint.name === step.name)) continue
    const sa = step as SubagentTaskStep
    const deps = sa.dependsOn ? [...sa.dependsOn] : []
    if (!deps.includes(blueprintSteps[0].name)) {
      deps.push(blueprintSteps[0].name)
    }
    ;(sa as unknown as { dependsOn: string[] }).dependsOn = deps

    const sources = new Set(sa.executionContext.requiredSourceArtifacts)
    sources.add(blueprintPath)
    ;(sa.executionContext as unknown as { requiredSourceArtifacts: string[] }).requiredSourceArtifacts = [...sources]
  }
}

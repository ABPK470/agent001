/**
 * Planner orchestrator — the main entry point for planned execution.
 *
 * Flow:
 *   1. assessPlannerDecision() — should we plan? (score >= 3)
 *   2. generatePlan() — ask LLM for structured plan
 *   3. validatePlan() — multi-pass validation with refinement
 *   4. executePipeline() — DAG-ordered step execution
 *   5. verify() — deterministic probes + LLM verification
 *   6. Retry pipeline if verification says "retry" (max 2 retries)
 *
 * @module
 */

export {
  createBudgetState, createCircuitBreaker, isBlocked, maybeExtendBudget, recordFailure,
  recordSuccess
} from "./circuit-breaker.js"
export type { BudgetState } from "./circuit-breaker.js"
export { assessPlannerDecision } from "./decision.js"
export { generateCoherentBootstrap, generatePlan } from "./generate.js"
export type { CoherentBootstrapGenerationResult, PlanGenerationContext, PlanGenerationResult } from "./generate.js"
export { executePipeline } from "./pipeline.js"
export type { DelegateFn, DelegateResult, PipelineExecutorOptions, ToolExecFn } from "./pipeline.js"
export { validatePlan } from "./validate.js"
export type { ValidationResult } from "./validate.js"
export { runDeterministicProbes, runLLMVerification, verify } from "./verifier.js"

// Re-export all types
export type {
  ArchitecturePreservationStatus, ArtifactRelation, ChildExecutionResult, CircuitBreakerState, CoherentArchitectureArtifact, CoherentSharedContract, CoherentSolutionArtifact, CoherentSolutionBundle, CoherentSystemInvariant, DeterministicToolStep, DiagnosticCategory, DiagnosticSeverity, EffectClass, ExecutionEnvelope, LegacyRetryPlan, PipelineResult, PipelineStatus, PipelineStepExecutionState, PipelineStepResult, PipelineStepStatus, Plan, PlanDiagnostic, PlanEdge, PlannerCoherentBootstrap, PlannerDecision, PlannerNeedLevel, PlannerRepairCompatibilityMode, PlanStep, RepairPlan, RepairPlanCompatibilityReport, RepairTask, RoutingConfidence, StepAcceptanceState, StepRole, SubagentFailureClass, SubagentTaskStep, VerificationAttempt, VerificationEvidence, VerificationMode, VerifierDecision, VerifierIssue, VerifierOutcome,
  VerifierStepAssessment, WorkflowStepContract
} from "./types.js"

import { assessDelegationDecision, type DelegationDecisionInput, type DelegationSubagentStepProfile } from "../delegation-decision.js"
import { buildEscalationInput, resolveEscalation, type EscalationDecision } from "../escalation.js"
import type { LLMClient, Message, Tool } from "../types.js"
import { buildBlueprintSeedTemplate, getPlannedBlueprintArtifacts } from "./blueprint-contract.js"
import { createBudgetState, maybeExtendBudget } from "./circuit-breaker.js"
import { assessPlannerDecision } from "./decision.js"
import { generateCoherentBootstrap, generatePlan } from "./generate.js"
import type { DelegateFn } from "./pipeline.js"
import { executePipeline } from "./pipeline.js"
import { compilePlannerRuntime } from "./runtime-model.js"
import type { PipelineResult, Plan, PlanDiagnostic, PlanEdge, PlannerCoherentBootstrap, PlannerRepairCompatibilityMode, PlanStep, RepairPlan, SubagentTaskStep, VerifierDecision } from "./types.js"
import { validatePlan } from "./validate.js"
import { buildIssueIdentity, buildLegacyRetryPlan, buildRepairPlan, compareRepairPlanCompatibility, deriveAcceptanceState } from "./verification-model.js"
import { verify } from "./verifier.js"

function resolvePlannerCompatibilityMode(): PlannerRepairCompatibilityMode {
  const raw = (process.env["AGENT_PLANNER_COMPAT_MODE"] ?? "shadow").trim().toLowerCase()
  if (raw === "legacy" || raw === "repair" || raw === "shadow") return raw
  return "shadow"
}

function resolvePlannerCompatibilityThreshold(): number {
  const raw = Number(process.env["AGENT_PLANNER_COMPAT_THRESHOLD"] ?? 3)
  if (!Number.isFinite(raw)) return 3
  return Math.max(1, Math.floor(raw))
}

function applyVerificationAcceptanceStates(
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
): PipelineResult {
  const nextResults = new Map(pipelineResult.stepResults)

  for (const assessment of verifierDecision.steps) {
    const result = nextResults.get(assessment.stepName)
    if (!result) continue
    const hasBlueprintContractIssue = (assessment.issueDetails ?? []).some((issue) => issue.repairClass === "contract_drift" && /blueprint|spec/i.test(issue.summary))
    nextResults.set(assessment.stepName, {
      ...result,
      acceptanceState: deriveAcceptanceState(assessment, result.acceptanceState),
      failureClass: hasBlueprintContractIssue ? "blueprint_contract" : result.failureClass,
    })
  }

  return {
    ...pipelineResult,
    stepResults: nextResults,
  }
}

// ============================================================================
// Warning injection — augment step objectives with validation warnings
// ============================================================================

/**
 * Inject validation warnings into the plan's step objectives so child agents
 * receive guidance about potential issues without blocking the pipeline.
 *
 * Mutates step objectives in-place on the (mutable) plan object.
 */
function injectWarningsIntoSteps(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  // Partition: step-specific warnings go to that step; global ones go to all subagent steps
  const stepWarnings = new Map<string, string[]>()
  const globalWarnings: string[] = []

  for (const w of warnings) {
    if (w.stepName) {
      const arr = stepWarnings.get(w.stepName) ?? []
      arr.push(w.message)
      stepWarnings.set(w.stepName, arr)
    } else {
      globalWarnings.push(w.message)
    }
  }

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const msgs = [
      ...(stepWarnings.get(sa.name) ?? []),
      ...globalWarnings,
    ]
    if (msgs.length === 0) continue
    const suffix = `\n\n⚠️ VALIDATION WARNINGS (address these in your implementation):\n${msgs.map(m => `- ${m}`).join("\n")}`
    // Mutate objective — plan steps are not deeply frozen
    ;(sa as { objective: string }).objective = sa.objective + suffix
  }
}

/**
 * Auto-fix warning classes that are known to cause cross-step integration
 * failures if left as guidance-only.
 */
function applyWarningAutoFixes(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  const codes = new Set(warnings.map(w => w.code))

  if (codes.has("inconsistent_output_directory") || codes.has("mixed_root_and_subdir")) {
    normalizePlanOutputDirectory(plan)
  }

  if (codes.has("missing_shared_data_contract")) {
    injectSharedDataContract(plan)
  }

  if (codes.has("missing_dependency_wiring_criteria")) {
    injectDependencyWiringCriteria(plan)
  }

  injectBrowserRuntimeContracts(plan)
  injectHelperDependencyContracts(plan)
  injectVisualStyleContracts(plan)
}

function normalizeOutputDirToken(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/+$/, "")
}

export function inferForcedOutputDirectoryFromGoal(goal: string): string | null {
  const namedMatch = goal.match(/\btemporary\s+working\s+directory\s+named\s+([a-zA-Z0-9._\/-]+)/i)
  if (namedMatch?.[1]) {
    const dir = normalizeOutputDirToken(namedMatch[1])
    if (dir && !dir.includes("..")) return dir
  }

  const constrainedPathMatch = goal.match(
    /\ball\s+project\s+files\b[\s\S]{0,120}?\b(?:in|under|inside)\s+([a-zA-Z0-9._\/-]+)/i,
  )
  if (constrainedPathMatch?.[1]) {
    const dir = normalizeOutputDirToken(constrainedPathMatch[1])
    if (dir && !dir.includes("..")) return dir
  }

  // Strong fallback for common phrasing in goal prompts.
  if (/\ball\s+project\s+files\b[\s\S]{0,120}?\btmp\b/i.test(goal)) {
    return "tmp"
  }

  return null
}

function normalizePlanOutputDirectory(plan: Plan, preferredDirOverride?: string): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  const dirs: string[] = []

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const normalized = artifact.replace(/^\.\//, "")
      const slash = normalized.lastIndexOf("/")
      if (slash > 0) dirs.push(normalized.slice(0, slash))
    }
  }

  const preferredDir = normalizeOutputDirToken(preferredDirOverride ?? "") || (mostFrequent(dirs) ?? "tmp")
  const knownTopDirs = new Set(dirs.map(d => d.split("/")[0]).filter(Boolean))
  const targetByBasename = new Map<string, string>()

  for (const step of subagentSteps) {
    const current = step.executionContext.targetArtifacts
    const normalized = current.map((artifact) => {
      const path = artifact.replace(/^\.\//, "")
      if (!path.includes("/")) return `${preferredDir}/${path}`
      if (path.startsWith(`${preferredDir}/`)) return path
      const parts = path.split("/")
      return `${preferredDir}/${parts.slice(1).join("/")}`
    })
    ;(step.executionContext as unknown as { targetArtifacts: readonly string[] }).targetArtifacts = normalized

    // Align write roots with the forced/normalized output directory so children
    // cannot create sibling trees like scripts/ while targets are in tmp/.
    const wsRoot = step.executionContext.workspaceRoot.replace(/\/+$/, "")
    const scopedWriteRoot = wsRoot && (wsRoot.startsWith("/") || /^[A-Za-z]:[\\/]/.test(wsRoot))
      ? `${wsRoot}/${preferredDir}`
      : preferredDir
    ;(step.executionContext as unknown as { allowedWriteRoots: readonly string[] }).allowedWriteRoots = [scopedWriteRoot]

    for (const target of normalized) {
      const base = target.split("/").pop()
      if (!base) continue
      if (!targetByBasename.has(base)) {
        targetByBasename.set(base, target)
      }
    }
  }

  for (const step of subagentSteps) {
    const currentSources = step.executionContext.requiredSourceArtifacts
    const normalizedSources = currentSources.map((artifact) => {
      const source = artifact.replace(/^\.\//, "")
      if (source.startsWith(`${preferredDir}/`)) return source

      const slash = source.indexOf("/")
      if (slash > 0) {
        const top = source.slice(0, slash)
        if (knownTopDirs.has(top)) {
          return `${preferredDir}/${source.slice(slash + 1)}`
        }
      }

      const base = source.split("/").pop() ?? source
      return targetByBasename.get(base) ?? source
    })
    ;(step.executionContext as unknown as { requiredSourceArtifacts: readonly string[] }).requiredSourceArtifacts = [...new Set(normalizedSources)]
  }
}

function injectSharedDataContract(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  const jsWriters = subagentSteps.filter(s => s.executionContext.targetArtifacts.some(a => /\.js$/i.test(a)))
  if (jsWriters.length < 2) return

  const FORMAT_SPEC_RE = /\b(?:format|structure|schema|interface|shape|object\s*\{|array\s*of|record\s*of|map\s*of|canonical\s+data\s+contract)\b/i
  if (jsWriters.some(s => FORMAT_SPEC_RE.test(s.objective))) return

  const owner = jsWriters[0]
  ;(owner as { objective: string }).objective =
    `${owner.objective}\n\n` +
    `Shared data contract: define one canonical state schema (keys, types, and example payload), ` +
    `and ensure all related modules consume that exact schema consistently.`

  if (!owner.acceptanceCriteria.some(c => /shared data contract|schema|canonical state/i.test(c))) {
    ;(owner as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
      ...owner.acceptanceCriteria,
      "Defines and documents a canonical shared data contract (state schema + field types) used by all dependent modules.",
    ]
  }
}

function injectSharedStateOwnershipContract(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )
  const jsWriters = subagentSteps.filter(s => s.executionContext.targetArtifacts.some(a => /\.js$/i.test(a)))
  if (jsWriters.length < 2) return

  const owner = [...jsWriters].sort((a, b) => {
    const aCount = a.executionContext.targetArtifacts.filter(x => /\.js$/i.test(x)).length
    const bCount = b.executionContext.targetArtifacts.filter(x => /\.js$/i.test(x)).length
    return bCount - aCount
  })[0]
  if (!owner) return

  const ownerArtifact = owner.executionContext.targetArtifacts.find(a => /\.js$/i.test(a))
  if (!ownerArtifact) return

  const contract = {
    contractId: `shared-state:${ownerArtifact}`,
    ownerStepName: owner.name,
    ownerArtifactPath: ownerArtifact,
    schema: "Single shared state object documented by owner file; consumers must read and use that schema without redefining it.",
    mutationPolicy: "owner-only" as const,
  }

  for (const step of jsWriters) {
    ;(step.executionContext as unknown as { sharedStateContract?: typeof contract }).sharedStateContract = contract

    if (step.name !== owner.name) {
      const required = new Set(step.executionContext.requiredSourceArtifacts)
      required.add(ownerArtifact)
      ;(step.executionContext as unknown as { requiredSourceArtifacts: readonly string[] }).requiredSourceArtifacts = [...required]

      ;(step as { objective: string }).objective =
        `${step.objective}\n\nShared state contract (${contract.contractId}): ` +
        `READ and consume state from ${ownerArtifact}. Do NOT mutate ${ownerArtifact} or redefine the schema in this step.`
    } else {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\nShared state contract (${contract.contractId}): ` +
        `You are the sole state owner. Define and document the canonical schema in ${ownerArtifact}.`
    }
  }
}

function injectDependencyWiringCriteria(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  for (const step of subagentSteps) {
    const hasConsumerArtifact = step.executionContext.targetArtifacts.some(
      a => /\.(?:html?|xhtml|xml|md|markdown|svg)$/i.test(a),
    )
    if (!hasConsumerArtifact) continue

    const ownedDependencyBasenames = step.executionContext.targetArtifacts
      .filter(a => /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i.test(a))
      .map(a => a.split("/").pop() ?? a)
    if (ownedDependencyBasenames.length === 0) continue

    const hasWiringCriterion = step.acceptanceCriteria.some(
      c => /\b(?:load|import|include|link|reference|wire|attach|depends?\s+on|hook(?:s|ed)?\s+up)\b/i.test(c),
    )
    if (!hasWiringCriterion) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        `Consumer artifacts explicitly load/reference dependency artifacts: ${[...new Set(ownedDependencyBasenames)].join(", ")}.`,
      ]
    }
  }
}

function injectBrowserRuntimeContracts(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  const htmlOwners = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.(?:html?|xhtml)$/i.test(artifact)),
  )
  const jsWriters = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.js$/i.test(artifact)),
  )

  if (htmlOwners.length === 0 || jsWriters.length === 0) return

  const jsArtifacts = uniqueList(jsWriters.flatMap(step =>
    step.executionContext.targetArtifacts.filter(artifact => /\.js$/i.test(artifact)),
  ))
  const jsBasenames = uniqueList(jsArtifacts.map(artifact => artifact.split("/").pop() ?? artifact))
  if (jsBasenames.length === 0) return

  const browserModuleInstruction =
    `Browser runtime contract: runtime JS must use ES modules consistently for ${jsBasenames.join(", ")}. ` +
    `Use \`<script type="module">\` in HTML and use \`export\`/\`import\` for every cross-file browser dependency. ` +
    `Never use classic scripts, \`window.X\` globals, \`module.exports\`, or \`require()\` in browser-loaded files.`

  for (const step of htmlOwners) {
    if (!/script|type="module"|import\s|load.*\.js/i.test(step.objective)) {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\nEntrypoint wiring contract: this HTML entrypoint must explicitly load the runtime entry module(s) for ${jsBasenames.join(", ")} using \`<script type="module" src="...">\`. ` +
        `Every browser runtime file must be reachable from those entry module imports so the page actually loads the full runtime graph.`
    }

    if (!step.acceptanceCriteria.some(criterion => /script tag|type="module"|load.*\.js|runtime artifacts|entry module/i.test(criterion))) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        `Entrypoint HTML loads the runtime entry module(s) with <script type="module"> and reaches the runtime files ${jsBasenames.join(", ")} through direct module loading or imports.`,
      ]
    }
  }

  for (const step of jsWriters) {
    if (!step.objective.includes("Browser runtime contract: runtime JS must use ES modules consistently")) {
      ;(step as { objective: string }).objective = `${step.objective}\n\n${browserModuleInstruction}`
    }

    if (!step.acceptanceCriteria.includes("Uses ES modules consistently in browser runtime files; cross-file dependencies use import/export and no CommonJS or window globals.")) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        "Uses ES modules consistently in browser runtime files; cross-file dependencies use import/export and no CommonJS or window globals.",
      ]
    }
  }
}

function injectHelperDependencyContracts(plan: Plan): void {
  const codeWriterSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  ).filter(step =>
    step.executionContext.targetArtifacts.some(artifact =>
      /\.(?:js|jsx|mjs|cjs|ts|tsx|py|rb|php|java|cs|go|rs|swift|kt)$/i.test(artifact),
    ),
  )

  for (const step of codeWriterSteps) {
    if (!/defined in the same file|imported explicitly|dangling references|undefined helper/i.test(step.objective)) {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\n` +
        `Dependency closure contract: every non-builtin symbol this step's code calls or references must be either defined in the same file or imported explicitly from declared dependency artifacts. ` +
        `Do NOT leave dangling helper calls, undefined constants, or placeholder cross-file references.`
    }

    if (!step.acceptanceCriteria.some(criterion => /defined in the same file|imported explicitly|dangling helper|undefined helper|dependency closure/i.test(criterion))) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        "Every non-builtin symbol used by the produced code is either defined in the same file or imported explicitly from declared dependency artifacts; no dangling helper references remain.",
      ]
    }
  }
}

function injectVisualStyleContracts(plan: Plan): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  const styleSteps = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.(?:css|scss|sass|less)$/i.test(artifact)),
  )
  const browserSteps = subagentSteps.filter(step =>
    step.executionContext.targetArtifacts.some(artifact => /\.(?:html?|js|jsx|ts|tsx|mjs)$/i.test(artifact)),
  )

  if (styleSteps.length === 0 || browserSteps.length === 0) return

  for (const step of browserSteps) {
    if (!/interaction state|visual feedback|css classes|row\/column parity|nth-child/i.test(step.objective)) {
      ;(step as { objective: string }).objective =
        `${step.objective}\n\n` +
        `Visual integration contract: every CSS class referenced by the HTML/JS for interaction state or visual feedback must have matching stylesheet rules in the related CSS artifacts. ` +
        `For 2D board/grid cell alternation, use coordinate-aware parity (row/column or equivalent data model), not flat nth-child striping across a linear DOM list.`
    }

    if (!step.acceptanceCriteria.some(criterion => /css class|visual feedback|row\/column parity|nth-child|interaction state/i.test(criterion))) {
      ;(step as unknown as { acceptanceCriteria: readonly string[] }).acceptanceCriteria = [
        ...step.acceptanceCriteria,
        "Interaction-state and visual-feedback CSS classes referenced by the UI are defined in related stylesheets, and 2D alternating board/grid visuals use coordinate-aware parity rather than flat nth-child striping.",
      ]
    }
  }
}

// ============================================================================
// Contract-First: Blueprint step injection
// ============================================================================

/**
 * Auto-inject a "blueprint" step as step 0 for multi-file code generation plans.
 *
 * The blueprint step creates a BLUEPRINT.md file that defines:
 *   - Every file to be created and its purpose
 *   - Every exported function/class with EXACT signatures (params + return types)
 *   - Shared data structures with field names and types
 *   - Inter-file dependencies
 *
 * All subsequent implementation steps receive BLUEPRINT.md as a requiredSourceArtifact,
 * ensuring every child agent follows the same API contract.
 *
 * This directly addresses the "Variable Drift" problem from agentic systems where
 * Agent A calls it `movePiece(from, to)` and Agent B calls it `movePiece(piece, src, dst)`.
 */
function injectBlueprintStep(plan: Plan, workspaceRoot: string, forcedOutputDir: string | null): void {
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  // Inject for any multi-step plan (2+ subagent steps with files to produce).
  // Previously gated on 2+ "code-file" steps, which missed web projects where
  // HTML/CSS steps don't count as "code". The blueprint is valuable whenever
  // multiple agents need to coordinate on shared interfaces.
  const stepsWithArtifacts = subagentSteps.filter(s =>
    s.executionContext.targetArtifacts.length > 0,
  )
  if (stepsWithArtifacts.length < 2) return

  // Don't double-inject if a blueprint step already exists
  if (plan.steps.some(s => s.name === "generate_blueprint" || s.name.includes("blueprint"))) return

  // Determine output directory from existing steps
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
      effectClass: "filesystem_write",
      verificationMode: "none",
      artifactRelations: [{ relationType: "write_owner", artifactPath: blueprintPath }],
      role: "writer",
    },
    maxBudgetHint: "10 iterations",
    canRunParallel: false,
    workflowStep: {
      role: "grounding",
      artifactRelations: [{ relationType: "write_owner", artifactPath: blueprintPath }],
    },
  }

  // Insert blueprint step at the beginning
  ;(plan as unknown as { steps: PlanStep[] }).steps = [blueprintStep, ...plan.steps]

  // Add edges: blueprint → every other step
  const newEdges = [...plan.edges]
  for (const step of plan.steps) {
    if (step.name === "generate_blueprint") continue
    newEdges.push({ from: "generate_blueprint", to: step.name })
  }
  ;(plan as unknown as { edges: PlanEdge[] }).edges = newEdges

  // Add dependsOn to every implementation step + add blueprint as required source
  for (const step of subagentSteps) {
    const deps = step.dependsOn ? [...step.dependsOn] : []
    if (!deps.includes("generate_blueprint")) {
      deps.push("generate_blueprint")
    }
    ;(step as unknown as { dependsOn: string[] }).dependsOn = deps

    // Add BLUEPRINT.md as required source artifact
    const sources = new Set(step.executionContext.requiredSourceArtifacts)
    sources.add(blueprintPath)
    ;(step.executionContext as unknown as { requiredSourceArtifacts: string[] }).requiredSourceArtifacts = [...sources]

    // Augment objective to reference the blueprint
    ;(step as { objective: string }).objective =
      `${step.objective}\n\n` +
      `📋 MANDATORY: Read "${blueprintPath}" FIRST. Follow the function signatures defined there EXACTLY — ` +
      `same function names, same parameter names, same parameter order, same return types. ` +
      `Do NOT invent new function signatures or rename parameters. The blueprint is the Single Source of Truth.`
  }
}

function isBlueprintLikeStep(step: PlanStep): step is SubagentTaskStep {
  if (step.stepType !== "subagent_task") return false
  const sa = step as SubagentTaskStep
  if (/blueprint/i.test(sa.name)) return true
  return sa.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

function strengthenExistingBlueprintSteps(plan: Plan, workspaceRoot: string, forcedOutputDir: string | null): void {
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
    ;(step.executionContext as unknown as { verificationMode: "none" | "basic" | "strict" }).verificationMode = "none"
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

/** Infer the output directory from existing subagent steps' target artifacts. */
function inferOutputDir(steps: readonly SubagentTaskStep[]): string | null {
  const dirs: string[] = []
  for (const step of steps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const normalized = artifact.replace(/^\.\//, "")
      const slash = normalized.lastIndexOf("/")
      if (slash > 0) {
        const topDir = normalized.split("/")[0]
        if (topDir) dirs.push(topDir)
      }
    }
  }
  return mostFrequent(dirs) ?? null
}

function uniqueList(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function mergeEffectClass(
  left: SubagentTaskStep["executionContext"]["effectClass"],
  right: SubagentTaskStep["executionContext"]["effectClass"],
): SubagentTaskStep["executionContext"]["effectClass"] {
  if (left === right) return left
  if (left === "mixed" || right === "mixed") return "mixed"
  if (left === "shell" || right === "shell") return "mixed"
  if (left === "readonly") return right
  if (right === "readonly") return left
  if (left === "filesystem_scaffold" || right === "filesystem_scaffold") return "filesystem_scaffold"
  return "filesystem_write"
}

function mergeVerificationMode(
  left: SubagentTaskStep["executionContext"]["verificationMode"],
  right: SubagentTaskStep["executionContext"]["verificationMode"],
): SubagentTaskStep["executionContext"]["verificationMode"] {
  const precedence: readonly SubagentTaskStep["executionContext"]["verificationMode"][] = [
    "browser_check",
    "run_tests",
    "deterministic_followup",
    "mutation_required",
    "none",
  ]
  for (const mode of precedence) {
    if (left === mode || right === mode) return mode
  }
  return left
}

function buildPlannerDependencyMap(plan: Plan): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>()
  for (const step of plan.steps) {
    deps.set(step.name, new Set(step.dependsOn ?? []))
  }
  for (const edge of plan.edges) {
    const set = deps.get(edge.to) ?? new Set<string>()
    set.add(edge.from)
    deps.set(edge.to, set)
  }
  return deps
}

function stepTransitivelyDependsOn(plan: Plan, stepName: string, targetName: string): boolean {
  if (stepName === targetName) return false
  const deps = buildPlannerDependencyMap(plan)
  const seen = new Set<string>()
  const stack = [...(deps.get(stepName) ?? [])]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === targetName) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(deps.get(current) ?? []))
  }

  return false
}

function mergeSubagentSteps(plan: Plan, primaryStepName: string, secondaryStepName: string): boolean {
  if (primaryStepName === secondaryStepName) return false

  const mutableSteps = plan.steps as PlanStep[]
  const primaryIndex = mutableSteps.findIndex((step) => step.name === primaryStepName)
  const secondaryIndex = mutableSteps.findIndex((step) => step.name === secondaryStepName)
  if (primaryIndex < 0 || secondaryIndex < 0) return false

  const primary = mutableSteps[primaryIndex]
  const secondary = mutableSteps[secondaryIndex]
  if (primary.stepType !== "subagent_task" || secondary.stepType !== "subagent_task") return false

  const mergedDependsOn = uniqueList([
    ...(primary.dependsOn ?? []),
    ...(secondary.dependsOn ?? []),
  ].filter((name) => name !== primary.name && name !== secondary.name))

  const mergedTargetArtifacts = uniqueList([
    ...primary.executionContext.targetArtifacts,
    ...secondary.executionContext.targetArtifacts,
  ])

  const mergedExecutionContext: SubagentTaskStep["executionContext"] = {
    ...primary.executionContext,
    allowedReadRoots: uniqueList([
      ...primary.executionContext.allowedReadRoots,
      ...secondary.executionContext.allowedReadRoots,
    ]),
    allowedWriteRoots: uniqueList([
      ...primary.executionContext.allowedWriteRoots,
      ...secondary.executionContext.allowedWriteRoots,
    ]),
    allowedTools: uniqueList([
      ...primary.executionContext.allowedTools,
      ...secondary.executionContext.allowedTools,
    ]),
    requiredSourceArtifacts: uniqueList([
      ...primary.executionContext.requiredSourceArtifacts,
      ...secondary.executionContext.requiredSourceArtifacts,
    ]),
    targetArtifacts: mergedTargetArtifacts,
    effectClass: mergeEffectClass(primary.executionContext.effectClass, secondary.executionContext.effectClass),
    verificationMode: mergeVerificationMode(primary.executionContext.verificationMode, secondary.executionContext.verificationMode),
    artifactRelations: [
      ...new Map(
        [
          ...primary.executionContext.artifactRelations,
          ...secondary.executionContext.artifactRelations,
          ...mergedTargetArtifacts.map((artifactPath) => ({ relationType: "write_owner" as const, artifactPath })),
        ].map((relation) => [`${relation.relationType}:${relation.artifactPath}`, relation]),
      ).values(),
    ],
    role: primary.executionContext.role ?? secondary.executionContext.role,
    sharedStateContract: primary.executionContext.sharedStateContract ?? secondary.executionContext.sharedStateContract,
  }

  const mergedWorkflowRelations = [
    ...(primary.workflowStep?.artifactRelations ?? []),
    ...(secondary.workflowStep?.artifactRelations ?? []),
  ]

  const mergedStep: SubagentTaskStep = {
    ...primary,
    dependsOn: mergedDependsOn,
    objective: `${primary.objective}\n\nAlso complete the integration follow-up originally scoped to ${secondary.name}: ${secondary.objective}`,
    inputContract: uniqueList([primary.inputContract, secondary.inputContract]).join("\n\n"),
    acceptanceCriteria: uniqueList([
      ...primary.acceptanceCriteria,
      ...secondary.acceptanceCriteria,
    ]),
    requiredToolCapabilities: uniqueList([
      ...primary.requiredToolCapabilities,
      ...secondary.requiredToolCapabilities,
    ]),
    contextRequirements: uniqueList([
      ...primary.contextRequirements,
      ...secondary.contextRequirements,
    ]),
    executionContext: mergedExecutionContext,
    maxBudgetHint: primary.maxBudgetHint,
    canRunParallel: false,
    workflowStep: mergedWorkflowRelations.length > 0
      ? {
        role: primary.workflowStep?.role ?? secondary.workflowStep?.role ?? primary.executionContext.role ?? secondary.executionContext.role ?? "writer",
        artifactRelations: [
          ...new Map(mergedWorkflowRelations.map((relation) => [`${relation.relationType}:${relation.artifactPath}`, relation])).values(),
        ],
      }
      : primary.workflowStep,
  }

  mutableSteps[primaryIndex] = mergedStep
  mutableSteps.splice(secondaryIndex, 1)

  for (const step of mutableSteps) {
    if (!step.dependsOn || step.dependsOn.length === 0) continue
    const rewritten = uniqueList(step.dependsOn.map((dep) => dep === secondaryStepName ? primaryStepName : dep))
      .filter((dep) => dep !== step.name)
    ;(step as { dependsOn?: string[] }).dependsOn = rewritten.length > 0 ? rewritten : undefined
  }

  const mutableEdges = plan.edges as PlanEdge[]
  const rewrittenEdges = mutableEdges
    .map((edge) => ({
      from: edge.from === secondaryStepName ? primaryStepName : edge.from,
      to: edge.to === secondaryStepName ? primaryStepName : edge.to,
    }))
    .filter((edge) => edge.from !== edge.to)

  ;(plan as unknown as { edges: PlanEdge[] }).edges = [
    ...new Map(rewrittenEdges.map((edge) => [`${edge.from}->${edge.to}`, edge])).values(),
  ]

  return true
}

function remediateSharedTargetArtifactWriters(plan: Plan): boolean {
  const subagentSteps = plan.steps.filter(
    (step): step is SubagentTaskStep => step.stepType === "subagent_task",
  )
  const writersByArtifact = new Map<string, string[]>()

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext.targetArtifacts) {
      const writers = writersByArtifact.get(artifact) ?? []
      if (!writers.includes(step.name)) writers.push(step.name)
      writersByArtifact.set(artifact, writers)
    }
  }

  let changed = false
  for (const [artifact, writers] of writersByArtifact) {
    if (writers.length !== 2) continue
    const [leftName, rightName] = writers
    const leftDependsOnRight = stepTransitivelyDependsOn(plan, leftName, rightName)
    const rightDependsOnLeft = stepTransitivelyDependsOn(plan, rightName, leftName)
    if (leftDependsOnRight === rightDependsOnLeft) continue

    const primaryName = rightDependsOnLeft ? leftName : rightName
    const secondaryName = rightDependsOnLeft ? rightName : leftName
    if (mergeSubagentSteps(plan, primaryName, secondaryName)) {
      changed = true
    }

    // Recompute after each successful merge to avoid operating on stale step names.
    if (changed) {
      const remainingWriters = plan.steps
        .filter((step): step is SubagentTaskStep => step.stepType === "subagent_task")
        .filter((step) => step.executionContext.targetArtifacts.includes(artifact))
      if (remainingWriters.length <= 1) continue
    }
  }

  return changed
}

/**
 * Apply deterministic remediations for specific blocking validation errors.
 * Returns true when the plan was modified and should be re-validated.
 */
function remediateValidationErrors(plan: Plan, errors: readonly PlanDiagnostic[]): boolean {
  let changed = false
  const subagentSteps = plan.steps.filter(
    (s): s is SubagentTaskStep => s.stepType === "subagent_task",
  )

  if (errors.some((e) => e.code === "inconsistent_output_directory" || e.code === "mixed_root_and_subdir")) {
    normalizePlanOutputDirectory(plan)
    changed = true
  }

  if (errors.some((e) => e.code === "shared_target_artifact")) {
    changed = remediateSharedTargetArtifactWriters(plan) || changed
  }

  // If an HTML step verifies with browser_check before related JS ownership,
  // defer that verification to a later owner step to avoid impossible contracts.
  const premature = errors.filter(
    (e) => e.code === "premature_browser_verification" && typeof e.stepName === "string",
  )

  if (premature.length > 0) {
    for (const diag of premature) {
      const step = subagentSteps.find(s => s.name === diag.stepName)
      if (!step) continue
      if (step.executionContext.verificationMode === "browser_check") {
        ;(step.executionContext as unknown as { verificationMode: SubagentTaskStep["executionContext"]["verificationMode"] }).verificationMode = "none"
        changed = true
      }
    }
  }

  // Hard guard: if a browser entry step verifies with browser_check but owns no
  // web runtime artifacts, while sibling steps own those artifacts, defer verification.
  for (const step of subagentSteps) {
    if (step.executionContext.verificationMode !== "browser_check") continue
    const hasBrowserEntry = step.executionContext.targetArtifacts.some(a => /\.(?:html?|xhtml)$/i.test(a))
    if (!hasBrowserEntry) continue

    const ownsRuntime = step.executionContext.targetArtifacts.some(
      a => /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i.test(a),
    )
    if (ownsRuntime) continue

    const hasForeignRuntime = subagentSteps.some(
      s => s.name !== step.name && s.executionContext.targetArtifacts.some(a => /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i.test(a)),
    )
    if (!hasForeignRuntime) continue

    ;(step.executionContext as unknown as { verificationMode: SubagentTaskStep["executionContext"]["verificationMode"] }).verificationMode = "none"
    changed = true
  }

  return changed
}

function mostFrequent(items: readonly string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  let best: string | undefined
  let bestCount = -1
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item
      bestCount = count
    }
  }
  return best
}

// ============================================================================
// Main orchestrator
// ============================================================================

export interface PlannerContext {
  /** LLM client. */
  readonly llm: LLMClient
  /** Available tools. */
  readonly tools: readonly Tool[]
  /** Workspace root path. */
  readonly workspaceRoot: string
  /** Conversation history. */
  readonly history: readonly Message[]
  /** Abort signal. */
  readonly signal?: AbortSignal
  /** Called with trace events for UI. */
  readonly onTrace?: (entry: Record<string, unknown>) => void
}

export interface PlannerResult {
  /** Did the planner handle this task? */
  readonly handled: boolean
  /** Final answer if handled. */
  readonly answer?: string
  /** The plan that was generated (for debug/trace). */
  readonly plan?: Plan
  /** Pipeline result (for debug/trace). */
  readonly pipelineResult?: PipelineResult
  /** Verifier decision (for debug/trace). */
  readonly verifierDecision?: VerifierDecision
  /** Reason the planner didn't handle the task (if !handled). */
  readonly skipReason?: string
}

function buildPlannerFailurePayload(params: {
  stage: "generation" | "validation" | "delegation"
  reason: string
  diagnostics?: readonly unknown[]
  score?: number
  plannerReason?: string
}): string {
  return JSON.stringify({
    kind: "planner_failure",
    stage: params.stage,
    reason: params.reason,
    diagnostics: params.diagnostics ?? [],
    score: params.score ?? null,
    plannerReason: params.plannerReason ?? null,
    requiresDirectLoopFallback: false,
    action: "stop_and_request_plan_remediation",
  }, null, 2)
}

/**
 * Try to handle a task via the planner path.
 *
 * Returns { handled: true, answer } if the planner handled it,
 * or { handled: false, skipReason } if the task should go to the direct tool loop.
 *
 * Important: once a task is accepted into structured planning, unrepaired plan
 * validation failures are treated as terminal planner failures rather than
 * downgrading into the direct loop. Falling back after detecting an invalid
 * multi-step plan causes the exact overwrite regressions the validator exists
 * to prevent.
 *
 * @param options.forceRoute — skip routing assessment and force a specific planner
 *   route. Used by delay-commitment fallback when coherent generation fails.
 */
export async function executePlannerPath(
  goal: string,
  ctx: PlannerContext,
  delegateFn: DelegateFn,
  options?: { forceRoute?: "full_planner_decomposition" | "planner_with_coherent_bootstrap" },
): Promise<PlannerResult> {
  const MAX_PIPELINE_RETRIES = 2

  // Step 1: Should we plan?
  // When forceRoute is set (delay-commitment fallback from coherent failure),
  // skip the routing assessment and commit directly to the specified route.
  const decision = options?.forceRoute != null
    ? {
        shouldPlan: true,
        route: options.forceRoute,
        score: 10,
        reason: "coherent_generation_fallback_escalation",
        coherenceNeed: "high" as const,
        coordinationNeed: "medium" as const,
        routingConfidence: "lean_planner" as const,
        llmClassified: false,
      }
    : await assessPlannerDecision(goal, ctx.history, ctx.llm, ctx.signal)
  ctx.onTrace?.({
    kind: "planner-decision",
    score: decision.score,
    shouldPlan: decision.shouldPlan,
    route: decision.route,
    reason: decision.reason,
    coherenceNeed: decision.coherenceNeed,
    coordinationNeed: decision.coordinationNeed,
  })

  if (!decision.shouldPlan) {
    return { handled: false, skipReason: `route=${decision.route} score=${decision.score} (${decision.reason})` }
  }

  let coherentBootstrap: PlannerCoherentBootstrap | undefined
  if (decision.route === "planner_with_coherent_bootstrap") {
    const bootstrapResult = await generateCoherentBootstrap(ctx.llm, {
      goal,
      workspaceRoot: ctx.workspaceRoot,
      history: ctx.history,
    }, {
      signal: ctx.signal,
    })

    if (!bootstrapResult.bootstrap) {
      ctx.onTrace?.({
        kind: "planner-generation-failed",
        diagnostics: bootstrapResult.diagnostics,
      })
      const reason = `Planner bootstrap failed: ${bootstrapResult.diagnostics.map((d) => d.message).join("; ")}`
      return {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "generation",
          reason,
          diagnostics: bootstrapResult.diagnostics,
          score: decision.score,
          plannerReason: decision.reason,
        }),
        skipReason: reason,
      }
    }

    coherentBootstrap = bootstrapResult.bootstrap
    ctx.onTrace?.({
      kind: "planner-coherent-bootstrap",
      artifactCount: coherentBootstrap.artifacts.length,
      decompositionStrategy: coherentBootstrap.decompositionStrategy,
      decompositionReasons: [...coherentBootstrap.decompositionReasons],
      sharedContracts: coherentBootstrap.sharedContracts?.map((contract) => contract.name) ?? [],
      invariants: coherentBootstrap.invariants?.map((invariant) => invariant.id) ?? [],
    })
    ctx.onTrace?.({
      kind: "planner-architecture-state",
      lane: decision.route,
      status: "frozen",
      reason: "coherent_bootstrap_generated",
      architecture: coherentBootstrap.architecture,
    })
  }

  // Step 2: Generate plan
  ctx.onTrace?.({ kind: "planner-generating" })
  const genResult = await generatePlan(ctx.llm, {
    goal,
    availableTools: ctx.tools,
    workspaceRoot: ctx.workspaceRoot,
    history: ctx.history,
    route: decision.route,
    coherentBootstrap,
  }, {
    maxAttempts: 3,
    signal: ctx.signal,
  })

  if (!genResult.plan) {
    ctx.onTrace?.({
      kind: "planner-generation-failed",
      diagnostics: genResult.diagnostics,
    })
    const reason = `Plan generation failed: ${genResult.diagnostics.map(d => d.message).join("; ")}`
    return {
      handled: true,
      answer: buildPlannerFailurePayload({
        stage: "generation",
        reason,
        diagnostics: genResult.diagnostics,
        score: decision.score,
        plannerReason: decision.reason,
      }),
      skipReason: reason,
    }
  }

  const plan = genResult.plan

  const forcedOutputDir = inferForcedOutputDirectoryFromGoal(goal)
  if (forcedOutputDir) {
    normalizePlanOutputDirectory(plan, forcedOutputDir)
    ctx.onTrace?.({ kind: "planner-output-root-forced", outputRoot: forcedOutputDir })
  }

  ctx.onTrace?.({
    kind: "planner-plan-generated",
    reason: plan.reason,
    stepCount: plan.steps.length,
    steps: plan.steps.map(s => ({ name: s.name, type: s.stepType, dependsOn: s.dependsOn ? [...s.dependsOn] : undefined })),
    edges: plan.edges.map(e => ({ from: e.from, to: e.to })),
  })

  // Step 3: Validate plan
  let validation = validatePlan(plan, ctx.tools)
  let errors = validation.diagnostics.filter(d => d.severity === "error")
  let warnings = validation.diagnostics.filter(d => d.severity === "warning")

  if (!validation.valid) {
    const remediated = remediateValidationErrors(plan, errors)
    if (remediated) {
      const after = validatePlan(plan, ctx.tools)
      if (after.valid) {
        validation = after
        errors = validation.diagnostics.filter(d => d.severity === "error")
        warnings = validation.diagnostics.filter(d => d.severity === "warning")
        ctx.onTrace?.({ kind: "planner-validation-remediated", diagnostics: validation.diagnostics })
      }
    }
  }

  if (!validation.valid) {
    ctx.onTrace?.({
      kind: "planner-validation-failed",
      diagnostics: errors,
    })
    const reason = `Validation failed: ${errors.map(d => d.message).join("; ")}`
    return {
      handled: true,
      answer: buildPlannerFailurePayload({
        stage: "validation",
        reason,
        diagnostics: errors,
        score: decision.score,
        plannerReason: decision.reason,
      }),
      plan,
      skipReason: reason,
    }
  }

  // Always canonicalize output directory usage before execution.
  // This prevents late path mismatch failures caused by mixed bare-path
  // vs subdirectory artifacts across steps.
  normalizePlanOutputDirectory(plan, forcedOutputDir ?? undefined)

  // Inject warnings into step objectives as guidance (plan still runs)
  if (warnings.length > 0) {
    applyWarningAutoFixes(plan, warnings)
    ctx.onTrace?.({
      kind: "planner-validation-warnings",
      warningCount: warnings.length,
      diagnostics: warnings,
    })
    injectWarningsIntoSteps(plan, warnings)
  }

  // Global hardening: for multi-file JS plans, enforce one explicit shared
  // state owner and propagate a typed contract to all writer steps.
  injectSharedStateOwnershipContract(plan)
  injectBrowserRuntimeContracts(plan)
  injectHelperDependencyContracts(plan)
  injectVisualStyleContracts(plan)

  // Contract-First Architecture: auto-inject a blueprint step as step 0 for
  // multi-file projects. This step generates a BLUEPRINT.md with function
  // signatures, data types, and inter-file contracts that all implementation
  // steps must follow. This prevents Variable Drift across child agents.
  injectBlueprintStep(plan, ctx.workspaceRoot, forcedOutputDir)
  strengthenExistingBlueprintSteps(plan, ctx.workspaceRoot, forcedOutputDir)
  const runtimeModel = compilePlannerRuntime(plan)

  ctx.onTrace?.({
    kind: "planner-runtime-compiled",
    executionSteps: [...runtimeModel.executionGraph.values()].map((node) => ({
      stepName: node.stepName,
      dependsOn: [...node.dependsOn],
      downstream: [...node.downstream],
    })),
    ownershipArtifacts: [...runtimeModel.ownershipGraph.values()].map((node) => ({
      artifactPath: node.artifactPath,
      ownerStepName: node.ownerStepName,
      consumerStepNames: [...node.consumerStepNames],
    })),
    runtimeEntities: runtimeModel.runtimeEntities,
  })

  // Step 3b: Delegation decision gate — safety, economics, hard-block checks
  // Build step profiles for the delegation decision system
  const subagentSteps = plan.steps.filter(
    (s): s is PlanStep & { stepType: "subagent_task" } => s.stepType === "subagent_task",
  )
  const subagentProfiles: DelegationSubagentStepProfile[] = subagentSteps.map((s) => {
    // Map planner's EffectClass to delegation-decision's effectClass
    const effectMap: Record<string, "read_only" | "write" | "mixed"> = {
      readonly: "read_only",
      filesystem_write: "write",
      filesystem_scaffold: "write",
      shell: "mixed",
      mixed: "mixed",
    }
    return {
      name: s.name,
      objective: s.objective,
      dependsOn: s.dependsOn ? [...s.dependsOn] : undefined,
      acceptanceCriteria: [...s.acceptanceCriteria],
      requiredToolCapabilities: [...s.requiredToolCapabilities],
      canRunParallel: s.canRunParallel,
      effectClass: effectMap[s.executionContext.effectClass] ?? "mixed",
    }
  })

  if (subagentProfiles.length > 0) {
    const delegationInput: DelegationDecisionInput = {
      messageText: goal,
      plannerConfidence: decision.score / 10,
      complexityScore: decision.score,
      totalSteps: plan.steps.length,
      synthesisSteps: plan.steps.filter((s) => s.stepType === "deterministic_tool").length,
      subagentSteps: subagentProfiles,
      // When the planner already chose full_planner_decomposition, this IS an explicit
      // delegation decision — weight decompositionBenefit accordingly.
      explicitDelegationRequested: decision.route === "full_planner_decomposition",
    }

    const delegationDecision = assessDelegationDecision(delegationInput)

    ctx.onTrace?.({
      kind: "planner-delegation-decision",
      shouldDelegate: delegationDecision.shouldDelegate,
      reason: delegationDecision.reason,
      utilityScore: delegationDecision.utilityScore,
      safetyRisk: delegationDecision.safetyRisk,
      confidence: delegationDecision.confidence,
      hardBlockedTaskClass: delegationDecision.hardBlockedTaskClass,
    })

    if (!delegationDecision.shouldDelegate) {
      const reason = `Delegation blocked: ${delegationDecision.reason} (utility=${delegationDecision.utilityScore.toFixed(2)}, safety=${delegationDecision.safetyRisk.toFixed(2)})`
      return {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "delegation",
          reason,
          diagnostics: [{
            utilityScore: delegationDecision.utilityScore,
            safetyRisk: delegationDecision.safetyRisk,
            reason: delegationDecision.reason,
          }],
          score: decision.score,
          plannerReason: decision.reason,
        }),
        plan,
        skipReason: reason,
      }
    }
  }

  // Step 4: Execute pipeline with verifier loop (agenc-core pattern)
  // Track execution rounds and verifier rounds separately.
  // Verifier runs contract validation + deterministic probes each round.
  // Retry decisions are made by the escalation graph.
  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  const compatibilityMode = resolvePlannerCompatibilityMode()
  const compatibilityThreshold = resolvePlannerCompatibilityThreshold()
  let legacyPinnedForRun = compatibilityMode === "legacy"
  let retryOpts: {
    priorResults?: Map<string, import("./types.js").PipelineStepResult>
    repairPlan?: RepairPlan
  } = {}
  let verifierRounds = 0
  // Track issues per step across attempts to detect repeated identical failures
  const priorStepIssues = new Map<string, string>()
  // Track stub-issue count per step across attempts — if count doesn't decrease,
  // the child is stuck and further retries won't help
  const priorStubCounts = new Map<string, number>()
  // Repeated fatal failures should bypass additional retries and force replan.
  let forceReplanForFatalPattern = false

  // Pipeline budget tracking (planner/circuit-breaker) — monitor progress
  // across retry attempts and detect when further retries add no value
  let budgetState = createBudgetState(MAX_PIPELINE_RETRIES + 1, plan.steps.length)

  for (let attempt = 0; attempt <= MAX_PIPELINE_RETRIES; attempt++) {
    if (ctx.signal?.aborted) {
      return { handled: true, answer: "Planner was cancelled.", plan }
    }

    ctx.onTrace?.({
      kind: "planner-pipeline-start",
      attempt: attempt + 1,
      verifierRound: verifierRounds,
      maxRetries: MAX_PIPELINE_RETRIES + 1,
    })

    pipelineResult = await executePipeline(
      plan,
      ctx.tools as Tool[],
      delegateFn,
      {
        maxParallel: 4,
        workspaceRoot: ctx.workspaceRoot,
        priorResults: retryOpts.priorResults,
        repairPlan: retryOpts.repairPlan,
        runtimeModel,
        signal: ctx.signal,
        onStepStart: (step) => ctx.onTrace?.({
          kind: "planner-step-start",
          stepName: step.name,
          stepType: step.stepType,
        }),
        onStepEnd: (step, result) => {
          ctx.onTrace?.({
            kind: "planner-step-end",
            stepName: step.name,
            status: result.status,
            executionState: result.executionState,
            acceptanceState: result.acceptanceState,
            durationMs: result.durationMs,
            error: result.error,
            validationCode: result.validationCode,
            producedArtifacts: result.producedArtifacts,
            verificationAttempts: result.verificationAttempts,
            reconciliation: result.reconciliation
              ? {
                compliant: result.reconciliation.compliant,
                findings: result.reconciliation.findings.map((finding) => ({
                  code: finding.code,
                  severity: finding.severity,
                  message: finding.message,
                })),
              }
              : undefined,
          })
          ctx.onTrace?.({
            kind: "planner-step-transition",
            attempt: attempt + 1,
            stepName: step.name,
            phase: "execution",
            state: result.acceptanceState ?? result.status,
            timestamp: Date.now(),
          })
        },
      },
    )

    ctx.onTrace?.({
      kind: "planner-pipeline-end",
      status: pipelineResult.status,
      completedSteps: pipelineResult.completedSteps,
      totalSteps: pipelineResult.totalSteps,
    })

    // Update pipeline budget state — track progress for extension decisions
    const prevBudget = budgetState
    budgetState = maybeExtendBudget(budgetState, pipelineResult.completedSteps)
    if (budgetState.extensions > prevBudget.extensions) {
      ctx.onTrace?.({
        kind: "planner-budget-extended",
        completedSteps: pipelineResult.completedSteps,
        effectiveBudget: budgetState.effectiveBudget,
        extensions: budgetState.extensions,
      })
    }

    // Step 5: Verify
    verifierDecision = await verify(
      ctx.llm,
      plan,
      pipelineResult,
      ctx.tools as Tool[],
      { signal: ctx.signal, onTrace: ctx.onTrace },
    )
    const computedRepairPlan = buildRepairPlan(plan, pipelineResult, verifierDecision)
    verifierDecision = {
      ...verifierDecision,
      repairPlan: computedRepairPlan,
    }
    const legacyRetryPlan = buildLegacyRetryPlan(plan, pipelineResult, verifierDecision)
    const repairCompatibility = compareRepairPlanCompatibility(
      compatibilityMode,
      legacyRetryPlan,
      computedRepairPlan,
    )
    if (
      compatibilityMode === "shadow"
      && repairCompatibility.diverged
      && repairCompatibility.divergenceScore >= compatibilityThreshold
    ) {
      legacyPinnedForRun = true
    }
    const activeCompatibilityPath: "legacy" | "repair" = compatibilityMode === "repair"
      ? "repair"
      : legacyPinnedForRun
        ? "legacy"
        : "repair"
    pipelineResult = applyVerificationAcceptanceStates(pipelineResult, verifierDecision)

    ctx.onTrace?.({
      kind: "planner-verification",
      overall: verifierDecision.overall,
      confidence: verifierDecision.confidence,
      verifierRound: verifierRounds + 1,
      systemChecks: verifierDecision.systemChecks?.map((check) => ({
        code: check.code,
        severity: check.severity,
        summary: check.summary,
        confidence: check.confidence,
      })),
      steps: verifierDecision.steps.map(s => ({
        stepName: s.stepName,
        outcome: s.outcome,
        issues: s.issues,
        issueCodes: s.issueDetails?.map(issue => issue.code) ?? [],
        ownershipModes: s.issueDetails?.map(issue => issue.ownershipMode) ?? [],
        issueConfidences: s.issueDetails?.map(issue => issue.confidence) ?? [],
        acceptanceState: pipelineResult?.stepResults.get(s.stepName)?.acceptanceState,
      })),
    })
    if (plan.coherentBootstrap) {
      ctx.onTrace?.({
        kind: "planner-architecture-state",
        lane: plan.route ?? decision.route,
        status: verifierDecision.overall === "pass" ? "preserved" : "repairing_in_place",
        reason: verifierDecision.overall === "pass" ? "verification_passed" : "architecture_preserving_repair",
        architecture: plan.coherentBootstrap.architecture,
      })
    }
    ctx.onTrace?.({
      kind: "planner-issue-timeline",
      attempt: attempt + 1,
      verifierRound: verifierRounds + 1,
      issues: verifierDecision.steps.flatMap((step) => (step.issueDetails ?? []).map((issue) => ({
        stepName: step.stepName,
        code: issue.code,
        confidence: issue.confidence,
        ownershipMode: issue.ownershipMode,
        primaryOwner: issue.primaryOwner,
        suspectedOwners: [...issue.suspectedOwners],
      }))),
    })
    for (const step of verifierDecision.steps) {
      ctx.onTrace?.({
        kind: "planner-step-transition",
        attempt: attempt + 1,
        stepName: step.stepName,
        phase: "verification",
        state: pipelineResult?.stepResults.get(step.stepName)?.acceptanceState ?? step.outcome,
        timestamp: Date.now(),
      })
    }
    ctx.onTrace?.({
      kind: "planner-repair-plan",
      attempt: attempt + 1,
      epoch: attempt + 1,
      rerunOrder: verifierDecision.repairPlan?.rerunOrder ?? [],
      tasks: verifierDecision.repairPlan?.tasks.map(task => ({
        stepName: task.stepName,
        mode: task.mode,
        ownedIssueCodes: task.ownedIssues.map(issue => issue.code),
        dependencyIssueCodes: task.dependencyContext.map(issue => issue.code),
      })) ?? [],
    })
    ctx.onTrace?.({
      kind: "planner-repair-compatibility",
      attempt: attempt + 1,
      mode: repairCompatibility.mode,
      activePath: activeCompatibilityPath,
      diverged: repairCompatibility.diverged,
      divergenceScore: repairCompatibility.divergenceScore,
      divergenceThreshold: compatibilityThreshold,
      pinnedToLegacy: compatibilityMode === "shadow" && legacyPinnedForRun,
      reasons: [...repairCompatibility.reasons],
      legacy: {
        rerunOrder: repairCompatibility.legacyPlan.rerunOrder,
        tasks: repairCompatibility.legacyPlan.tasks.map((task) => ({
          stepName: task.stepName,
          mode: task.mode,
          ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
        })),
      },
      repair: {
        rerunOrder: repairCompatibility.repairPlan.rerunOrder,
        tasks: repairCompatibility.repairPlan.tasks.map((task) => ({
          stepName: task.stepName,
          mode: task.mode,
          ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
          dependencyIssueCodes: task.dependencyContext.map((issue) => issue.code),
        })),
      },
    })

    verifierRounds++

    if (verifierDecision.overall === "pass") {
      break
    }

    // agenc-core pattern: strict retry gating via escalation graph.
    // The escalation graph is a pure deterministic function that maps
    // the current state to a next action: pass/retry/revise/escalate.
    const hasRetryableSteps = verifierDecision.steps.some(
      s => s.outcome !== "pass" && s.retryable !== false,
    )

    // Pre-compute: detect repeated identical failures for escalation input
    let prelimAllStepsRepeatedFailure = true
    for (const stepAssessment of verifierDecision.steps) {
      if (stepAssessment.outcome === "pass") continue
      const issueKey = buildIssueIdentity(stepAssessment)
      if (priorStepIssues.get(stepAssessment.stepName) !== issueKey) {
        prelimAllStepsRepeatedFailure = false
        break
      }
    }

    const escalation: EscalationDecision = resolveEscalation(buildEscalationInput({
      verifierOverall: verifierDecision.overall,
      attempt,
      maxAttempts: MAX_PIPELINE_RETRIES + 1,
      hasRetryableSteps,
      allStepsRepeatedFailure: prelimAllStepsRepeatedFailure,
    }))

    ctx.onTrace?.({
      kind: "planner-escalation",
      action: escalation.action,
      reason: escalation.reason,
      attempt: attempt + 1,
    })

    if (plan.coherentBootstrap && escalation.action === "escalate") {
      ctx.onTrace?.({
        kind: "planner-architecture-state",
        lane: plan.route ?? decision.route,
        status: "abandoned",
        reason: escalation.reason,
        architecture: plan.coherentBootstrap.architecture,
      })
    }

    if (escalation.action === "pass" || escalation.action === "escalate") {
      break
    }

    // Build targeted retry context from verifier feedback
    const priorResults = new Map<string, import("./types.js").PipelineStepResult>()
    const NON_RETRYABLE_CLASSES = new Set(["cancelled", "spawn_error"])
    const currentRepairPlan = verifierDecision.repairPlan ?? buildRepairPlan(plan, pipelineResult, verifierDecision)
    const activeRepairPlan = activeCompatibilityPath === "legacy"
      ? {
        tasks: legacyRetryPlan.tasks,
        rerunOrder: legacyRetryPlan.rerunOrder,
        skippedVerifiedSteps: legacyRetryPlan.skippedVerifiedSteps,
      }
      : currentRepairPlan

    // Detect repeated identical failures — if a step produces the same issues
    // as the previous attempt, further retries won't help (LLM is stuck).
    let allStepsRepeatedFailure = true
    let shouldAbortRetriesForFatalPattern = false

    // ── Stub-count regression tracking ──
    // Track the number of stub-related issues per step across retries.
    // If a retry doesn't reduce the stub count, the child is stuck — abort.
    const STUB_KEYWORDS = ["stub", "placeholder", "empty array", "empty object", "returns constant", "catch-all", "trivial return", "empty function"]

    for (const stepAssessment of verifierDecision.steps) {
      const stepResult = pipelineResult.stepResults.get(stepAssessment.stepName)

      // Check if this step's issues are identical to the previous attempt
      const issueKey = buildIssueIdentity(stepAssessment)
      const prevIssueKey = priorStepIssues.get(stepAssessment.stepName)

      // Count stub-specific issues for regression tracking
      const currentStubCount = stepAssessment.issues.filter(i =>
        STUB_KEYWORDS.some(kw => i.toLowerCase().includes(kw)),
      ).length
      const prevStubCount = priorStubCounts.get(stepAssessment.stepName)
      const hasFatalPattern = stepAssessment.issues.some(i =>
        /function loss|\[contract:contradictory_completion_claim\]|\[contract:unresolved_handoff_output\]/i.test(i),
      )

      if (stepAssessment.outcome === "pass" && stepResult) {
        priorResults.set(stepAssessment.stepName, stepResult)
        priorStepIssues.delete(stepAssessment.stepName)
        priorStubCounts.delete(stepAssessment.stepName)
      } else if (stepResult?.failureClass && NON_RETRYABLE_CLASSES.has(stepResult.failureClass)) {
        priorResults.set(stepAssessment.stepName, stepResult)
      } else if (stepAssessment.issues.length > 0) {
        // Check for repeated failure OR stub-count not improving
        const isExactRepeat = prevIssueKey === issueKey
        const stubsNotImproving = prevStubCount !== undefined && currentStubCount >= prevStubCount && currentStubCount > 0

        if (isExactRepeat || stubsNotImproving) {
          ctx.onTrace?.({
            kind: "planner-retry-skip",
            stepName: stepAssessment.stepName,
            reason: isExactRepeat
              ? "Repeated identical failure — further retries won't help"
              : `Stub count not improving (${prevStubCount} → ${currentStubCount}) — child is stuck`,
          })
          if (stepResult) {
            priorResults.set(stepAssessment.stepName, stepResult)
          }
        } else {
          allStepsRepeatedFailure = false
        }

        if (hasFatalPattern && isExactRepeat) {
          shouldAbortRetriesForFatalPattern = true
          forceReplanForFatalPattern = true
          ctx.onTrace?.({
            kind: "planner-retry-abort",
            stepName: stepAssessment.stepName,
            reason: "Repeated fatal pattern detected (FUNCTION LOSS / contradictory completion claim) — aborting retries and forcing replan",
          })
        }

        priorStepIssues.set(stepAssessment.stepName, issueKey)
        priorStubCounts.set(stepAssessment.stepName, currentStubCount)
      } else {
        allStepsRepeatedFailure = false
      }
    }

    // If every failing step has repeated identical issues, stop retrying entirely
    const retryableTaskCount = activeRepairPlan.tasks.filter((task) => task.mode !== "blocked").length
    if (allStepsRepeatedFailure && retryableTaskCount === 0) {
      ctx.onTrace?.({
        kind: "planner-retry-abort",
        reason: "All failing steps have repeated identical issues — aborting retries",
      })
      break
    }

    if (shouldAbortRetriesForFatalPattern) {
      break
    }

    ctx.onTrace?.({
      kind: "planner-retry",
      attempt: attempt + 1,
      reason: verifierDecision.unresolvedItems.join("; "),
      skippedSteps: priorResults.size,
      retrySteps: retryableTaskCount,
      rerunOrder: activeRepairPlan.rerunOrder,
    })
    for (const task of activeRepairPlan.tasks) {
      ctx.onTrace?.({
        kind: "planner-step-transition",
        attempt: attempt + 1,
        stepName: task.stepName,
        phase: "repair",
        state: task.mode,
        timestamp: Date.now(),
      })
    }

    // Store retry context for next iteration
    retryOpts = { priorResults, repairPlan: activeRepairPlan }
  }

  // Step 6: Synthesize final answer
  if (forceReplanForFatalPattern) {
    ctx.onTrace?.({
      kind: "planner-escalation",
      action: "escalate",
      reason: "Forced replan after repeated fatal FUNCTION LOSS / contradictory completion pattern",
    })
  }

  const answer = synthesizeAnswer(plan, pipelineResult!, verifierDecision!)

  // Contract-governed-first behavior: if verification didn't pass after all
  // retries, DO NOT fall through to the unstructured direct tool loop.
  // Return a structured failure response and keep remediation in planner mode.
  if (verifierDecision!.overall !== "pass") {
    return {
      handled: true,
      answer,
      plan,
      pipelineResult,
      verifierDecision,
      skipReason: "Verification failed after retries — structured execution halted",
    }
  }

  return {
    handled: true,
    answer,
    plan,
    pipelineResult,
    verifierDecision,
  }
}

// ============================================================================
// Answer synthesis
// ============================================================================

export function synthesizeAnswer(
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
): string {
  const parts: string[] = []

  if (verifierDecision.overall === "pass") {
    parts.push("All tasks completed and verified successfully.")
  } else if (verifierDecision.overall === "retry") {
    parts.push("Task verification FAILED — the following issues remain unresolved after all retry attempts:")
  } else {
    parts.push("Task FAILED — critical errors prevented completion:")
  }

  parts.push("")
  parts.push(`Plan: ${plan.reason}`)
  parts.push(`Steps: ${pipelineResult.completedSteps}/${pipelineResult.totalSteps} completed`)
  parts.push("")

  for (const step of plan.steps) {
    const result = pipelineResult.stepResults.get(step.name)
    const stepVerification = verifierDecision.steps.find(s => s.stepName === step.name)
    const acceptanceState = result?.acceptanceState
    const effectiveAcceptance = acceptanceState
      ?? (stepVerification?.outcome === "pass"
        ? "accepted"
        : stepVerification?.outcome === "retry" || stepVerification?.outcome === "fail"
          ? "repair_required"
          : undefined)
    const status = effectiveAcceptance === "accepted"
      ? "verified"
      : effectiveAcceptance === "repair_required"
        ? "incomplete"
        : effectiveAcceptance === "rejected"
          ? "rejected"
          : (result?.status ?? "unknown")
    const icon = effectiveAcceptance === "accepted"
      ? "✓"
      : effectiveAcceptance === "repair_required"
        ? "⚠"
        : status === "failed" || effectiveAcceptance === "rejected"
          ? "✗"
          : "⊘"
    parts.push(`${icon} ${step.name} (${step.stepType}): ${status}`)

    // Include output summary for completed subagent tasks
    if (result?.output && step.stepType === "subagent_task") {
      const summary = result.output.slice(0, 200)
      parts.push(`  → ${summary}${result.output.length > 200 ? "..." : ""}`)
    }

    // Include errors for failed steps
    if (result?.error) {
      parts.push(`  ⚠ ${result.error.slice(0, 200)}`)
    }

    // Include verifier issues
    if (stepVerification && stepVerification.issues.length > 0) {
      for (const issue of stepVerification.issues) {
        parts.push(`  ! ${issue}`)
      }
    }
  }

  if (verifierDecision.repairPlan && verifierDecision.repairPlan.tasks.length > 0) {
    parts.push("")
    parts.push("Repair Plan:")
    for (const task of verifierDecision.repairPlan.tasks) {
      parts.push(`  - ${task.stepName}: ${task.mode}`)
    }
  }

  if (verifierDecision.unresolvedItems.length > 0) {
    parts.push("")
    parts.push("Unresolved:")
    for (const item of verifierDecision.unresolvedItems) {
      parts.push(`  - ${item}`)
    }
  }

  return parts.join("\n")
}

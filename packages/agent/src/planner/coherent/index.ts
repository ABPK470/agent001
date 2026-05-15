import { EffectClass, PipelineStatus, StepRole, VerificationMode } from "@mia/agent"
import { applyPromptBudget } from "../../context/prompt-budget/index.js"
import { MessageRole } from "../../domain/enums/message.js"
import { canonicalizeRelative } from "../../internal/index.js"
import type { ToolCallRecord } from "../../recovery/index.js"
import type { Message } from "../../types.js"
import {
    asNonEmptyString,
    COHERENT_GENERATION_PROMPT,
    parseArtifacts,
    parseEdges,
    parseInvariants,
    parseJsonObject,
    parseSharedContracts,
} from "../internal/coherent-parse.js"
import type {
    ArtifactRelation,
    CoherentSolutionArtifact,
    CoherentSolutionBundle,
    PipelineResult,
    PipelineStepResult,
    Plan
} from "../types.js"

export interface CoherentBundleParseResult {
  readonly bundle: CoherentSolutionBundle | null
  readonly diagnostics: readonly string[]
}

export { materializeCoherentSolutionBundle } from "./materialize.js"
export type { CoherentMaterializationResult } from "./materialize.js"

const COHERENT_STEP_NAME = "coherent_bundle"

function normalizeArtifactPath(path: string): string {
  return canonicalizeRelative(path).trim()
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

function isArtifactScopedToolCall(record: ToolCallRecord, artifactPaths: ReadonlySet<string>): boolean {
  const pathValue = typeof record.args.path === "string" ? normalizeArtifactPath(record.args.path) : null
  if (pathValue && artifactPaths.has(pathValue)) return true

  const commandValue = typeof record.args.command === "string" ? record.args.command : null
  if (!commandValue) return false
  for (const artifactPath of artifactPaths) {
    if (commandValue.includes(artifactPath)) return true
  }
  return false
}

function buildArtifactRelations(artifacts: readonly CoherentSolutionArtifact[]): ArtifactRelation[] {
  return artifacts.map((artifact) => ({
    relationType: "write_owner",
    artifactPath: artifact.path,
  }))
}

export function buildCoherentGenerationMessages(
  goal: string,
  workspaceRoot: string,
  history: readonly Message[],
): Message[] {
  // Keep anchor/persona system messages only.
  //
  // Stripped sections:
  //   - "Workspace:" directory listing → LLM writes into host repo src tree instead of fresh dir
  //   - system_runtime sections (tool context, DB schema, environment context) → irrelevant for
  //     code generation; the DB schema context alone can be 100K+ chars and causes 422 errors
  //     on the no-tool coherent generation call when the context budget is exceeded.
  //   - memory_* sections (episodic, semantic, working) → prior DB query runs are noise for
  //     fresh code generation tasks
  //
  // Retained: system_anchor (base prompt + ABI sync stub if injected) — gives the LLM its
  // persona, output format rules, and file-editing conventions which are always relevant.
  const baseSystemMessages = history.filter(
    (message) => {
      if (message.role !== "system") return false
      const content = message.content ?? ""
      // Strip workspace directory listing
      if (content.trimStart().startsWith("Workspace:")) return false
      // Strip memory tiers (all noisy for code gen)
      if (content.trimStart().startsWith("<working_memory>")) return false
      if (content.trimStart().startsWith("<episodic_memory>")) return false
      if (content.trimStart().startsWith("<semantic_memory>")) return false
      // Strip large runtime sections (DB schema, tool context, env context)
      // identified by their section tag or by being suspiciously large (>8K chars)
      // and containing database-specific keywords.
      const section = (message as { section?: string }).section
      if (section === "system_runtime") {
        // Keep small runtime messages (e.g. the ABI sync stub line is ~200 chars)
        // but drop large ones (DB schema context, tool orchestration docs, etc.)
        if (content.length > 4000) return false
      }
      return true
    },
  )
  return [
    ...baseSystemMessages,
    { role: MessageRole.System, content: COHERENT_GENERATION_PROMPT, section: "system_runtime" },
    {
      role: MessageRole.User,
      content:
        `Workspace root: ${workspaceRoot}\n` +
        `Goal: ${goal}\n\n` +
        "Produce a coherent multi-file solution bundle that can be materialized directly.",
      section: "user",
    },
  ]
}

/**
 * Coherent-generation prompt budget cap (Gap 10). Coherent generation
 * historically bypassed `applyPromptBudget` and relied solely on the
 * static history filter above — when the retained anchor messages
 * still totalled >100K chars the LLM would 422 with a context overrun.
 * 32K tokens (~128K chars at 4cpt) leaves comfortable headroom for the
 * generated bundle on a 200K-context model.
 */
const MAX_COHERENT_TOKENS = 32_000

/**
 * Apply the prompt budget to a freshly-built coherent message array.
 * Public so call-sites (`runCoherentPipeline`, planner, etc.) can wrap
 * their own message arrays without re-implementing the cap.
 */
export function applyCoherentPromptBudget(messages: Message[], modelHint?: string): Message[] {
  const result = applyPromptBudget(messages, {
    contextWindowTokens: MAX_COHERENT_TOKENS + 4096,
    maxOutputTokens: 4096,
    model: modelHint,
  })
  return result.messages.length > 0 ? result.messages : messages
}

export function parseCoherentSolutionBundle(raw: string): CoherentBundleParseResult {
  const diagnostics: string[] = []
  const parsed = parseJsonObject(raw)
  if (!parsed) {
    return {
      bundle: null,
      diagnostics: ["Coherent generation response is not valid JSON."],
    }
  }

  const summary = asNonEmptyString(parsed.summary)
  const architecture = asNonEmptyString(parsed.architecture)
  if (!summary) diagnostics.push("Bundle must include a non-empty summary.")
  if (!architecture) diagnostics.push("Bundle must include a non-empty architecture description.")

  const artifacts = parseArtifacts(parsed.artifacts, diagnostics)
  if (diagnostics.length > 0 || !summary || !architecture) {
    return { bundle: null, diagnostics }
  }

  return {
    bundle: {
      summary,
      architecture,
      artifacts,
      dependencyEdges: parseEdges(parsed.dependencyEdges),
      sharedContracts: parseSharedContracts(parsed.sharedContracts),
      invariants: parseInvariants(parsed.invariants),
    },
    diagnostics,
  }
}

export function buildCoherentVerificationPlan(
  bundle: CoherentSolutionBundle,
  workspaceRoot: string,
): Plan {
  const artifactRelations = buildArtifactRelations(bundle.artifacts)
  const acceptanceCriteria = uniqueStrings([
    "Every declared artifact exists at the exact planned path with non-placeholder content.",
    ...bundle.sharedContracts?.map((contract) => `Preserve shared contract ${contract.name}: ${contract.description}`) ?? [],
    ...bundle.invariants?.map((invariant) => `Preserve invariant ${invariant.id}: ${invariant.description}`) ?? [],
  ])

  return {
    reason: `Coherent bundle verification for ${bundle.summary}`,
    confidence: 0.88,
    requiresSynthesis: false,
    edges: [],
    steps: [
      {
        name: COHERENT_STEP_NAME,
        stepType: "subagent_task",
        objective: `Materialize and preserve the coherent bundle architecture: ${bundle.architecture}`,
        inputContract: bundle.summary,
        acceptanceCriteria,
        requiredToolCapabilities: ["read_file", "browser_check", "run_command", "write_file", "replace_in_file"],
        contextRequirements: [
          `Architecture: ${bundle.architecture}`,
          `Artifacts: ${bundle.artifacts.map((artifact) => artifact.path).join(", ")}`,
        ],
        executionContext: {
          workspaceRoot,
          allowedReadRoots: [workspaceRoot],
          allowedWriteRoots: [workspaceRoot],
          allowedTools: ["read_file", "browser_check", "run_command", "write_file", "replace_in_file"],
          requiredSourceArtifacts: [],
          targetArtifacts: bundle.artifacts.map((artifact) => artifact.path),
          effectClass: EffectClass.FilesystemWrite,
          verificationMode: VerificationMode.DeterministicFollowup,
          artifactRelations,
          role: StepRole.Writer,
          forbiddenArtifacts: [],
          requiredChecks: ["read_file"],
        },
        maxBudgetHint: "coherent_bundle_repair",
        canRunParallel: false,
        workflowStep: {
          role: StepRole.Writer,
          artifactRelations,
        },
      },
    ],
  }
}

export function buildCoherentVerificationPipelineResult(
  bundle: CoherentSolutionBundle,
  toolCalls: readonly ToolCallRecord[],
): PipelineResult {
  const artifactPathSet = new Set(bundle.artifacts.map((artifact) => normalizeArtifactPath(artifact.path)))
  const relevantToolCalls = toolCalls.filter((record) => isArtifactScopedToolCall(record, artifactPathSet))
  const writeSummaries = relevantToolCalls
    .filter((record) => record.name === "write_file" || record.name === "replace_in_file" || record.name === "append_file")
    .map((record) => {
      const path = typeof record.args.path === "string" ? String(record.args.path) : "unknown"
      return `Successfully wrote to \`${path}\``
    })
  const readSummaries = relevantToolCalls
    .filter((record) => record.name === "read_file")
    .map((record) => {
      const path = typeof record.args.path === "string" ? String(record.args.path) : "unknown"
      return `Reviewed artifact \`${path}\``
    })
  const verificationAttempts = relevantToolCalls
    .filter((record) => record.name === "read_file" || record.name === "browser_check" || record.name === "run_command")
    .map((record) => ({
      toolName: record.name,
      target: typeof record.args.path === "string" ? String(record.args.path) : undefined,
      success: !record.isError,
      summary: record.result,
    }))

  const stepResult: PipelineStepResult = {
    name: COHERENT_STEP_NAME,
    status: "completed",
    executionState: "executed",
    acceptanceState: "pending_verification",
    output: [
      "Coherent bundle materialized for verification.",
      ...writeSummaries,
      ...readSummaries,
      `Architecture: ${bundle.architecture}`,
      `Artifacts: ${bundle.artifacts.map((artifact) => `\`${artifact.path}\``).join(", ")}`,
    ].join("\n"),
    durationMs: 0,
    toolCalls: relevantToolCalls,
    producedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
    modifiedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
    verificationAttempts,
    childResult: {
      status: relevantToolCalls.some((record) => record.isError) ? "failed" : "success",
      summary: bundle.summary,
      producedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
      modifiedArtifacts: bundle.artifacts.map((artifact) => artifact.path),
      verificationAttempts,
      unresolvedBlockers: [],
    },
  }

  return {
    status: PipelineStatus.Completed,
    stepResults: new Map([[COHERENT_STEP_NAME, stepResult]]),
    completedSteps: 1,
    totalSteps: 1,
  }
}

export {
    buildCoherentPlannerEscalationGoal,
    buildCoherentRepairInstructions,
    summarizeCoherentVerifierDecision
} from "./repair-instructions.js"

// materializeCoherentSolutionBundle moved to ./coherent/materialize.ts
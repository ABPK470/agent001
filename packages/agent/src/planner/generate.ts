/**
 * Plan generation — ask the LLM to decompose a complex task into a structured plan.
 *
 * The LLM is called in "planner mode" with a special system prompt that instructs
 * it to output a JSON plan with deterministic_tool and subagent_task steps.
 *
 * Inspired by agenc-core's buildPlannerMessages + parsePlannerPlan.
 *
 * @module
 */

import type { LLMClient, Message, Tool } from "../types.js"
import { parsePlanFromResponse } from "./generate-parse.js"
import {
    asNonEmptyString,
    COHERENT_BOOTSTRAP_SYSTEM_PROMPT,
    parseBootstrapArtifacts,
    parseBootstrapContracts,
    parseBootstrapEdges,
    parseBootstrapInvariants,
    parseJsonObject,
    PLANNER_SYSTEM_PROMPT,
} from "./generate-prompts.js"
import type { Plan, PlanDiagnostic, PlannerCoherentBootstrap, PlannerRoute, PlanStep, SubagentTaskStep } from "./types.js"

export { isValidArtifactPath } from "./generate-parse.js"

// ============================================================================
// Plan generation
// ============================================================================

export interface PlanGenerationContext {
  /** The user's original task/goal. */
  readonly goal: string
  /** Available tools the children can use. */
  readonly availableTools: readonly Tool[]
  /** Current working directory / workspace root. */
  readonly workspaceRoot: string
  /** Conversation history for context. */
  readonly history: readonly Message[]
  /** The planner route selected by the router. */
  readonly route?: PlannerRoute
  /** Frozen architecture contract for bootstrap-guided planner runs. */
  readonly coherentBootstrap?: PlannerCoherentBootstrap
}

export interface CoherentBootstrapGenerationResult {
  readonly bootstrap: PlannerCoherentBootstrap | null
  readonly diagnostics: readonly PlanDiagnostic[]
  readonly rawResponse: string | null
}

export interface PlanGenerationResult {
  readonly plan: Plan | null
  readonly diagnostics: readonly PlanDiagnostic[]
  /** Raw LLM response for debugging. */
  readonly rawResponse: string | null
}

export async function generateCoherentBootstrap(
  llm: LLMClient,
  ctx: Pick<PlanGenerationContext, "goal" | "workspaceRoot" | "history">,
  opts?: { signal?: AbortSignal },
): Promise<CoherentBootstrapGenerationResult> {
  const messages: Message[] = [
    { role: "system", content: COHERENT_BOOTSTRAP_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Workspace root: ${ctx.workspaceRoot}\nFreeze architecture, contracts, and invariants before decomposition.`,
    },
    {
      role: "user",
      content: `Goal: ${ctx.goal}\n\nReturn the frozen architecture bootstrap JSON.`,
    },
  ]

  const recentHistory = ctx.history.slice(-10).filter((m) => m.role === "user" || m.role === "assistant")
  if (recentHistory.length > 0) {
    messages.splice(2, 0, {
      role: "system",
      content: `Recent conversation context:\n${recentHistory.map((m) => `[${m.role}]: ${(m.content ?? "").slice(0, 500)}`).join("\n")}`,
    })
  }

  let rawResponse: string | null = null
  try {
    const response = await llm.chat(messages, [], { signal: opts?.signal, temperature: 0 })
    rawResponse = response.content
    if (!rawResponse) {
      return {
        bootstrap: null,
        rawResponse,
        diagnostics: [{ category: "parse", severity: "error", code: "empty_bootstrap_response", message: "Planner bootstrap returned empty response" }],
      }
    }

    const parsed = parseJsonObject(rawResponse)
    if (!parsed) {
      return {
        bootstrap: null,
        rawResponse,
        diagnostics: [{ category: "parse", severity: "error", code: "invalid_bootstrap_json", message: "Planner bootstrap response is not valid JSON" }],
      }
    }

    const summary = asNonEmptyString(parsed.summary)
    const architecture = asNonEmptyString(parsed.architecture)
    const artifacts = parseBootstrapArtifacts(parsed.artifacts)
    const decompositionStrategy = parsed.decompositionStrategy === "decompose_by_ownership"
      ? "decompose_by_ownership"
      : "preserve_coherence"
    const decompositionReasons = Array.isArray(parsed.decompositionReasons)
      ? parsed.decompositionReasons.map((value) => asNonEmptyString(value)).filter((value): value is string => value != null)
      : []

    if (!summary || !architecture || artifacts.length === 0) {
      return {
        bootstrap: null,
        rawResponse,
        diagnostics: [{ category: "parse", severity: "error", code: "invalid_bootstrap_shape", message: "Planner bootstrap must include summary, architecture, and at least one artifact" }],
      }
    }

    return {
      bootstrap: {
        summary,
        architecture,
        artifacts,
        dependencyEdges: parseBootstrapEdges(parsed.dependencyEdges),
        sharedContracts: parseBootstrapContracts(parsed.sharedContracts),
        invariants: parseBootstrapInvariants(parsed.invariants),
        decompositionStrategy,
        decompositionReasons,
      },
      rawResponse,
      diagnostics: [],
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      bootstrap: null,
      rawResponse,
      diagnostics: [{ category: "parse", severity: "error", code: "bootstrap_llm_error", message: `Planner bootstrap failed: ${errMsg}` }],
    }
  }
}

/**
 * Ask the LLM to generate a structured execution plan for a complex task.
 *
 * Returns the parsed plan or diagnostics explaining why parsing failed.
 * Supports up to `maxAttempts` refinement passes if the plan is invalid.
 */
export async function generatePlan(
  llm: LLMClient,
  ctx: PlanGenerationContext,
  opts?: { maxAttempts?: number; signal?: AbortSignal },
): Promise<PlanGenerationResult> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const diagnostics: PlanDiagnostic[] = []
  let refinementHint: string | null = null

  const toolDescriptions = ctx.availableTools
    .filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n")

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages: Message[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "system",
        content: `Available tools for children:\n${toolDescriptions}\n\nWorkspace root: ${ctx.workspaceRoot}`,
      },
    ]

    // Add recent history for context (limit to last 10 messages)
    const recentHistory = ctx.history.slice(-10).filter(
      m => m.role === "user" || m.role === "assistant",
    )
    if (recentHistory.length > 0) {
      messages.push({
        role: "system",
        content: `Recent conversation context:\n${recentHistory.map(m => `[${m.role}]: ${(m.content ?? "").slice(0, 500)}`).join("\n")}`,
      })
    }

    if (ctx.coherentBootstrap) {
      messages.push({
        role: "system",
        content:
          `Frozen architecture bootstrap:\n` +
          `Summary: ${ctx.coherentBootstrap.summary}\n` +
          `Architecture: ${ctx.coherentBootstrap.architecture}\n` +
          `Decomposition strategy: ${ctx.coherentBootstrap.decompositionStrategy}\n` +
          `Artifacts:\n${ctx.coherentBootstrap.artifacts.map((artifact) => `- ${artifact.path}: ${artifact.purpose}`).join("\n")}\n` +
          `Shared contracts:\n${ctx.coherentBootstrap.sharedContracts?.map((contract) => `- ${contract.name}: ${contract.description}`).join("\n") || "- none"}\n` +
          `Invariants:\n${ctx.coherentBootstrap.invariants?.map((invariant) => `- ${invariant.id}: ${invariant.description}`).join("\n") || "- none"}\n` +
          `Rules: preserve this architecture unless ownership separation is real. Do not decompose multi-file greenfield work automatically.`,
      })
    }

    if (ctx.route === "planner_with_coherent_bootstrap") {
      messages.push({
        role: "system",
        content: "This is a planner_with_coherent_bootstrap run. First honor the frozen architecture, then decompose only when there are real ownership boundaries and overwrite-risk reductions.",
      })
    }

    // Add refinement hint from previous failed attempt
    if (refinementHint) {
      messages.push({
        role: "system",
        content: `REFINEMENT REQUIRED: Your previous plan had issues. Fix them:\n${refinementHint}`,
      })
    }

    messages.push({ role: "user", content: ctx.goal })

    let rawResponse: string | null = null
    try {
      const response = await llm.chat(messages, [], { signal: opts?.signal, temperature: 0 })
      rawResponse = response.content

      if (!rawResponse) {
        diagnostics.push({
          category: "parse", severity: "error",
          code: "empty_response",
          message: "Planner returned empty response",
          details: { attempt },
        })
        refinementHint = "You returned an empty response. Respond with a valid JSON plan object."
        continue
      }

      // Parse the JSON plan
      const parsed = parsePlanFromResponse(rawResponse)
      if (!parsed.plan) {
        // agenc-core pattern: attempt to salvage a plan from partial/malformed response
        const salvaged = salvagePlanFromMalformedResponse(rawResponse, ctx.workspaceRoot)
        if (salvaged) {
          diagnostics.push({
            category: "parse", severity: "error",
            code: "salvaged_from_malformed",
            message: "Plan was salvaged from malformed planner response",
            details: { attempt },
          })
          return { plan: normalizeWorkspaceRoots(salvaged, ctx.workspaceRoot), diagnostics, rawResponse }
        }

        diagnostics.push(...parsed.diagnostics)
        refinementHint = parsed.diagnostics.map(d => d.message).join("\n")
        continue
      }

      // Post-process: normalize workspaceRoot in all execution contexts
      // to match the actual workspace root (don't trust LLM-generated paths)
      const normalizedPlan = normalizeWorkspaceRoots(parsed.plan, ctx.workspaceRoot)

      return {
        plan: {
          ...normalizedPlan,
          route: ctx.route,
          coherentBootstrap: ctx.coherentBootstrap,
        },
        diagnostics,
        rawResponse,
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      diagnostics.push({
        category: "parse", severity: "error",
        code: "llm_error",
        message: `LLM call failed: ${errMsg}`,
        details: { attempt },
      })

      // Abort errors should not be retried
      if (opts?.signal?.aborted || errMsg.includes("abort")) {
        return { plan: null, diagnostics, rawResponse }
      }

      // Transient network errors (fetch failed, timeout, etc.) — retry
      const isTransient = /fetch failed|timeout|timed out|econnreset|econnrefused|socket hang up|network|429|502|503/i.test(errMsg)
      if (!isTransient) {
        return { plan: null, diagnostics, rawResponse }
      }
      // Let loop continue to next attempt
      refinementHint = null
    }
  }

  return { plan: null, diagnostics, rawResponse: null }
}

// ============================================================================
// Workspace root normalization
// ============================================================================

/**
 * Override LLM-generated workspaceRoot values in all execution contexts
 * with the actual workspace root. The LLM often gets paths wrong (uses ".",
 * relative paths, or host paths that don't match the container).
 */
function normalizeWorkspaceRoots(plan: Plan, actualRoot: string): Plan {
  const normalizedSteps: PlanStep[] = plan.steps.map(step => {
    if (step.stepType !== "subagent_task") return step

    const sa = step as SubagentTaskStep
    // Strip trailing slashes to prevent double-prefixing (e.g. "tmp/" + "/" + "tmp/file" → "tmp//tmp/file")
    const originalRoot = sa.executionContext.workspaceRoot.replace(/\/+$/, "")

    // If the LLM generated a relative workspaceRoot (e.g. "tmp", "game/src"),
    // targetArtifacts and other paths are relative to THAT subdirectory.
    // When we replace workspaceRoot with the actual root, we must prefix those
    // paths so they remain correct.
    const needsPrefix = originalRoot
      && originalRoot !== "."
      && originalRoot !== ""
      && !originalRoot.startsWith("/")
      && originalRoot !== actualRoot

    const prefixPath = (p: string): string => {
      if (!needsPrefix) return p
      // Don't double-prefix if already starts with the original root
      if (p.startsWith(originalRoot + "/") || p === originalRoot) return p
      // Don't prefix absolute paths
      if (p.startsWith("/")) return p
      return `${originalRoot}/${p}`
    }

    return {
      ...sa,
      executionContext: {
        ...sa.executionContext,
        workspaceRoot: actualRoot,
        allowedReadRoots: sa.executionContext.allowedReadRoots.map(r =>
          r === "." || r === "./" ? actualRoot : r,
        ),
        allowedWriteRoots: sa.executionContext.allowedWriteRoots.map(r =>
          r === "." || r === "./" ? actualRoot : r,
        ),
        targetArtifacts: sa.executionContext.targetArtifacts.map(prefixPath),
        requiredSourceArtifacts: sa.executionContext.requiredSourceArtifacts.map(prefixPath),
        artifactRelations: sa.executionContext.artifactRelations.map(rel => ({
          ...rel,
          artifactPath: prefixPath(rel.artifactPath),
        })),
      },
      // Also fix workflowStep artifact relations if present
      ...(sa.workflowStep ? {
        workflowStep: {
          ...sa.workflowStep,
          artifactRelations: sa.workflowStep.artifactRelations.map(rel => ({
            ...rel,
            artifactPath: prefixPath(rel.artifactPath),
          })),
        },
      } : {}),
    }
  })

  return { ...plan, steps: normalizedSteps }
}

// ============================================================================
// Plan salvage from malformed responses (agenc-core pattern)
// ============================================================================

/**
 * When the planner returns something that can't parse as a full plan,
 * try to extract any usable file-write or tool-call info and salvage it
 * into a minimal single-step plan. This prevents total failure when the
 * planner's JSON is slightly malformed or wrapped in prose.
 */
function salvagePlanFromMalformedResponse(raw: string, _workspaceRoot: string): Plan | null {
  // Try harder: find any JSON object buried in the response
  const jsonMatches = raw.match(/\{[\s\S]*?"steps"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/g)
  if (jsonMatches) {
    for (const candidate of jsonMatches) {
      try {
        const obj = JSON.parse(candidate) as Record<string, unknown>
        if (Array.isArray(obj.steps) && obj.steps.length > 0) {
          const inner = parsePlanFromResponse(candidate)
          if (inner.plan) return inner.plan
        }
      } catch { /* skip */ }
    }
  }

  return null
}


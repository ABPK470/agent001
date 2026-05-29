import { DiagnosticCategory, DiagnosticSeverity } from "../../domain/index.js"
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

import type { LLMClient, Message, Tool } from "../../types.js"
import { parsePlanFromResponse } from "../internal/generate-parse.js"
import {
    PLANNER_SYSTEM_PROMPT,
} from "../internal/generate-prompts.js"
import type { Plan, PlanDiagnostic, PlannerCoherentBootstrap, PlannerRoute } from "../types.js"

export { isValidArtifactPath } from "../internal/generate-parse.js"
export { generateCoherentBootstrap } from "./bootstrap.js"
export type { CoherentBootstrapGenerationResult } from "./bootstrap.js"

/**
 * Per-tool-array cache for the planner's `toolDescriptions` text block
 * (Gap 5). The same `availableTools` array is reused across attempts
 * within a run AND across multiple planner invocations during a single
 * agent run — without this the description string is rebuilt every time.
 */
const toolDescCache = new WeakMap<readonly Tool[], string>()
function buildToolDescriptions(tools: readonly Tool[]): string {
  const cached = toolDescCache.get(tools as Tool[])
  if (cached) return cached
  const built = tools
    .filter(t => t.name !== "delegate" && t.name !== "delegate_parallel")
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n")
  toolDescCache.set(tools as Tool[], built)
  return built
}

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

export interface PlanGenerationResult {
  readonly plan: Plan | null
  readonly diagnostics: readonly PlanDiagnostic[]
  /** Raw LLM response for debugging. */
  readonly rawResponse: string | null
}

// generateCoherentBootstrap moved to ./generate/bootstrap.ts

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

  const toolDescriptions = buildToolDescriptions(ctx.availableTools)

  // Hoist the per-call invariant prefix out of the retry loop. Previously
  // the planner system prompt, tool descriptions, recent-history context,
  // and the coherent-bootstrap block (often >2 KB) were rebuilt on every
  // attempt — paying the construction cost AND defeating any provider-side
  // prefix cache. Tag the bootstrap as `ephemeral` so Anthropic-compatible
  // endpoints can cache it across retries.
  const messagesPrefix: Message[] = [
    { role: MessageRole.System, content: PLANNER_SYSTEM_PROMPT, cacheHint: "ephemeral" },
    {
      role: MessageRole.System,
      content: `Available tools for children:\n${toolDescriptions}\n\nWorkspace root: ${ctx.workspaceRoot}`,
      cacheHint: "ephemeral",
    },
  ]

  const recentHistory = ctx.history.slice(-10).filter(
    m => m.role === MessageRole.User || m.role === MessageRole.Assistant,
  )
  if (recentHistory.length > 0) {
    messagesPrefix.push({
      role: MessageRole.System,
      content: `Recent conversation context:\n${recentHistory.map(m => `[${m.role}]: ${(m.content ?? "").slice(0, 500)}`).join("\n")}`,
    })
  }

  if (ctx.coherentBootstrap) {
    messagesPrefix.push({
      role: MessageRole.System,
      content:
        `Frozen architecture bootstrap:\n` +
        `Summary: ${ctx.coherentBootstrap.summary}\n` +
        `Architecture: ${ctx.coherentBootstrap.architecture}\n` +
        `Decomposition strategy: ${ctx.coherentBootstrap.decompositionStrategy}\n` +
        `Artifacts:\n${ctx.coherentBootstrap.artifacts.map((artifact) => `- ${artifact.path}: ${artifact.purpose}`).join("\n")}\n` +
        `Shared contracts:\n${ctx.coherentBootstrap.sharedContracts?.map((contract) => `- ${contract.name}: ${contract.description}`).join("\n") || "- none"}\n` +
        `Invariants:\n${ctx.coherentBootstrap.invariants?.map((invariant) => `- ${invariant.id}: ${invariant.description}`).join("\n") || "- none"}\n` +
        `Rules: preserve this architecture unless ownership separation is real. Do not decompose multi-file greenfield work automatically.`,
      cacheHint: "ephemeral",
    })
  }

  if (ctx.route === "planner_with_coherent_bootstrap") {
    messagesPrefix.push({
      role: MessageRole.System,
      content: "This is a planner_with_coherent_bootstrap run. First honor the frozen architecture, then decompose only when there are real ownership boundaries and overwrite-risk reductions.",
    })
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages: Message[] = [...messagesPrefix]

    // Add refinement hint from previous failed attempt
    if (refinementHint) {
      messages.push({
        role: MessageRole.System,
        content: `REFINEMENT REQUIRED: Your previous plan had issues. Fix them:\n${refinementHint}`,
      })
    }

    messages.push({ role: MessageRole.User, content: ctx.goal })

    let rawResponse: string | null = null
    try {
      const response = await llm.chat(messages, [], { signal: opts?.signal, temperature: 0 })
      rawResponse = response.content

      if (!rawResponse) {
        diagnostics.push({
          category: DiagnosticCategory.Parse, severity: DiagnosticSeverity.Error,
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
            category: DiagnosticCategory.Parse, severity: DiagnosticSeverity.Error,
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
        category: DiagnosticCategory.Parse, severity: DiagnosticSeverity.Error,
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
// Workspace root normalization + plan salvage moved to ./generate/normalize.ts
// ============================================================================

import { MessageRole } from "../../domain/enums/message.js"
import {
    normalizeWorkspaceRoots,
    salvagePlanFromMalformedResponse,
} from "./normalize.js"


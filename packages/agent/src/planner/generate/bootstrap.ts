/**
 * Planner coherent bootstrap generation. Extracted from generate.ts.
 *
 * @module
 */

import {
    asNonEmptyString,
    COHERENT_BOOTSTRAP_SYSTEM_PROMPT,
    parseBootstrapArtifacts,
    parseBootstrapContracts,
    parseBootstrapEdges,
    parseBootstrapInvariants,
    parseJsonObject,
} from "../generate-prompts.js"
import type { LLMClient, Message } from "../../types.js"
import type { PlanDiagnostic, PlannerCoherentBootstrap } from "../types.js"

export interface CoherentBootstrapGenerationContext {
  readonly goal: string
  readonly workspaceRoot: string
  readonly history: readonly Message[]
}

export interface CoherentBootstrapGenerationResult {
  readonly bootstrap: PlannerCoherentBootstrap | null
  readonly diagnostics: readonly PlanDiagnostic[]
  readonly rawResponse: string | null
}

export async function generateCoherentBootstrap(
  llm: LLMClient,
  ctx: CoherentBootstrapGenerationContext,
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

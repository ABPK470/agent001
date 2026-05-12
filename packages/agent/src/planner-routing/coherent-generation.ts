/**
 * Coherent generation execution helper. Extracted from planner-routing.ts.
 *
 * @module
 */

import type { PlannerRoutingContext } from "../planner-routing.js"
import {
    buildCoherentGenerationMessages,
    buildCoherentRepairInstructions,
    buildCoherentVerificationPlan,
    materializeCoherentSolutionBundle,
    parseCoherentSolutionBundle,
    summarizeCoherentVerifierDecision,
} from "../planner/index.js"
import type { Message } from "../types.js"

export async function attemptCoherentGeneration(
  ctx: PlannerRoutingContext,
  route: string,
): Promise<{ failed: boolean }> {
  const { messages, state, config } = ctx

  config.onPlannerTrace?.({ kind: "coherent-generation-start", route })
  config.onPlannerTrace?.({
    kind: "planner-architecture-state",
    lane: route,
    status: "preserved",
    reason: "coherent_lane_selected",
  })

  const coherentMessages = buildCoherentGenerationMessages(ctx.goal, config.workspaceRoot, messages)
  config.onLlmCall?.({ phase: "request", messages: coherentMessages, tools: [], iteration: 0 })

  const t0 = Date.now()
  // Hard cap: the Copilot Chat API (and most proxied LLM endpoints) reject
  // max_completion_tokens above ~16384 with HTTP 422 Unprocessable Entity.
  const coherentTokens = 16384
  const coherentResponse = await ctx.llm.chat(
    coherentMessages,
    [],
    {
      signal: config.signal,
      maxTokens: coherentTokens,
      onToken: (token) => config.onPlannerTrace?.({ kind: "coherent-generation-token", token }),
    },
  )
  const durationMs = Date.now() - t0
  ctx.incrementLlmCalls()
  config.onLlmCall?.({ phase: "response", response: coherentResponse, iteration: 0, durationMs })

  if (coherentResponse.usage) {
    ctx.usage.promptTokens += coherentResponse.usage.promptTokens
    ctx.usage.completionTokens += coherentResponse.usage.completionTokens
    ctx.usage.totalTokens += coherentResponse.usage.totalTokens
  }

  let coherentParse = parseCoherentSolutionBundle(coherentResponse.content ?? "")
  if (!coherentParse.bundle) {
    // One repair attempt
    const repairMessages: Message[] = [
      ...coherentMessages,
      { role: "assistant", content: coherentResponse.content ?? "" },
      {
        role: "user",
        content:
          "Your previous response could not be parsed as JSON.\n" +
          "Diagnostics: " + coherentParse.diagnostics.join("; ") + "\n\n" +
          "Reply with ONLY the JSON object — no markdown fences, no preamble, no prose. " +
          "Start with { and end with }. " +
          "IMPORTANT: The output token budget is limited (~16K tokens). " +
          "If your previous response was cut off mid-JSON, produce a SIMPLER solution: " +
          "fewer files, shorter comments, minimal inline examples. " +
          "Combine multiple small files into one. Aim for the smallest valid bundle.",
      },
    ]
    const repairResponse = await ctx.llm.chat(
      repairMessages,
      [],
      {
        signal: config.signal,
        maxTokens: coherentTokens,
        onToken: (token) => config.onPlannerTrace?.({ kind: "coherent-generation-token", token }),
      },
    )
    ctx.incrementLlmCalls()
    if (repairResponse.usage) {
      ctx.usage.promptTokens += repairResponse.usage.promptTokens
      ctx.usage.completionTokens += repairResponse.usage.completionTokens
      ctx.usage.totalTokens += repairResponse.usage.totalTokens
    }
    config.onLlmCall?.({ phase: "response", response: repairResponse, iteration: 0, durationMs: 0 })

    coherentParse = parseCoherentSolutionBundle(repairResponse.content ?? "")
    if (!coherentParse.bundle) {
      config.onPlannerTrace?.({
        kind: "coherent-generation-failed",
        stage: "bundle_parse",
        diagnostics: [...coherentParse.diagnostics],
      })
      return { failed: true }
    }
  }

  config.onPlannerTrace?.({
    kind: "coherent-generation-bundle",
    artifactCount: coherentParse.bundle.artifacts.length,
    artifacts: coherentParse.bundle.artifacts.map((a) => ({ path: a.path, purpose: a.purpose })),
    sharedContracts: coherentParse.bundle.sharedContracts?.map((c) => c.name) ?? [],
    invariants: coherentParse.bundle.invariants?.map((inv) => inv.id) ?? [],
  })

  const materialized = await materializeCoherentSolutionBundle(coherentParse.bundle, {
    writeFileTool: ctx.tools.get("write_file"),
    readFileTool: ctx.tools.get("read_file"),
  })

  for (const artifact of coherentParse.bundle.artifacts) {
    const written = materialized.writtenArtifacts.includes(artifact.path)
    ctx.allToolCalls.push({
      name: "write_file",
      args: { path: artifact.path, content: artifact.content },
      result: written ? "coherent bundle materialized" : `Error: bundle materialization skipped for ${artifact.path}`,
      isError: !written,
    })
  }
  for (const artifactPath of materialized.readBackArtifacts) {
    ctx.allToolCalls.push({
      name: "read_file",
      args: { path: artifactPath },
      result: "coherent bundle read-back completed",
      isError: false,
    })
  }

  if (materialized.diagnostics.length > 0) {
    config.onPlannerTrace?.({
      kind: "coherent-generation-failed",
      stage: "materialization",
      diagnostics: [...materialized.diagnostics],
    })
    return { failed: true }
  }

  state.coherentExecution = {
    bundle: coherentParse.bundle,
    verificationPlan: buildCoherentVerificationPlan(coherentParse.bundle, config.workspaceRoot),
    repairAttempts: 0,
    escalated: false,
    lastVerifiedToolCallCount: -1,
  }

  config.onPlannerTrace?.({
    kind: "coherent-generation-materialized",
    artifactCount: materialized.writtenArtifacts.length,
    artifacts: [...materialized.writtenArtifacts],
    readBackArtifacts: [...materialized.readBackArtifacts],
  })

  messages.push({
    role: "assistant",
    content:
      `Coherent solution bundle materialized with ${materialized.writtenArtifacts.length} files. ` +
      `Architecture: ${coherentParse.bundle.architecture}`,
    section: "history",
  })
  messages.push({
    role: "system",
    content:
      `A coherent multi-file solution bundle has already been written to disk for this goal.\n` +
      `Files: ${materialized.writtenArtifacts.join(", ")}\n` +
      `Phase 2 starts now: the coherent verifier owns acceptance. Preserve the architecture and file interfaces, and make only targeted fixes if evidence shows problems.\n` +
      `Do NOT redesign or decompose the solution unless verification proves the architecture is broken.`,
    section: "history",
  })

  const initialDecision = await ctx.runCoherentVerification(true)
  if (initialDecision && initialDecision.overall !== "pass") {
    const summary = summarizeCoherentVerifierDecision(initialDecision)
    config.onPlannerTrace?.({
      kind: "coherent-generation-repair-needed",
      repairAttempt: 1,
      issueCount: summary.issueCount,
      issues: [...summary.issues],
      affectedArtifacts: [...summary.affectedArtifacts],
    })
    config.onPlannerTrace?.({
      kind: "planner-architecture-state",
      lane: route,
      status: "repairing_in_place",
      reason: "coherent_verifier_requested_repair",
      architecture: coherentParse.bundle.architecture,
    })
    messages.push({
      role: "system",
      content: buildCoherentRepairInstructions(coherentParse.bundle, initialDecision, 1),
      section: "history",
    })
  }

  config.onPlannerTrace?.({
    kind: "coherent-generation-handoff",
    artifactCount: materialized.writtenArtifacts.length,
    verificationRoute: "coherent_verifier_then_direct_tool_loop",
  })

  return { failed: false }
}

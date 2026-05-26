/**
 * Helper functions used by Agent. Extracted from agent.ts.
 *
 * @module
 */

import type { VerifierDecision } from "../application/core/planner.js"
import {
    buildCoherentVerificationPipelineResult,
    summarizeCoherentVerifierDecision,
    verify,
} from "../application/core/planner.js"
import type { AgentLoopState } from "../application/shell/loop.js"
import { MessageRole } from "../domain/enums/message.js"
import { CoherentGenerationTraceKind } from "../domain/enums/planner-trace.js"
import { truncateMessages } from "../memory/index.js"
import type { ToolCallRecord } from "../tools/index.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "../types.js"

export interface CoherentVerificationDeps {
  llm: LLMClient
  toolList: Tool[]
  state: AgentLoopState
  allToolCalls: ToolCallRecord[]
  signal: AgentConfig["signal"]
  onPlannerTrace: AgentConfig["onPlannerTrace"]
}

export async function runCoherentVerification(
  deps: CoherentVerificationDeps,
  force = false,
): Promise<VerifierDecision | null> {
  const ce = deps.state.coherentExecution
  if (!ce) return null
  if (!force && ce.lastVerifierDecision && ce.lastVerifiedToolCallCount === deps.allToolCalls.length) {
    return ce.lastVerifierDecision
  }
  const decision = await verify(
    deps.llm, ce.verificationPlan,
    buildCoherentVerificationPipelineResult(ce.bundle, deps.allToolCalls),
    deps.toolList,
    { signal: deps.signal, onTrace: deps.onPlannerTrace, skipContractValidation: true },
  )
  ce.lastVerifierDecision = decision
  ce.lastVerifiedToolCallCount = deps.allToolCalls.length
  const summary = summarizeCoherentVerifierDecision(decision)
  deps.onPlannerTrace?.({
    kind: CoherentGenerationTraceKind.Verified,
    overall: summary.overall,
    confidence: summary.confidence,
    issueCount: summary.issueCount,
    systemCheckCount: summary.systemCheckCount,
    affectedArtifacts: [...summary.affectedArtifacts],
  })
  return decision
}

export interface SynthesizeDeps {
  llm: LLMClient
  signal: AgentConfig["signal"]
  usage: TokenUsage
  incrementLlmCalls: () => void
}

export async function synthesizeFinalAnswer(
  deps: SynthesizeDeps,
  messages: Message[],
): Promise<string> {
  try {
    const truncationResult = truncateMessages(messages)
    const response = await deps.llm.chat(truncationResult.messages, [], { signal: deps.signal })
    deps.incrementLlmCalls()
    if (response.usage) {
      deps.usage.promptTokens += response.usage.promptTokens
      deps.usage.completionTokens += response.usage.completionTokens
      deps.usage.totalTokens += response.usage.totalTokens
    }
    return response.content ?? "(The agent was unable to produce a final answer.)"
  } catch {
    return "(The agent was unable to produce a final answer.)"
  }
}

export function buildInitialMessages(
  goal: string,
  config: { systemMessages: Message[] | null; systemPrompt: string },
): Message[] {
  if (config.systemMessages && config.systemMessages.length > 0) {
    // Mark the last system message as a cache breakpoint (Gap 6).
    // Anthropic prompt caching applies to everything BEFORE the marker, so
    // tagging the final system entry caches the entire system block —
    // critical for delegation siblings that share the parent's resolved
    // system prompt and for multi-iteration agents that reuse the prompt
    // across every round.
    const sys = config.systemMessages
    const last = sys[sys.length - 1]
    const prefix = sys.slice(0, -1)
    return [
      ...prefix,
      last ? { ...last, cacheHint: last.cacheHint ?? "ephemeral" } : last!,
      { role: MessageRole.User, content: goal, section: "user" },
    ]
  }
  return [
    { role: MessageRole.System, content: config.systemPrompt, section: "system_anchor", cacheHint: "ephemeral" },
    { role: MessageRole.User, content: goal, section: "user" },
  ]
}

/**
 * Helper functions used by Agent. Extracted from agent.ts.
 *
 * @module
 */

import type { AgentLoopState } from "../agent-loop-state.js"
import { truncateMessages } from "../context-management.js"
import {
    buildCoherentVerificationPipelineResult,
    summarizeCoherentVerifierDecision,
} from "../planner/coherent.js"
import type { VerifierDecision } from "../planner/types.js"
import { verify } from "../planner/verifier.js"
import type { ToolCallRecord } from "../tool-result.js"
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
    kind: "coherent-generation-verified",
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
    return [
      ...config.systemMessages,
      { role: "user", content: goal, section: "user" },
    ]
  }
  return [
    { role: "system", content: config.systemPrompt, section: "system_anchor" },
    { role: "user", content: goal, section: "user" },
  ]
}

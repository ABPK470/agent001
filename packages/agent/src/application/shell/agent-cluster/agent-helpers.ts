/**
 * Helper functions used by Agent. Extracted from agent.ts.
 *
 * @module
 */

import { MessageRole } from "../../../domain/enums/message.js"
import { truncateMessages } from "../../../memory/index.js"
import type { AgentConfig, LLMClient, Message, TokenUsage } from "../../../domain/agent-types.js"

export interface SynthesizeDeps {
  llm: LLMClient
  signal: AgentConfig["signal"]
  usage: TokenUsage
  incrementLlmCalls: () => void
}

export async function synthesizeFinalAnswer(deps: SynthesizeDeps, messages: Message[]): Promise<string> {
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
  config: { systemMessages: Message[] | null; systemPrompt: string }
): Message[] {
  if (config.systemMessages && config.systemMessages.length > 0) {
    const sys = config.systemMessages
    const last = sys[sys.length - 1]
    const prefix = sys.slice(0, -1)
    return [
      ...prefix,
      last ? { ...last, cacheHint: last.cacheHint ?? "ephemeral" } : last!,
      { role: MessageRole.User, content: goal, section: "user" }
    ]
  }
  return [
    {
      role: MessageRole.System,
      content: config.systemPrompt,
      section: "system_anchor",
      cacheHint: "ephemeral"
    },
    { role: MessageRole.User, content: goal, section: "user" }
  ]
}

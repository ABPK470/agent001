/**
 * Ask the model.
 *
 * Input: prepared messages + available tools.
 * Output named outcomes:
 *   - responded — LLM returned content and/or tool calls
 *   - truncated_continue — output hit length limit; nudge and retry iteration
 * Next: decideNextAction, or continue the loop after truncation.
 */

import { LLMCallPhase } from "../../../domain/enums/llm.js"
import { MessageRole } from "../../../domain/enums/message.js"
import type { AgentConfig, LLMClient, LLMResponse, Message, Tool } from "../../../domain/types/agent-types.js"
import { createAnswerStreamGate, type AnswerStreamGate } from "../answer-stream-gate.js"
import { assertUnhandled } from "../unhandled-outcome.js"

export type AskTheModelResult =
  | {
      outcome: "responded"
      response: LLMResponse
      answerGate: AnswerStreamGate
      durationMs: number
    }
  | { outcome: "truncated_continue" }

export async function askTheModel(input: {
  llm: LLMClient
  contractMessages: Message[]
  chatToolsForLLM: Tool[]
  iteration: number
  config: {
    signal: AgentConfig["signal"]
    onToken: AgentConfig["onToken"]
    onStreamDiscard: AgentConfig["onStreamDiscard"]
    onLlmCall: AgentConfig["onLlmCall"]
    onNudge: AgentConfig["onNudge"]
  }
  messages: Message[]
}): Promise<AskTheModelResult> {
  const { llm, contractMessages, chatToolsForLLM, iteration, config, messages } = input

  const allowLiveAnswerStream = chatToolsForLLM.length === 0
  const answerGate = createAnswerStreamGate({
    allowLiveStream: allowLiveAnswerStream,
    onToken: config.onToken,
    onStreamDiscard: config.onStreamDiscard
  })

  config.onLlmCall?.({
    phase: LLMCallPhase.Request,
    messages: contractMessages,
    tools: chatToolsForLLM,
    iteration
  })

  const t0 = Date.now()
  try {
    const response = await llm.chat(contractMessages, chatToolsForLLM, {
      signal: config.signal,
      onToken: (token) => answerGate.onTokenDelta(token),
      onFirstToolCallDelta: () => answerGate.onToolCallStarted()
    })
    const durationMs = Date.now() - t0
    config.onLlmCall?.({ phase: LLMCallPhase.Response, response, iteration, durationMs })
    return { outcome: "responded", response, answerGate, durationMs }
  } catch (err) {
    answerGate.discard()
    if (err instanceof Error && err.message.includes("finish_reason=length")) {
      const truncMsg =
        "⚠ OUTPUT TRUNCATED: Your last response was cut off because it exceeded the completion token limit. " +
        "You MUST break your work into smaller pieces. When writing files, split them into multiple smaller write_file calls. " +
        "Do NOT put an entire large file in a single write_file call."
      messages.push({
        role: MessageRole.System,
        content: truncMsg,
        section: "history",
        hint: true
      })
      config.onNudge?.({ tag: "output-truncated", message: truncMsg, iteration })
      return { outcome: "truncated_continue" }
    }
    throw err
  }

  assertUnhandled("askTheModel", { outcome: "unreachable" })
}

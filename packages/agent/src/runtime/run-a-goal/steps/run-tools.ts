/**
 * Run tools.
 *
 * Input: model tool calls + current messages / state.
 * Output: tool round results (before after-tools interpretation).
 * Next: afterTools.
 */

import type { ToolCallsBranchInput } from "../iteration-tool-round.js"
import { executeToolRound, type ToolExecContext } from "../../loop.js"
import { MessageRole } from "../../../domain/enums/message.js"
import type { ToolCallRecord } from "../../../tools/index.js"
import type { Message } from "../../../domain/types/agent-types.js"

export type RunToolsResult = {
  outcome: "tools_finished"
  roundToolCalls: ToolCallRecord[]
  failuresThisRound: number
  delegationThisRound: boolean
  delegationThisRoundWasReadOnly: boolean
  forcedAbortLoopMessage?: string
  forcedAbortRoundMessage?: string
  response: ToolCallsBranchInput["response"]
  messages: Message[]
  iteration: number
}

export async function runTools(
  input: ToolCallsBranchInput
): Promise<RunToolsResult> {
  const { response, messages, iteration: i, state, tools, toolList, config, allToolCalls } = input

  messages.push({
    role: MessageRole.Assistant,
    content: response.content,
    toolCalls: response.toolCalls as Message["toolCalls"],
    section: "history"
  })

  const roundResult = await executeToolRound(
    response.toolCalls as Array<{
      id: string
      name: string
      arguments: Record<string, unknown> & { __parseError?: boolean; __raw?: string }
    }>,
    {
      tools,
      toolList,
      state,
      messages,
      config: config as ToolExecContext["config"],
      iteration: i,
      allToolCalls
    }
  )

  return {
    outcome: "tools_finished",
    roundToolCalls: roundResult.roundToolCalls,
    failuresThisRound: roundResult.failuresThisRound,
    delegationThisRound: roundResult.delegationThisRound,
    delegationThisRoundWasReadOnly: roundResult.delegationThisRoundWasReadOnly,
    ...(roundResult.forcedAbortLoopMessage
      ? { forcedAbortLoopMessage: roundResult.forcedAbortLoopMessage }
      : {}),
    ...(roundResult.forcedAbortRoundMessage
      ? { forcedAbortRoundMessage: roundResult.forcedAbortRoundMessage }
      : {}),
    response,
    messages,
    iteration: i
  }
}

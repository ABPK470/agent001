/**
 * Run tools.
 *
 * Input: model tool calls + current messages / state.
 * Output: tool round results (before after-tools interpretation).
 * Next: afterTools.
 *
 * Before executing tools we snapshot messages via `onStep`. That snapshot is
 * the durable resume point if a tool parks for operator approval — it must
 * NOT include this round's incomplete assistant toolCalls (replaying those
 * without tool results breaks the chat API). Resume re-asks the model; the
 * approved grant then lets the matching tool through.
 */

import { ApprovalRequiredError } from "../../../domain/types/errors.js"
import type { ToolCallsBranchInput } from "../iteration-tool-round.js"
import { executeToolRound, type ToolExecContext } from "../../loop.js"
import { MessageRole } from "../../../domain/enums/message.js"
import type { ToolCallRecord } from "../../../tools/_shared/result.js"
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

  // Checkpoint BEFORE the assistant tool-call message. If the first tool of
  // the run requires approval, this is often the only durable history we have
  // — without it resumeRun finds no checkpoint and returns null (UI stays
  // parked on "waiting for approval" forever after Approve).
  config.onStep?.(messages, i)

  messages.push({
    role: MessageRole.Assistant,
    content: response.content,
    toolCalls: response.toolCalls as Message["toolCalls"],
    section: "history"
  })

  try {
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
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      // Pop the incomplete assistant tool-call turn so in-memory history
      // matches the checkpoint (resume must not see dangling toolCalls).
      const last = messages[messages.length - 1]
      if (last?.role === MessageRole.Assistant && last.toolCalls?.length) {
        messages.pop()
      }
    }
    throw err
  }
}

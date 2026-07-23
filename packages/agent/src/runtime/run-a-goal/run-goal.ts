/**
 * Run a goal — the prose spine of one agent run.
 *
 * Read this file top-to-bottom. Each step is a named chapter with explicit
 * outcomes. There is no silent fall-through.
 *
 * Story:
 *   1. Prepare messages
 *   2. Try planner path → answered | use_tool_loop
 *   3. For each iteration:
 *        prepare → ask model → decide next action
 *        → finish_check → check can finish → accept | reject_and_continue
 *        → run_tools → after tools → answered | continue | synthesize | abort
 *   4. Finish
 */

import { MessageRole } from "../../domain/enums/message.js"
import * as log from "../../internal/index.js"
import type { ToolCallRecord } from "../../tools/_shared/result.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "../../domain/types/agent-types.js"
import { synthesizeFinalAnswer } from "./agent-helpers.js"
import { createAgentLoopState } from "./state.js"
import { assertUnhandled } from "./unhandled-outcome.js"
import { afterTools } from "./steps/after-tools.js"
import { askTheModel } from "./steps/ask-the-model.js"
import { checkCanFinish } from "./steps/check-can-finish.js"
import { decideNextAction } from "./steps/decide-next-action.js"
import { finish } from "./steps/finish.js"
import { prepareIteration } from "./steps/prepare-iteration.js"
import { prepareMessages } from "./steps/prepare-messages.js"
import { runTools } from "./steps/run-tools.js"
import { tryPlannerPath } from "./steps/try-planner-path.js"

export interface RunGoalDeps {
  llm: LLMClient
  tools: Map<string, Tool>
  toolList: Tool[]
  config: {
    maxIterations: number
    systemPrompt: string
    systemMessages: Message[] | undefined
    verbose: boolean
    onThinking: AgentConfig["onThinking"]
    onToken: AgentConfig["onToken"]
    onStreamDiscard: AgentConfig["onStreamDiscard"]
    onStep: AgentConfig["onStep"]
    onLlmCall: AgentConfig["onLlmCall"]
    onNudge: AgentConfig["onNudge"]
    onToolResult: AgentConfig["onToolResult"]
    signal: AgentConfig["signal"]
    enablePlanner: boolean
    workspaceRoot: string
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    plannerRouting: AgentConfig["plannerRouting"]
    toolKillManager: AgentConfig["toolKillManager"]
    completionValidator: AgentConfig["completionValidator"]
    enableAnswerStabilityGuard: boolean
    deferRecoveryHintsUntilCompletionAttempt: AgentConfig["deferRecoveryHintsUntilCompletionAttempt"]
  }
  usage: TokenUsage
  allToolCalls: ToolCallRecord[]
  incrementLlmCalls: () => void
}

export async function runGoal(
  deps: RunGoalDeps,
  goal: string,
  resume?: { messages: Message[]; iteration: number }
): Promise<string> {
  const { llm, tools, toolList, config, usage, allToolCalls, incrementLlmCalls } = deps

  if (config.verbose) log.logGoal(goal)

  // ── 1. Prepare messages ───────────────────────────────────────────
  const messages: Message[] = resume?.messages ?? prepareMessages(goal, config)
  const state = createAgentLoopState(config.maxIterations)

  // ── 2. Try planner path (skip when resuming a checkpoint) ─────────
  if (!resume) {
    const route = await tryPlannerPath({
      goal,
      messages,
      state,
      llm,
      toolList,
      tools,
      config,
      usage,
      allToolCalls,
      incrementLlmCalls,
      createPlannerContext: () => ({
        llm,
        tools: toolList,
        workspaceRoot: config.workspaceRoot,
        history: messages,
        signal: config.signal,
        onTrace: config.onPlannerTrace
      })
    })
    if (route.outcome === "answered") return finish(route.answer, config.verbose)
    if (route.outcome !== "use_tool_loop") assertUnhandled("tryPlannerPath", route)
  }

  // ── 3. Tool loop ──────────────────────────────────────────────────
  for (let i = resume?.iteration ?? 0; i < config.maxIterations; i++) {
    if (config.signal?.aborted) {
      return finish("Agent was cancelled.", config.verbose)
    }

    maybeBudgetNudge(messages, state, i, config)

    if (config.verbose) log.logIteration(i, config.maxIterations)

    // 3a. Prepare iteration
    const { contractMessages, chatToolsForLLM } = prepareIteration({
      messages,
      iteration: i,
      state,
      toolList,
      userGoal: goal,
      modelHint: llm.modelHint,
      config: {
        verbose: config.verbose,
        onNudge: config.onNudge,
        onPlannerTrace: config.onPlannerTrace
      }
    })

    // 3b. Ask the model
    const ask = await askTheModel({
      llm,
      contractMessages,
      chatToolsForLLM,
      iteration: i,
      config,
      messages
    })
    if (ask.outcome === "truncated_continue") continue
    if (ask.outcome !== "responded") assertUnhandled("askTheModel", ask)

    incrementLlmCalls()
    if (ask.response.usage) {
      usage.promptTokens += ask.response.usage.promptTokens
      usage.completionTokens += ask.response.usage.completionTokens
      usage.totalTokens += ask.response.usage.totalTokens
    }

    if (config.verbose) log.logThinking(ask.response.content)
    const preToolNarration =
      ask.response.toolCalls.length > 0 ? (ask.response.content ?? null) : null
    config.onThinking?.(preToolNarration, ask.response.toolCalls, i)

    // 3c. Decide next action
    const next = decideNextAction(ask.response)

    if (next.outcome === "finish_check") {
      const check = await checkCanFinish({
        response: next.response,
        messages,
        iteration: i,
        userGoal: goal,
        state,
        toolList,
        config,
        answerGate: ask.answerGate
      })
      if (check.outcome === "accept") return finish(check.answer, config.verbose)
      if (check.outcome === "reject_and_continue") continue
      assertUnhandled("checkCanFinish", check)
    }

    if (next.outcome === "stop") {
      return finish(next.reason, config.verbose)
    }

    if (next.outcome !== "run_tools") assertUnhandled("decideNextAction", next)

    // 3d. Run tools
    const toolsResult = await runTools({
      response: next.response,
      messages,
      iteration: i,
      state,
      tools,
      toolList,
      userGoal: goal,
      config,
      allToolCalls
    })
    if (toolsResult.outcome !== "tools_finished") assertUnhandled("runTools", toolsResult)

    // 3e. After tools (stuck / budget / recover — explicit)
    const after = afterTools(toolsResult, { state, config, allToolCalls })
    if (after.outcome === "answered") return finish(after.answer, config.verbose)
    if (after.outcome === "abort_loop") return finish(after.answer, config.verbose)
    if (after.outcome === "continue_loop") continue
    if (after.outcome === "needs_synthesis") {
      const synthesisAnswer = await synthesizeFinalAnswer(
        {
          llm,
          signal: config.signal,
          usage,
          onToken: config.onToken,
          incrementLlmCalls
        },
        messages
      )
      return finish(synthesisAnswer, config.verbose)
    }
    assertUnhandled("afterTools", after)
  }

  // ── 4. Max iterations — synthesize a final answer ─────────────────
  messages.push({
    role: MessageRole.System,
    content:
      `You have used all ${config.maxIterations} iterations. STOP calling tools. ` +
      `Write your final answer now using only the information already gathered. ` +
      `If the task is incomplete, clearly state what you found and what remains unknown.`,
    section: "history",
    hint: true
  })
  const maxIterAnswer = await synthesizeFinalAnswer(
    {
      llm,
      signal: config.signal,
      usage,
      onToken: config.onToken,
      incrementLlmCalls
    },
    messages
  )
  return finish(maxIterAnswer, config.verbose)
}

function maybeBudgetNudge(
  messages: Message[],
  state: { budgetNudged: boolean },
  iteration: number,
  config: RunGoalDeps["config"]
): void {
  const remaining = config.maxIterations - iteration
  if (state.budgetNudged) return
  if (remaining > Math.max(Math.ceil(config.maxIterations * 0.2), 2)) return

  state.budgetNudged = true
  const budgetMsg =
    `⚠ ITERATION BUDGET: You have ${remaining} iteration(s) remaining out of ${config.maxIterations}. ` +
    `Prioritize COMPLETING your current work over perfecting it. ` +
    `Finish writing any pending files, run a quick verification, and wrap up. ` +
    `Do NOT start new refactors or rewrites — finalize what you have.`
  messages.push({
    role: MessageRole.System,
    content: budgetMsg,
    section: "history",
    hint: true
  })
  config.onNudge?.({ tag: "budget-warning", message: budgetMsg, iteration })
}

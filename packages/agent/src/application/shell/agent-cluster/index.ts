/**
 * The Agent — the core of any agentic AI system.
 *
 * An agent is just: LLM + Tools + Loop.
 *
 *   1. Receive a goal from the user
 *   2. Ask the LLM: "Given this goal and what you know, what should you do?"
 *   3. If the LLM returns tool calls → execute them, feed results back, goto 2
 *   4. If the LLM returns text (no tool calls) → that's the final answer
 *
 * The loop orchestration lives here. Heavy lifting is delegated to:
 *   - planner-routing.ts — structured planner-first execution path
 *   - loop-policy — per-turn steering (turn-start + completion)
 *   - tool-execution.ts — per-tool-call execution with guards
 *   - post-round.ts — stuck detection, budget extension, recovery hints
 *   - agent-loop-state.ts — mutable state for the tool loop
 */

import { LLMCallPhase } from "../../../domain/enums/llm.js"
import { MessageRole } from "../../../domain/enums/message.js"
import * as log from "../../../internal/index.js"
import type { ToolCallRecord } from "../../../tools/index.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "../../../domain/agent-types.js"
import { attemptPlannerRouting } from "../../core/planner-routing.js"
import { createAgentLoopState, DEFAULT_SYSTEM_PROMPT, completionContext, guardCompletion } from "../loop.js"
import { buildInitialMessages, synthesizeFinalAnswer } from "./agent-helpers.js"
import { createAnswerStreamGate } from "./answer-stream-gate.js"
import { prepareIterationContext } from "./iteration-prepare.js"
import { executeToolCallsBranch } from "./iteration-tool-round.js"

// Re-export compactMessages for tests (context-compaction.test.ts)
export { compactMessages } from "../../../memory/index.js"

export class Agent {
  private readonly llm: LLMClient
  private readonly tools: Map<string, Tool>
  private readonly toolList: Tool[]
  private readonly config: {
    maxIterations: number
    systemPrompt: string
    systemMessages: Message[] | null
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
    toolKillManager: AgentConfig["toolKillManager"]
    completionValidator: AgentConfig["completionValidator"]
    enableAnswerStabilityGuard: boolean
    deferRecoveryHintsUntilCompletionAttempt: AgentConfig["deferRecoveryHintsUntilCompletionAttempt"]
  }

  /** Cumulative token usage across all LLM calls in this agent's run. */
  readonly usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  /** Number of LLM API calls made. */
  llmCalls = 0
  /** All tool calls made during this agent's run (accumulated across iterations). */
  readonly allToolCalls: ToolCallRecord[] = []

  constructor(llm: LLMClient, tools: Tool[], config: AgentConfig = {}) {
    this.llm = llm
    this.tools = new Map(tools.map((t) => [t.name, t]))
    this.toolList = tools
    this.config = {
      maxIterations: config.maxIterations ?? 30,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      systemMessages: config.systemMessages ?? null,
      verbose: config.verbose ?? true,
      onThinking: config.onThinking,
      onToken: config.onToken,
      onStreamDiscard: config.onStreamDiscard,
      onStep: config.onStep,
      onLlmCall: config.onLlmCall,
      onNudge: config.onNudge,
      onToolResult: config.onToolResult,
      signal: config.signal,
      enablePlanner: config.enablePlanner ?? false,
      workspaceRoot: config.workspaceRoot ?? ".",
      onPlannerTrace: config.onPlannerTrace,
      plannerDelegateFn: config.plannerDelegateFn,
      toolKillManager: config.toolKillManager,
      completionValidator: config.completionValidator,
      enableAnswerStabilityGuard: config.enableAnswerStabilityGuard ?? true,
      deferRecoveryHintsUntilCompletionAttempt: config.deferRecoveryHintsUntilCompletionAttempt
    }
  }

  /** The system prompt used for this agent instance. */
  get systemPrompt(): string {
    if (this.config.systemMessages) {
      return this.config.systemMessages
        .filter((m) => m.role === MessageRole.System)
        .map((m) => m.content ?? "")
        .join("\n\n")
    }
    return this.config.systemPrompt
  }

  /** Run the agent with a goal. Returns the final answer. */
  run(goal: string, resume?: { messages: Message[]; iteration: number }): Promise<string> {
    return this.runInternal(goal, resume)
  }

  private async runInternal(
    goal: string,
    resume?: { messages: Message[]; iteration: number }
  ): Promise<string> {
    if (this.config.verbose) log.logGoal(goal)

    const messages: Message[] = resume?.messages ?? this.buildInitialMessages(goal)
    const state = createAgentLoopState(this.config.maxIterations)

    if (!resume) {
      const plannerResult = await attemptPlannerRouting({
        goal,
        messages,
        state,
        llm: this.llm,
        toolList: this.toolList,
        tools: this.tools,
        config: this.config,
        usage: this.usage,
        allToolCalls: this.allToolCalls,
        incrementLlmCalls: () => {
          this.llmCalls++
        },
        createPlannerContext: () => ({
          llm: this.llm,
          tools: this.toolList,
          workspaceRoot: this.config.workspaceRoot,
          history: messages,
          signal: this.config.signal,
          onTrace: this.config.onPlannerTrace
        })
      })
      if (plannerResult.finalAnswer) {
        if (this.config.verbose) log.logFinalAnswer(plannerResult.finalAnswer)
        return plannerResult.finalAnswer
      }
    }

    // ── Direct tool loop ──
    for (let i = resume?.iteration ?? 0; i < this.config.maxIterations; i++) {
      if (this.config.signal?.aborted) return "Agent was cancelled."

      // Budget awareness nudge
      const remaining = this.config.maxIterations - i
      if (!state.budgetNudged && remaining <= Math.max(Math.ceil(this.config.maxIterations * 0.2), 2)) {
        state.budgetNudged = true
        const budgetMsg =
          `⚠ ITERATION BUDGET: You have ${remaining} iteration(s) remaining out of ${this.config.maxIterations}. ` +
          `Prioritize COMPLETING your current work over perfecting it. ` +
          `Finish writing any pending files, run a quick verification, and wrap up. ` +
          `Do NOT start new refactors or rewrites — finalize what you have.`
        messages.push({
          role: MessageRole.System,
          content: budgetMsg,
          section: "history",
          hint: true
        })
        this.config.onNudge?.({ tag: "budget-warning", message: budgetMsg, iteration: i })
      }

      if (this.config.verbose) log.logIteration(i, this.config.maxIterations)

      const { contractMessages, chatToolsForLLM } = prepareIterationContext({
        messages,
        iteration: i,
        state,
        toolList: this.toolList,
        userGoal: goal,
        modelHint: this.llm.modelHint,
        config: {
          verbose: this.config.verbose,
          onNudge: this.config.onNudge,
          onPlannerTrace: this.config.onPlannerTrace
        }
      })

      // A response is not a final answer merely because an earlier iteration
      // used a tool: this iteration may still emit another tool call. Keep
      // every tool-capable response private until the complete response has
      // no tool calls and passes the completion guards. This is the key UI
      // invariant: once prose enters the answer bubble, it is never revoked.
      //
      // The one safe live-stream case is a tool-free request (no tools exposed
      // to the LLM): it cannot pivot into a tool round, so its tokens are
      // guaranteed final and can stream live with the ASCII-glyph effect.
      // Tool-capable iterations buffer silently, then release the approved
      // answer as a paced glyph reveal (~2s) so the streaming feel is preserved
      // without ever revoking visible text.
      const allowLiveAnswerStream = chatToolsForLLM.length === 0
      const answerGate = createAnswerStreamGate({
        allowLiveStream: allowLiveAnswerStream,
        onToken: this.config.onToken,
        onStreamDiscard: this.config.onStreamDiscard
      })

      this.config.onLlmCall?.({
        phase: LLMCallPhase.Request,
        messages: contractMessages,
        tools: chatToolsForLLM,
        iteration: i
      })
      const t0 = Date.now()
      let response
      try {
        response = await this.llm.chat(contractMessages, chatToolsForLLM, {
          signal: this.config.signal,
          onToken: (token) => answerGate.onTokenDelta(token),
          onFirstToolCallDelta: () => answerGate.onToolCallStarted()
        })
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
          this.config.onNudge?.({ tag: "output-truncated", message: truncMsg, iteration: i })
          continue
        }
        throw err
      }
      const durationMs = Date.now() - t0
      this.llmCalls++
      this.config.onLlmCall?.({ phase: LLMCallPhase.Response, response, iteration: i, durationMs })

      if (response.usage) {
        this.usage.promptTokens += response.usage.promptTokens
        this.usage.completionTokens += response.usage.completionTokens
        this.usage.totalTokens += response.usage.totalTokens
      }

      if (this.config.verbose) log.logThinking(response.content)
      // Pre-tool narration only. Text-only turns are final answers — streamed
      // via onToken and persisted as `answer`, not duplicated as `thinking`.
      const preToolNarration =
        response.toolCalls.length > 0 ? (response.content ?? null) : null
      this.config.onThinking?.(preToolNarration, response.toolCalls, i)

      // ── No tool calls → completion guards ──
      if (response.toolCalls.length === 0) {
        state.completionAttempted = true

        const guardResult = await guardCompletion(
          completionContext({
            response,
            messages,
            iteration: i,
            userGoal: goal,
            state,
            toolList: this.toolList,
            config: this.config,
            onPlannerTrace: this.config.onPlannerTrace
          })
        )

        if (guardResult) {
          if (guardResult.finalAnswer) {
            await answerGate.flushApproved(guardResult.finalAnswer)
            if (this.config.verbose) log.logFinalAnswer(guardResult.finalAnswer)
            return guardResult.finalAnswer
          }
          // Guard fired — never show the rejected draft in the answer bubble.
          answerGate.discard()
          // Guard fired — inject messages and continue
          messages.push({
            role: MessageRole.Assistant,
            content: response.content,
            section: "history"
          })
          messages.push({
            role: MessageRole.System,
            content: guardResult.message,
            section: "history",
            hint: true
          })
          this.config.onNudge?.({
            tag: guardResult.tag,
            message: guardResult.message,
            iteration: i
          })
          continue
        }

        // All guards passed — emit the validated final answer to the UI.
        const answer = response.content ?? "(no response)"
        await answerGate.flushApproved(answer)
        if (this.config.verbose) log.logFinalAnswer(answer)
        return answer
      }

      // ── Execute tool calls ──
      // stream.reset already fired via onToolCallStarted during the LLM stream.
      const branchResult = await executeToolCallsBranch({
        response,
        messages,
        iteration: i,
        state,
        tools: this.tools,
        toolList: this.toolList,
        userGoal: goal,
        config: this.config,
        allToolCalls: this.allToolCalls
      })
      if (branchResult.finalAnswer !== undefined) {
        return branchResult.finalAnswer
      }
      if (branchResult.shouldContinue) continue
      if (branchResult.needsSynthesis) {
        const synthesisAnswer = await this.synthesizeFinalAnswer(messages)
        if (this.config.verbose) log.logFinalAnswer(synthesisAnswer)
        return synthesisAnswer
      }
    }

    // Max iterations reached — synthesize instead of returning a dead-end string.
    const maxIterSynthesisInstruction =
      `You have used all ${this.config.maxIterations} iterations. STOP calling tools. ` +
      `Write your final answer now using only the information already gathered. ` +
      `If the task is incomplete, clearly state what you found and what remains unknown.`
    messages.push({
      role: MessageRole.System,
      content: maxIterSynthesisInstruction,
      section: "history",
      hint: true
    })
    const maxIterAnswer = await this.synthesizeFinalAnswer(messages)
    if (this.config.verbose) log.logFinalAnswer(maxIterAnswer)
    return maxIterAnswer
  }

  private synthesizeFinalAnswer(messages: Message[]): Promise<string> {
    return synthesizeFinalAnswer(
      {
        llm: this.llm,
        signal: this.config.signal,
        usage: this.usage,
        onToken: this.config.onToken,
        incrementLlmCalls: () => {
          this.llmCalls++
        }
      },
      messages
    )
  }

  private buildInitialMessages(goal: string): Message[] {
    return buildInitialMessages(goal, this.config)
  }
}

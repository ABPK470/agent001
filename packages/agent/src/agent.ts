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
 *   - completion-guards.ts — checks when LLM wants to finish
 *   - tool-execution.ts — per-tool-call execution with guards
 *   - post-round.ts — stuck detection, budget extension, recovery hints
 *   - agent-loop-state.ts — mutable state for the tool loop
 */

import { createAgentLoopState } from "./agent-loop-state.js"
import { runCompletionGuards } from "./completion-guards.js"
import { applyFullCompaction, shouldApplyFullCompaction } from "./context-compaction.js"
import { compactMessages, truncateMessages } from "./context-management.js"
import * as log from "./logger.js"
import {
  buildCoherentVerificationPipelineResult,
  summarizeCoherentVerifierDecision,
} from "./planner/coherent.js"
import type { PlannerContext } from "./planner/index.js"
import type { VerifierDecision } from "./planner/types.js"
import { verify } from "./planner/verifier.js"
import { attemptPlannerRouting } from "./planner-routing.js"
import { processPostRound } from "./post-round.js"
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.js"
import { applyToolContractGuidance, resolveToolContractGuidance, type ToolContractContext } from "./tool-contract-guidance.js"
import { executeToolRound } from "./tool-execution.js"
import type { ToolCallRecord } from "./tool-result.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "./types.js"

// Re-export compactMessages for tests (context-compaction.test.ts)
export { compactMessages } from "./context-management.js"

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
    onStep: AgentConfig["onStep"]
    onLlmCall: AgentConfig["onLlmCall"]
    onNudge: AgentConfig["onNudge"]
    signal: AgentConfig["signal"]
    enablePlanner: boolean
    workspaceRoot: string
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    toolKillManager: AgentConfig["toolKillManager"]
    completionValidator: AgentConfig["completionValidator"]
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
      onStep: config.onStep,
      onLlmCall: config.onLlmCall,
      onNudge: config.onNudge,
      signal: config.signal,
      enablePlanner: config.enablePlanner ?? false,
      workspaceRoot: config.workspaceRoot ?? ".",
      onPlannerTrace: config.onPlannerTrace,
      plannerDelegateFn: config.plannerDelegateFn,
      toolKillManager: config.toolKillManager,
      completionValidator: config.completionValidator,
      deferRecoveryHintsUntilCompletionAttempt: config.deferRecoveryHintsUntilCompletionAttempt,
    }
  }

  /** The system prompt used for this agent instance. */
  get systemPrompt(): string {
    if (this.config.systemMessages) {
      return this.config.systemMessages
        .filter((m) => m.role === "system")
        .map((m) => m.content ?? "")
        .join("\n\n")
    }
    return this.config.systemPrompt
  }

  /**
   * Run the agent with a goal. Returns the final answer.
   *
   * This is THE agentic loop. Everything else is plumbing.
   */
  async run(
    goal: string,
    resume?: { messages: Message[], iteration: number },
  ): Promise<string> {
    if (this.config.verbose) log.logGoal(goal)

    const messages: Message[] = resume?.messages ?? this.buildInitialMessages(goal)
    const createPlannerContext = (): PlannerContext => ({
      llm: this.llm,
      tools: this.toolList,
      workspaceRoot: this.config.workspaceRoot,
      history: messages,
      signal: this.config.signal,
      onTrace: this.config.onPlannerTrace,
    })

    const state = createAgentLoopState(this.config.maxIterations)

    const runCoherentVerification = async (force = false): Promise<VerifierDecision | null> => {
      const ce = state.coherentExecution
      if (!ce) return null
      if (!force && ce.lastVerifierDecision && ce.lastVerifiedToolCallCount === this.allToolCalls.length) {
        return ce.lastVerifierDecision
      }
      const decision = await verify(
        this.llm, ce.verificationPlan,
        buildCoherentVerificationPipelineResult(ce.bundle, this.allToolCalls),
        this.toolList,
        { signal: this.config.signal, onTrace: this.config.onPlannerTrace, skipContractValidation: true },
      )
      ce.lastVerifierDecision = decision
      ce.lastVerifiedToolCallCount = this.allToolCalls.length
      const summary = summarizeCoherentVerifierDecision(decision)
      this.config.onPlannerTrace?.({
        kind: "coherent-generation-verified",
        overall: summary.overall,
        confidence: summary.confidence,
        issueCount: summary.issueCount,
        systemCheckCount: summary.systemCheckCount,
        affectedArtifacts: [...summary.affectedArtifacts],
      })
      return decision
    }

    // ── Planner-first routing ──
    if (!resume) {
      const plannerResult = await attemptPlannerRouting({
        goal, messages, state,
        llm: this.llm, toolList: this.toolList, tools: this.tools,
        config: this.config,
        usage: this.usage,
        allToolCalls: this.allToolCalls,
        incrementLlmCalls: () => { this.llmCalls++ },
        createPlannerContext,
        runCoherentVerification,
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
        messages.push({ role: "system", content: budgetMsg, section: "history" })
        this.config.onNudge?.({ tag: "budget-warning", message: budgetMsg, iteration: i })
      }

      if (this.config.verbose) log.logIteration(i, this.config.maxIterations)

      // ── Full history compaction ──
      if (shouldApplyFullCompaction(messages, i, state.lastFullCompactionIteration)) {
        const { compacted: fullyCompacted, state: compactionState } = applyFullCompaction(messages, i)
        messages.splice(0, messages.length, ...fullyCompacted)
        state.lastFullCompactionIteration = i
        this.config.onNudge?.({
          tag: "context-compaction",
          message: `Session checkpoint at iteration ${i}: ${compactionState.writtenFiles.length} file records captured`,
          iteration: i,
        })
      }

      // ── Context management: compact then truncate ──
      const compacted = compactMessages(messages)
      const compactedCount = compacted.filter((m, idx) => m.content !== messages[idx]?.content).length
      if (compactedCount > 0) {
        const savedChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0)
          - compacted.reduce((s, m) => s + (m.content?.length ?? 0), 0)
        this.config.onNudge?.({
          tag: "context-compaction",
          message: `Compacted ${compactedCount} stale tool results, saved ~${Math.round(savedChars / 4)} tokens`,
          iteration: i,
        })
      }
      const truncationResult = truncateMessages(compacted)
      const chatMessages = truncationResult.messages

      if (truncationResult.budgetDiagnostics) {
        const diag = truncationResult.budgetDiagnostics
        this.config.onNudge?.({
          tag: "prompt-budget",
          message: `Prompt budget applied: ${diag.totalBeforeChars} → ${diag.totalAfterChars} chars` +
            (diag.droppedSections.length > 0 ? `, dropped: ${diag.droppedSections.join(", ")}` : "") +
            (diag.constrained ? " [constrained]" : ""),
          iteration: i,
        })
      }

      // ── Tool contract guidance ──
      const contractCtx: ToolContractContext = {
        iteration: i,
        availableToolNames: this.toolList.map(t => t.name),
        lastRoundHadDelegation: state.lastRoundHadDelegation,
        inPostDelegationVerification: state.inPostDelegationVerification,
        artifactsRequiringReadBeforeMutation: state.artifactsRequiringReadBeforeMutation,
        wroteUnverifiedFiles: state.wroteUnverifiedFiles,
        writtenButNotReread: state.writtenButNotReread,
        lastRoundToolCalls: state.lastRoundToolCallsSnapshot,
        isKeyBlocked: (key) => state.circuitBreaker.isKeyBlocked(key) !== null,
      }
      const contractGuidance = resolveToolContractGuidance(contractCtx)
      let chatToolsForLLM = this.toolList
      const contractMessages = [...chatMessages]
      if (contractGuidance) {
        const applied = applyToolContractGuidance(contractGuidance, this.toolList.map(t => t.name))
        const nameSet = new Set(applied.filteredToolNames)
        chatToolsForLLM = this.toolList.filter(t => nameSet.has(t.name))
        if (applied.injectedInstruction && contractMessages.length > 0) {
          contractMessages.push({ role: "system", content: applied.injectedInstruction, section: "history" })
        }
        if (this.config.verbose) {
          log.logError(`[contract:${contractGuidance.resolverName}] enforcement=${contractGuidance.enforcement}, tools=${applied.filteredToolNames.join(",")}`)
        }
      }

      // ── LLM call ──
      this.config.onLlmCall?.({ phase: "request", messages: contractMessages, tools: chatToolsForLLM, iteration: i })
      const t0 = Date.now()
      let response
      try {
        response = await this.llm.chat(contractMessages, chatToolsForLLM, { signal: this.config.signal })
      } catch (err) {
        if (err instanceof Error && err.message.includes("finish_reason=length")) {
          const truncMsg =
            "⚠ OUTPUT TRUNCATED: Your last response was cut off because it exceeded the completion token limit. " +
            "You MUST break your work into smaller pieces. When writing files, split them into multiple smaller write_file calls. " +
            "Do NOT put an entire large file in a single write_file call."
          messages.push({ role: "system", content: truncMsg, section: "history" })
          this.config.onNudge?.({ tag: "output-truncated", message: truncMsg, iteration: i })
          continue
        }
        throw err
      }
      const durationMs = Date.now() - t0
      this.llmCalls++
      this.config.onLlmCall?.({ phase: "response", response, iteration: i, durationMs })

      if (response.usage) {
        this.usage.promptTokens += response.usage.promptTokens
        this.usage.completionTokens += response.usage.completionTokens
        this.usage.totalTokens += response.usage.totalTokens
      }

      if (this.config.verbose) log.logThinking(response.content)
      this.config.onThinking?.(response.content, response.toolCalls, i)

      // ── No tool calls → completion guards ──
      if (response.toolCalls.length === 0) {
        state.completionAttempted = true

        const guardResult = await runCompletionGuards({
          response, messages, iteration: i, state,
          toolList: this.toolList,
          config: this.config,
          runCoherentVerification,
          createPlannerContext,
          onPlannerTrace: this.config.onPlannerTrace,
        })

        if (guardResult) {
          if (guardResult.finalAnswer) {
            if (this.config.verbose) log.logFinalAnswer(guardResult.finalAnswer)
            return guardResult.finalAnswer
          }
          // Guard fired — inject messages and continue
          messages.push({ role: "assistant", content: response.content, section: "history" })
          messages.push({ role: "system", content: guardResult.message, section: "history" })
          this.config.onNudge?.({ tag: guardResult.tag, message: guardResult.message, iteration: i })
          continue
        }

        // All guards passed — return the final answer
        const answer = response.content ?? "(no response)"
        if (this.config.verbose) log.logFinalAnswer(answer)
        return answer
      }

      // ── Execute tool calls ──
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        section: "history",
      })

      const roundResult = await executeToolRound(
        response.toolCalls as Array<{ id: string; name: string; arguments: Record<string, unknown> & { __parseError?: boolean; __raw?: string } }>,
        {
          tools: this.tools,
          toolList: this.toolList,
          state, messages,
          config: this.config,
          iteration: i,
          allToolCalls: this.allToolCalls,
        },
      )

      // Handle forced aborts
      if (roundResult.forcedAbortLoopMessage) {
        this.allToolCalls.push(...roundResult.roundToolCalls)
        messages.push({ role: "system", content: roundResult.forcedAbortLoopMessage, section: "history" })
        this.config.onNudge?.({ tag: "fatal-tool-outcome", message: roundResult.forcedAbortLoopMessage, iteration: i })
        if (this.config.verbose) log.logError(roundResult.forcedAbortLoopMessage)
        return roundResult.forcedAbortLoopMessage
      }

      if (roundResult.forcedAbortRoundMessage) {
        this.allToolCalls.push(...roundResult.roundToolCalls)
        messages.push({ role: "system", content: roundResult.forcedAbortRoundMessage, section: "history" })
        this.config.onNudge?.({ tag: "abort-round-tool-outcome", message: roundResult.forcedAbortRoundMessage, iteration: i })
        if (this.config.verbose) log.logError(roundResult.forcedAbortRoundMessage)
        this.config.onStep?.(messages, i)
        continue
      }

      // ── Post-round processing ──
      const postRound = processPostRound({
        roundToolCalls: roundResult.roundToolCalls,
        response,
        messages, state,
        iteration: i,
        config: this.config,
        allToolCalls: this.allToolCalls,
        failuresThisRound: roundResult.failuresThisRound,
        delegationThisRound: roundResult.delegationThisRound,
      })

      if (postRound.finalAnswer) {
        if (this.config.verbose) log.logFinalAnswer(postRound.finalAnswer)
        return postRound.finalAnswer
      }
    }

    const maxIterMsg = `Agent stopped after ${this.config.maxIterations} iterations.`
    if (this.config.verbose) log.logError(maxIterMsg)
    return maxIterMsg
  }

  private buildInitialMessages(goal: string): Message[] {
    if (this.config.systemMessages && this.config.systemMessages.length > 0) {
      return [
        ...this.config.systemMessages,
        { role: "user", content: goal, section: "user" },
      ]
    }
    return [
      { role: "system", content: this.config.systemPrompt, section: "system_anchor" },
      { role: "user", content: goal, section: "user" },
    ]
  }
}

/**
 * The Agent — thin wrapper around runGoal.
 *
 * What: LLM + tools + config for one run.
 * Why: callers construct an Agent, then call run(goal).
 * Next: open run-goal.ts for the prose spine of the run.
 */

import { MessageRole } from "../../domain/enums/message.js"
import type { ToolCallRecord } from "../../tools/_shared/result.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "../../domain/types/agent-types.js"
import { DEFAULT_SYSTEM_PROMPT } from "../loop.js"
import { runGoal } from "./run-goal.js"

// Re-export compactMessages for tests (context-compaction.test.ts)
export { compactMessages } from "../../memory/index.js"
export { UnhandledStepOutcomeError } from "./unhandled-outcome.js"

export class Agent {
  private readonly llm: LLMClient
  private readonly tools: Map<string, Tool>
  private readonly toolList: Tool[]
  private readonly config: {
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
      systemMessages: config.systemMessages,
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
      plannerRouting: config.plannerRouting,
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
    return runGoal(
      {
        llm: this.llm,
        tools: this.tools,
        toolList: this.toolList,
        config: this.config,
        usage: this.usage,
        allToolCalls: this.allToolCalls,
        incrementLlmCalls: () => {
          this.llmCalls++
        }
      },
      goal,
      resume
    )
  }
}

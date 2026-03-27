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
 * That's it. This is the same pattern used by:
 *   - ChatGPT (with code interpreter, browsing, etc.)
 *   - Claude (with tool use)
 *   - GitHub Copilot (with file read/write, terminal, search)
 *   - Cursor, Devin, and every other coding agent
 *   - LangChain ReAct agent, CrewAI, AutoGPT
 *
 * The magic isn't in the loop (it's ~40 lines). The magic is in:
 *   - The LLM's ability to reason about which tool to use
 *   - The quality of tool descriptions
 *   - The system prompt
 *   - The accumulated message history (the agent "remembers" what it did)
 */

import * as log from "./logger.js"
import type { AgentConfig, LLMClient, Message, Tool } from "./types.js"

const DEFAULT_SYSTEM_PROMPT = `You are a capable AI agent that can use tools to accomplish goals.

When given a goal:
1. Break it down into steps
2. Use tools to gather information or take actions
3. Observe the results and decide what to do next
4. Repeat until the goal is achieved
5. Provide a clear final answer

Be methodical. Think before acting. If a tool call fails, try a different approach.
Always explain your reasoning when providing the final answer.`

export class Agent {
  private readonly llm: LLMClient
  private readonly tools: Map<string, Tool>
  private readonly toolList: Tool[]
  private readonly config: {
    maxIterations: number
    systemPrompt: string
    verbose: boolean
    onStep: AgentConfig["onStep"]
    signal: AgentConfig["signal"]
  }

  constructor(llm: LLMClient, tools: Tool[], config: AgentConfig = {}) {
    this.llm = llm
    this.tools = new Map(tools.map((t) => [t.name, t]))
    this.toolList = tools
    this.config = {
      maxIterations: config.maxIterations ?? 30,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      verbose: config.verbose ?? true,
      onStep: config.onStep,
      signal: config.signal,
    }
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

    const messages: Message[] = resume?.messages ?? [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: goal },
    ]

    for (let i = resume?.iteration ?? 0; i < this.config.maxIterations; i++) {
      if (this.config.signal?.aborted) {
        return "Agent was cancelled."
      }
      if (this.config.verbose) log.logIteration(i, this.config.maxIterations)

      // Ask the LLM what to do next
      const response = await this.llm.chat(messages, this.toolList)

      // If the LLM has something to say, log it
      if (this.config.verbose) log.logThinking(response.content)

      // No tool calls → the agent is done, return the final answer
      if (response.toolCalls.length === 0) {
        const answer = response.content ?? "(no response)"
        if (this.config.verbose) log.logFinalAnswer(answer)
        return answer
      }

      // Add the assistant's message (with tool call requests) to history
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      })

      // Execute each tool the LLM requested
      for (const call of response.toolCalls) {
        if (this.config.verbose) log.logToolCall(call.name, call.arguments)

        const tool = this.tools.get(call.name)
        if (!tool) {
          const errMsg = `Unknown tool "${call.name}". Available: ${[...this.tools.keys()].join(", ")}`
          if (this.config.verbose) log.logToolError(errMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: errMsg })
          continue
        }

        try {
          const result = await tool.execute(call.arguments)
          if (this.config.verbose) log.logToolResult(result)
          messages.push({ role: "tool", toolCallId: call.id, content: result })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          if (this.config.verbose) log.logToolError(errMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: `Error: ${errMsg}` })
        }
      }

      // Checkpoint after tool execution round
      this.config.onStep?.(messages, i)
    }

    const maxIterMsg = `Agent stopped after ${this.config.maxIterations} iterations.`
    if (this.config.verbose) log.logError(maxIterMsg)
    return maxIterMsg
  }
}

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
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "./types.js"

/**
 * Rough token estimate: ~4 chars per token for English text.
 * This is intentionally conservative — better to truncate early than crash.
 */
function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) {
    chars += (m.content ?? "").length
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += tc.name.length + JSON.stringify(tc.arguments).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

/** Max token budget for the request body. */
const MAX_CONTEXT_TOKENS = 64000

/**
 * Truncate message history to fit within the token budget.
 * Strategy: keep system prompt + goal (first 2 messages) and the most recent
 * messages. Drop the oldest middle messages first. Tool results in remaining
 * messages are trimmed if they're excessively long.
 */
function truncateMessages(messages: Message[]): Message[] {
  // Trim any single tool result that's excessively long
  const MAX_RESULT_LEN = 8000
  const trimmed = messages.map((m) => {
    if (m.role === "tool" && m.content && m.content.length > MAX_RESULT_LEN) {
      return { ...m, content: m.content.slice(0, MAX_RESULT_LEN) + "\n... (output truncated)" }
    }
    return m
  })

  if (estimateTokens(trimmed) <= MAX_CONTEXT_TOKENS) return trimmed
  if (trimmed.length <= 4) return trimmed // Can't truncate further

  // Keep system + goal (first 2) and recent tail; drop middle
  const head = trimmed.slice(0, 2)
  // Start by keeping last 4 messages, grow until we're under budget or run out
  let tailSize = 4
  while (tailSize < trimmed.length - 2) {
    const candidate = [...head, { role: "system" as const, content: "[Earlier conversation truncated to save context budget.]" }, ...trimmed.slice(-tailSize)]
    if (estimateTokens(candidate) > MAX_CONTEXT_TOKENS) {
      // One step too many — go back
      tailSize = Math.max(4, tailSize - 2)
      break
    }
    tailSize += 2
  }

  const result = [
    ...head,
    { role: "system" as const, content: "[Earlier conversation truncated to save context budget.]" },
    ...trimmed.slice(-tailSize),
  ]
  return result
}

const DEFAULT_SYSTEM_PROMPT = `You are an efficient AI agent that uses tools to accomplish goals.

Principles:
- Briefly state your approach before acting so the user can follow your reasoning.
- Act directly. For simple tasks, use the right tool immediately.
- NEVER browse directories one-by-one. Use run_command with find, grep, wc, etc. A single shell pipeline replaces dozens of tool calls.
- For data collection tasks (counting lines, searching files, aggregating stats): write and execute ONE shell command or script. Never do it file-by-file.
- Call multiple tools in one turn when operations are independent.
- Don't verify results unless there's a reason to doubt them.
- If a path doesn't exist, check the error message — it often tells you what does exist nearby.

Delegation:
- When splitting work across child agents, prefer delegate_parallel for independent tasks rather than chaining sequential delegates.
- Each child is a focused worker — give it a precise, self-contained goal with all necessary context.
- ALWAYS verify delegation results before considering the task done. Check that files were created, code compiles, output matches expectations, etc.
- If a child's output is wrong or incomplete, re-delegate that specific task with feedback describing what was wrong and what needs to change. Max 2 rework attempts per task.
- You are the orchestrator: decompose, delegate, verify, and only then synthesize the final answer.

Verification:
- After creating or modifying web projects (HTML/JS/CSS), ALWAYS use browser_check to open the page and verify it loads without errors.
- If browser_check reports errors, fix them yourself or re-delegate with the specific error details.
- After creating code that can be tested (scripts, modules), run it with run_command to verify it works.
- Never mark a task as done without verifying the output actually works end-to-end.

Failure recovery:
- NEVER repeat the same command (or a trivially similar variant) after it fails. If a command fails, read the error, understand why, and try a fundamentally different approach.
- If grep/find returns nothing, the pattern or path is wrong — try broader terms, different flags, or list the directory first.
- After 2 failed attempts at the same task, stop and re-assess your approach entirely.
- Prefer using list_directory or read_file to understand the codebase structure before running speculative shell commands.

Context efficiency:
- Keep tool outputs concise. Pipe through head, tail, or grep to limit output size.
- Avoid dumping entire files when you only need a few lines.
- Be aware that conversation history has a token budget — work efficiently to avoid hitting limits.

Provide a concise final answer when done.`

export class Agent {
  private readonly llm: LLMClient
  private readonly tools: Map<string, Tool>
  private readonly toolList: Tool[]
  private readonly config: {
    maxIterations: number
    systemPrompt: string
    verbose: boolean
    onThinking: AgentConfig["onThinking"]
    onStep: AgentConfig["onStep"]
    signal: AgentConfig["signal"]
  }

  /** Cumulative token usage across all LLM calls in this agent's run. */
  readonly usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  /** Number of LLM API calls made. */
  llmCalls = 0

  constructor(llm: LLMClient, tools: Tool[], config: AgentConfig = {}) {
    this.llm = llm
    this.tools = new Map(tools.map((t) => [t.name, t]))
    this.toolList = tools
    this.config = {
      maxIterations: config.maxIterations ?? 30,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      verbose: config.verbose ?? true,
      onThinking: config.onThinking,
      onStep: config.onStep,
      signal: config.signal,
    }
  }

  /** The system prompt used for this agent instance. */
  get systemPrompt(): string {
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

    const messages: Message[] = resume?.messages ?? [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: goal },
    ]

    for (let i = resume?.iteration ?? 0; i < this.config.maxIterations; i++) {
      if (this.config.signal?.aborted) {
        return "Agent was cancelled."
      }
      if (this.config.verbose) log.logIteration(i, this.config.maxIterations)

      // Truncate context if approaching token budget
      const chatMessages = truncateMessages(messages)

      // Ask the LLM what to do next
      const response = await this.llm.chat(chatMessages, this.toolList)
      this.llmCalls++

      // Accumulate token usage
      if (response.usage) {
        this.usage.promptTokens += response.usage.promptTokens
        this.usage.completionTokens += response.usage.completionTokens
        this.usage.totalTokens += response.usage.totalTokens
      }

      // If the LLM has something to say, log it
      if (this.config.verbose) log.logThinking(response.content)

      // Notify listener before tool execution (for trace/UI)
      this.config.onThinking?.(response.content, response.toolCalls, i)

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

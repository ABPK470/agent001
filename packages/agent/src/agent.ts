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
import type { AgentConfig, LLMClient, Message, PromptBudgetSection, TokenUsage, Tool } from "./types.js"
import { DROP_PRIORITY } from "./types.js"

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
 * Budget-aware message truncation (agenc-core pattern).
 *
 * Strategy:
 *   1. Trim excessively long tool results (> 8KB)
 *   2. If still over budget, drop entire sections in priority order:
 *      memory_semantic → memory_episodic → system_runtime → memory_working → history
 *   3. For history: drop oldest messages first (preserve recent context)
 *   4. NEVER drop: system_anchor, user, tools
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
  if (trimmed.length <= 4) return trimmed

  // Check if any messages have section tags (new structured prompt)
  const hasStructuredPrompt = trimmed.some((m) => m.section != null)

  if (hasStructuredPrompt) {
    return truncateBySection(trimmed)
  }

  // Legacy fallback: keep head (system + goal) and recent tail, drop middle
  return truncateLegacy(trimmed)
}

/**
 * Section-aware truncation: drop droppable sections in priority order.
 */
function truncateBySection(messages: Message[]): Message[] {
  let current = [...messages]

  for (const section of DROP_PRIORITY) {
    if (estimateTokens(current) <= MAX_CONTEXT_TOKENS) break

    if (section === "history") {
      // For history: drop oldest messages first, keep recent ones
      current = dropOldestHistory(current)
    } else {
      // Drop all messages from this section
      current = current.filter((m) => m.section !== section)
    }
  }

  // If still over budget after dropping all droppable sections,
  // fall back to aggressive history trimming
  if (estimateTokens(current) > MAX_CONTEXT_TOKENS) {
    current = truncateLegacy(current)
  }

  return current
}

/**
 * Drop oldest history messages (assistant/tool pairs) while keeping recent context.
 * Preserves system messages and the most recent tail.
 */
function dropOldestHistory(messages: Message[]): Message[] {
  // Find the boundaries of history messages (non-system, non-section-tagged)
  const systemEnd = messages.findIndex(
    (m) => m.role !== "system" && m.section !== "system_anchor" && m.section !== "system_runtime"
      && m.section !== "memory_working" && m.section !== "memory_episodic" && m.section !== "memory_semantic",
  )
  if (systemEnd < 0) return messages

  // Find user message (the goal)
  const userIdx = messages.findIndex((m) => m.section === "user" || (m.role === "user" && !m.section))
  const historyStart = Math.max(systemEnd, userIdx + 1)

  const head = messages.slice(0, historyStart)
  const tail = messages.slice(historyStart)

  if (tail.length <= 6) return messages // Not enough to trim

  // Keep only the most recent half of history
  const keepCount = Math.max(6, Math.floor(tail.length / 2))
  const keptTail = tail.slice(-keepCount)

  return [
    ...head,
    { role: "system" as const, content: "[Earlier conversation truncated to save context budget.]", section: "history" as PromptBudgetSection },
    ...keptTail,
  ]
}

/** Legacy truncation for non-sectioned messages. */
function truncateLegacy(messages: Message[]): Message[] {
  const head = messages.slice(0, 2)
  let tailSize = 4
  while (tailSize < messages.length - 2) {
    const candidate = [...head, { role: "system" as const, content: "[Earlier conversation truncated to save context budget.]" }, ...messages.slice(-tailSize)]
    if (estimateTokens(candidate) > MAX_CONTEXT_TOKENS) {
      tailSize = Math.max(4, tailSize - 2)
      break
    }
    tailSize += 2
  }
  return [
    ...head,
    { role: "system" as const, content: "[Earlier conversation truncated to save context budget.]" },
    ...messages.slice(-tailSize),
  ]
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
- Each child is a focused worker — give it a precise, self-contained goal with ALL necessary context (requirements, file paths, expected behavior). Do not assume the child knows anything.
- AFTER EVERY delegation result, your VERY NEXT action MUST be a verification tool call — NEVER respond with text immediately after a delegation returns. Always verify first.
  • Web projects → call browser_check on the main HTML file
  • Code/scripts → call run_command to compile, run, or test
  • File creation → call list_directory or read_file to confirm content and quality
- If verification reveals issues (errors, missing features, incomplete work), re-delegate that specific task with corrective feedback describing EXACTLY what is wrong. Max 2 rework attempts per task.
- You are the orchestrator: decompose → delegate → VERIFY → (rework if needed) → synthesize.

Verification:
- After creating or modifying web projects (HTML/JS/CSS), ALWAYS use browser_check to open the page and verify it loads without errors.
- If browser_check reports errors, fix them yourself or re-delegate with the specific error details.
- After creating code that can be tested (scripts, modules), run it with run_command to verify it works.
- Never mark a task as done without verifying the output actually works end-to-end.
- NEVER provide a final answer based solely on a delegation summary. You must independently verify the result.

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
    systemMessages: Message[] | null
    verbose: boolean
    onThinking: AgentConfig["onThinking"]
    onStep: AgentConfig["onStep"]
    onLlmCall: AgentConfig["onLlmCall"]
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
      systemMessages: config.systemMessages ?? null,
      verbose: config.verbose ?? true,
      onThinking: config.onThinking,
      onStep: config.onStep,
      onLlmCall: config.onLlmCall,
      signal: config.signal,
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

    // Stuck detection state (agenc-core pattern):
    // Track recent failing tool calls to detect loops.
    const recentFailures: Array<{ name: string; argsKey: string }> = []
    const MAX_IDENTICAL_FAILURES = 3

    // Track whether the last tool round included a delegation call.
    // Used for post-delegation verification enforcement.
    let lastRoundHadDelegation = false
    // Track if we already nudged for early exit (only once per run).
    let earlyExitNudged = false

    for (let i = resume?.iteration ?? 0; i < this.config.maxIterations; i++) {
      if (this.config.signal?.aborted) {
        return "Agent was cancelled."
      }
      if (this.config.verbose) log.logIteration(i, this.config.maxIterations)

      // Truncate context if approaching token budget
      const chatMessages = truncateMessages(messages)

      // Notify listener before LLM call (for debug/trace)
      this.config.onLlmCall?.({
        phase: "request",
        messages: chatMessages,
        tools: this.toolList,
        iteration: i,
      })

      // Ask the LLM what to do next
      const t0 = Date.now()
      let response
      try {
        response = await this.llm.chat(chatMessages, this.toolList, { signal: this.config.signal })
      } catch (err) {
        // Recover from truncated responses — nudge the LLM to break work into smaller pieces
        if (err instanceof Error && err.message.includes("finish_reason=length")) {
          messages.push({
            role: "system",
            content:
              "⚠ OUTPUT TRUNCATED: Your last response was cut off because it exceeded the completion token limit. " +
              "You MUST break your work into smaller pieces. When writing files, split them into multiple smaller write_file calls " +
              "(e.g. write a skeleton first, then append sections). Do NOT put an entire large file in a single write_file call.",
            section: "history",
          })
          continue
        }
        throw err
      }
      const durationMs = Date.now() - t0
      this.llmCalls++

      // Notify listener after LLM call (for debug/trace)
      this.config.onLlmCall?.({
        phase: "response",
        response,
        iteration: i,
        durationMs,
      })

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
        // Guard: if this is iteration 0 and the agent has tools, it likely
        // bailed without doing any work. Nudge it once to actually act.
        if (i === 0 && this.toolList.length > 0 && !earlyExitNudged) {
          earlyExitNudged = true
          messages.push({
            role: "assistant",
            content: response.content,
            section: "history",
          })
          messages.push({
            role: "system",
            content:
              "You returned a text response without using any tools. " +
              "You MUST use your tools to accomplish the goal — do not just describe a plan. " +
              "Start working now by calling the appropriate tools.",
            section: "history",
          })
          continue
        }

        // Guard: if the previous round had a delegation, the agent must
        // verify the result with a tool call before finishing.
        if (lastRoundHadDelegation) {
          lastRoundHadDelegation = false
          messages.push({
            role: "assistant",
            content: response.content,
            section: "history",
          })
          messages.push({
            role: "system",
            content:
              "VERIFICATION REQUIRED: You just received a delegation result but attempted to " +
              "finish without verifying. You MUST call a verification tool now:\n" +
              "- For web projects → browser_check on the main HTML file\n" +
              "- For code → run_command to compile/test\n" +
              "- For files → list_directory or read_file to confirm\n" +
              "Do NOT provide a final answer until you have independently verified the output.",
            section: "history",
          })
          continue
        }

        const answer = response.content ?? "(no response)"
        if (this.config.verbose) log.logFinalAnswer(answer)
        return answer
      }

      // Add the assistant's message (with tool call requests) to history
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        section: "history",
      })

      // Execute each tool the LLM requested
      let failuresThisRound = 0
      let delegationThisRound = false
      for (const call of response.toolCalls) {
        if (this.config.signal?.aborted) {
          return "Agent was cancelled."
        }
        if (this.config.verbose) log.logToolCall(call.name, call.arguments)

        const tool = this.tools.get(call.name)
        if (!tool) {
          const errMsg = `Unknown tool "${call.name}". Available: ${[...this.tools.keys()].join(", ")}`
          if (this.config.verbose) log.logToolError(errMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: errMsg, section: "history" })
          failuresThisRound++
          continue
        }

        // Guard: if the LLM's tool call arguments failed to parse, report back instead of executing with garbage
        if (call.arguments.__parseError) {
          const errMsg = `Tool call "${call.name}" failed: the model produced malformed arguments that could not be parsed as JSON. ` +
            `This usually means your output was too large and got cut off. ` +
            `Break the work into smaller pieces — use multiple write_file calls instead of one large one. ` +
            `Raw (truncated): ${String(call.arguments.__raw).slice(0, 200)}...`
          if (this.config.verbose) log.logToolError(errMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: errMsg, section: "history" })
          failuresThisRound++
          continue
        }

        try {
          const result = await tool.execute(call.arguments)
          if (this.config.verbose) log.logToolResult(result)
          messages.push({ role: "tool", toolCallId: call.id, content: result, section: "history" })
          if (call.name === "delegate" || call.name === "delegate_parallel") {
            delegationThisRound = true
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          if (this.config.verbose) log.logToolError(errMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: `Error: ${errMsg}`, section: "history" })
          failuresThisRound++

          // Stuck detection: track this failure
          const argsKey = JSON.stringify(call.arguments)
          recentFailures.push({ name: call.name, argsKey })
          // Keep only last 10 failures
          if (recentFailures.length > 10) recentFailures.shift()

          // Check for identical repeated failures
          const identicalCount = recentFailures.filter(
            (f) => f.name === call.name && f.argsKey === argsKey,
          ).length
          if (identicalCount >= MAX_IDENTICAL_FAILURES) {
            // Inject a recovery hint so the LLM tries a different approach
            messages.push({
              role: "system",
              content: `STUCK DETECTION: Tool "${call.name}" has failed ${identicalCount} times with identical arguments. You MUST try a fundamentally different approach. Do NOT retry the same call.`,
              section: "history",
            })
            if (this.config.verbose) {
              log.logError(`Stuck: ${call.name} failed ${identicalCount}x with same args`)
            }
          }
        }
      }

      // Checkpoint after tool execution round
      lastRoundHadDelegation = delegationThisRound
      this.config.onStep?.(messages, i)
    }

    const maxIterMsg = `Agent stopped after ${this.config.maxIterations} iterations.`
    if (this.config.verbose) log.logError(maxIterMsg)
    return maxIterMsg
  }

  /**
   * Build the initial message array for a new run.
   *
   * When systemMessages is provided (structured prompt), uses multiple
   * system messages with section tags. Otherwise falls back to single
   * system prompt (legacy mode).
   */
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

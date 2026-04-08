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

import { ToolFailureCircuitBreaker } from "./circuit-breaker.js"
import * as log from "./logger.js"
import type { PlannerContext } from "./planner/index.js"
import { executePlannerPath } from "./planner/index.js"
import { applyPromptBudget, type PromptBudgetDiagnostics } from "./prompt-budget.js"
import type { ToolCallRecord } from "./recovery.js"
import { buildRecoveryHints, buildSemanticToolCallKey, didToolCallFail } from "./recovery.js"
import type {
  RoundStuckState,
  ToolLoopState,
  ToolRoundProgressSummary,
} from "./tool-utils.js"
import {
  checkToolLoopStuckDetection,
  enrichToolResultMetadata as enrichResult,
  evaluateToolRoundBudgetExtension,
  executeToolWithTimeout,
  summarizeToolRoundProgress,
  trackToolCallFailureState,
} from "./tool-utils.js"
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

interface TruncationResult {
  readonly messages: Message[]
  readonly budgetDiagnostics?: PromptBudgetDiagnostics
}

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
function truncateMessages(messages: Message[]): TruncationResult {
  // Trim any single tool result that's excessively long
  const MAX_RESULT_LEN = 8000
  const trimmed = messages.map((m) => {
    if (m.role === "tool" && m.content && m.content.length > MAX_RESULT_LEN) {
      return { ...m, content: m.content.slice(0, MAX_RESULT_LEN) + "\n... (output truncated)" }
    }
    return m
  })

  if (estimateTokens(trimmed) <= MAX_CONTEXT_TOKENS) return { messages: trimmed }
  if (trimmed.length <= 4) return { messages: trimmed }

  // Check if any messages have section tags (structured prompt)
  const hasStructuredPrompt = trimmed.some((m) => m.section != null)

  if (hasStructuredPrompt) {
    // Use the full prompt budget system (ported from agenc-core) for section-aware allocation
    const budgetResult = applyPromptBudget(trimmed, {
      contextWindowTokens: MAX_CONTEXT_TOKENS,
      maxOutputTokens: 4096,
      charPerToken: 4,
      hardMaxPromptChars: MAX_CONTEXT_TOKENS * 4,
    })
    if (budgetResult.messages.length > 0) {
      return { messages: budgetResult.messages, budgetDiagnostics: budgetResult.diagnostics }
    }
    // Fallback to legacy if budget system produced empty
    console
    return { messages: truncateBySection(trimmed) }
  }

  // Legacy fallback: keep head (system + goal) and recent tail, drop middle
  return { messages: truncateLegacy(trimmed) }
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

Task execution protocol:
1. Start executing immediately — use the right tool in your first turn.
2. If a brief preamble helps, keep it to one sentence and continue into tool use in the same turn.
3. NEVER end the turn with only a plan when execution was requested.
4. If a command fails (build error, test failure, etc), read the error, fix the code, and retry — do NOT stop and report the error as a blocker.
5. Keep iterating until the task succeeds or you have genuinely exhausted options.
6. Finish with grounded results or a specific blocker backed by tool evidence.
7. NEVER run interactive programs (games, TUI apps, editors, REPLs) via run_command — they block the terminal. To test a GUI/TUI program, compile it and confirm the binary exists.

Efficiency:
- Use run_command with find, grep, wc, etc. A single shell pipeline replaces dozens of tool calls.
- For data collection tasks (counting lines, searching files): write ONE shell command, never do it file-by-file.
- Call multiple tools in one turn when operations are independent.
- Don't verify results unless there's a reason to doubt them.
- Keep tool outputs concise — pipe through head, tail, or grep.
- Be aware that conversation history has a token budget — work efficiently.

Delegation:
- When splitting work across child agents, prefer delegate_parallel for independent tasks rather than chaining sequential delegates.
- Each child is a focused worker — give it a precise, self-contained goal with ALL necessary context (requirements, file paths, expected behavior). Do not assume the child knows anything.
- AFTER EVERY delegation result, your VERY NEXT action MUST be a verification tool call — NEVER respond with text immediately after a delegation returns. Always verify first.
  - Web projects → call browser_check on the main HTML file AND read_file on key code files
  - Code/scripts → call run_command to compile, run, or test
  - File creation → call list_directory or read_file to confirm content
- If verification reveals issues, re-delegate with corrective feedback describing EXACTLY what is wrong. Max 2 rework attempts per task.
- You are the orchestrator: decompose → delegate → VERIFY → (rework if needed) → synthesize.

Verification:
- After creating or modifying web projects (HTML/JS/CSS), ALWAYS use browser_check AND read_file the main code files to verify real logic exists.
- browser_check only tests if the page LOADS — it does NOT verify correctness. ALWAYS also read code files to check for stubs, \`return true\`, or TODO comments.
- After creating testable code, run it with run_command to verify it works end-to-end.
- NEVER provide a final answer based solely on a delegation summary. You must independently verify the result.

Failure recovery:
- NEVER repeat the same command after it fails. Read the error and try a fundamentally different approach.
- After 2 failed attempts at the same task, stop and re-assess entirely.
- If a test command enters watch mode and times out, retry with single-run mode (e.g., \`vitest run\`, \`CI=1 npm test\`).

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
    onNudge: AgentConfig["onNudge"]
    signal: AgentConfig["signal"]
    enablePlanner: boolean
    workspaceRoot: string
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    toolKillManager: AgentConfig["toolKillManager"]
    completionValidator: AgentConfig["completionValidator"]
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

    // ── Planner-first routing (agenc-core pattern) ──────────────
    // For complex tasks (score >= 3), try the planner path BEFORE falling
    // through to the direct tool loop. This produces structured plans with
    // typed execution envelopes for higher delegation quality.
    if (this.config.enablePlanner && !resume && this.config.plannerDelegateFn) {
      const plannerCtx: PlannerContext = {
        llm: this.llm,
        tools: this.toolList,
        workspaceRoot: this.config.workspaceRoot,
        history: messages,
        signal: this.config.signal,
        onTrace: this.config.onPlannerTrace,
      }

      const plannerResult = await executePlannerPath(
        goal,
        plannerCtx,
        this.config.plannerDelegateFn,
      )

      if (plannerResult.handled) {
        const answer = plannerResult.answer ?? "(planner produced no answer)"
        if (this.config.verbose) log.logFinalAnswer(answer)
        return answer
      }

      // Planner declined — fall through to direct tool loop
      if (this.config.verbose && plannerResult.skipReason) {
        log.logError(`Planner skipped: ${plannerResult.skipReason}`)
      }

      // If the planner tried but verification failed, inject repair context
      // so the direct tool loop knows what files exist and what to fix.
      if (plannerResult.verifierDecision && plannerResult.verifierDecision.overall !== "pass") {
        const unresolvedIssues = plannerResult.verifierDecision.steps
          .filter(s => s.outcome !== "pass")
          .flatMap(s => s.issues.filter(i => !i.startsWith("[non-blocking]")))
        if (unresolvedIssues.length > 0) {
          const repairMsg =
            `A previous attempt partially completed this task but verification found issues that need fixing.\n` +
            `The files already exist on disk — do NOT rewrite from scratch. Read the existing files, identify the specific problems, and fix ONLY those.\n\n` +
            `Issues to fix:\n${unresolvedIssues.map(i => `- ${i}`).join("\n")}\n\n` +
            `Steps:\n1. read_file each file mentioned in the issues\n` +
            `2. Identify the specific stub/placeholder/missing logic\n` +
            `3. Replace it with a real, working implementation\n` +
            `4. Verify your fix by re-reading the file`
          messages.push({ role: "user", content: repairMsg })
        }
      }
    }

    // ── Direct tool loop ────────────────────────────────────────

    // Structured tool loop state (agenc-core pattern):
    // Tracks per-call failures, all-fail rounds, and semantic duplicates
    // for 3-level stuck detection.
    const toolLoopState: ToolLoopState = {
      lastFailKey: "",
      consecutiveFailCount: 0,
    }
    const roundStuckState: RoundStuckState = {
      consecutiveAllFailedRounds: 0,
      lastRoundSemanticKey: "",
      consecutiveSemanticDuplicateRounds: 0,
    }
    // Track seen semantic keys for round progress summary
    const seenSuccessfulSemanticKeys = new Set<string>()
    const seenVerificationFailureDiagKeys = new Set<string>()
    const recentRoundSummaries: ToolRoundProgressSummary[] = []

    // Recovery hint dedup — each hint key emitted at most once per run
    const emittedRecoveryHints = new Set<string>()

    // Circuit breaker — prevent infinite tool failure loops (ported from agenc-core)
    const circuitBreaker = new ToolFailureCircuitBreaker()

    // Track whether the last tool round included a delegation call.
    // Used for post-delegation verification enforcement.
    let lastRoundHadDelegation = false
    // Track if the child wrote code/HTML files and hasn't verified them yet.
    let wroteUnverifiedFiles = false
    // One-shot: only fire WRITE-WITHOUT-VERIFY nudge once to avoid infinite loops.
    let writeVerifyNudged = false
    // Track written code files that haven't been re-read via read_file.
    // browser_check checks for JS errors but NOT logical correctness.
    // This set is only cleared when the child reads back the specific file.
    const writtenButNotReread = new Set<string>()
    // One-shot: only fire WRITE-WITHOUT-REVIEW nudge once.
    let writeReviewNudged = false
    // Track if the agent is in the "post-delegation verification" phase.
    // Set true when the verification guard fires, cleared after the verification round.
    let inPostDelegationVerification = false
    // Track if the last round was a post-delegation verification that found issues.
    // When true, the agent must act on those issues (re-delegate or fix) — not just finish.
    let verificationFoundIssues = false
    // Track if we already nudged for early exit (only once per run).
    let earlyExitNudged = false
    // Track if we already nudged for budget awareness (only once per run).
    let budgetNudged = false
    // Track if we already ran the completion validator (only once per run).
    let completionValidated = false

    for (let i = resume?.iteration ?? 0; i < this.config.maxIterations; i++) {
      if (this.config.signal?.aborted) {
        return "Agent was cancelled."
      }

      // Budget awareness: when 80% of iterations used, nudge once to wrap up
      const remaining = this.config.maxIterations - i
      if (!budgetNudged && remaining <= Math.max(Math.ceil(this.config.maxIterations * 0.2), 2)) {
        budgetNudged = true
        const budgetMsg =
            `⚠ ITERATION BUDGET: You have ${remaining} iteration(s) remaining out of ${this.config.maxIterations}. ` +
            `Prioritize COMPLETING your current work over perfecting it. ` +
            `Finish writing any pending files, run a quick verification, and wrap up. ` +
            `Do NOT start new refactors or rewrites — finalize what you have.`
        messages.push({ role: "system", content: budgetMsg, section: "history" })
        this.config.onNudge?.({ tag: "budget-warning", message: budgetMsg, iteration: i })
      }

      if (this.config.verbose) log.logIteration(i, this.config.maxIterations)

      // Truncate context if approaching token budget
      const truncationResult = truncateMessages(messages)
      const chatMessages = truncationResult.messages

      // Emit prompt-budget trace when budget system was activated
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
          const truncMsg =
              "⚠ OUTPUT TRUNCATED: Your last response was cut off because it exceeded the completion token limit. " +
              "You MUST break your work into smaller pieces. When writing files, split them into multiple smaller write_file calls " +
              "(e.g. write a skeleton first, then append sections). Do NOT put an entire large file in a single write_file call."
          messages.push({ role: "system", content: truncMsg, section: "history" })
          this.config.onNudge?.({ tag: "output-truncated", message: truncMsg, iteration: i })
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
          const earlyMsg =
              "You returned a text response without using any tools. " +
              "You MUST use your tools to accomplish the goal — do not just describe a plan. " +
              "Start working now by calling the appropriate tools."
          messages.push({ role: "system", content: earlyMsg, section: "history" })
          this.config.onNudge?.({ tag: "early-exit-nudge", message: earlyMsg, iteration: i })
          continue
        }

        // Guard: if the previous round had a delegation, the agent must
        // verify the result with a tool call before finishing.
        if (lastRoundHadDelegation) {
          lastRoundHadDelegation = false
          inPostDelegationVerification = true
          messages.push({
            role: "assistant",
            content: response.content,
            section: "history",
          })
          const verifyMsg =
              "VERIFICATION REQUIRED: You just received a delegation result but attempted to " +
              "finish without verifying. You MUST verify with MULTIPLE tools now:\n" +
              "- For web projects → BOTH browser_check on the main HTML file AND read_file on the key JS/code files to check for stubs, TODO comments, or placeholder logic\n" +
              "- For code → run_command to compile/test AND read_file to review implementation quality\n" +
              "- For files → list_directory AND read_file to confirm content and completeness\n" +
              "A page loading without errors does NOT mean it works correctly. You must review the actual code.\n" +
              "Do NOT provide a final answer until you have independently verified the output."
          messages.push({ role: "system", content: verifyMsg, section: "history" })
          this.config.onNudge?.({ tag: "verification-required", message: verifyMsg, iteration: i })
          continue
        }

        // Guard: if the child wrote files but never verified them, force a review.
        // This catches the pattern where the LLM writes corrupted code and immediately exits.
        // One-shot: only fire once to avoid infinite loops where the child rewrites instead of reading.
        if (wroteUnverifiedFiles && !writeVerifyNudged) {
          wroteUnverifiedFiles = false
          writeVerifyNudged = true
          messages.push({
            role: "assistant",
            content: response.content,
            section: "history",
          })
          const writeVerifyMsg =
              "WRITE-WITHOUT-VERIFY: You wrote code files but attempted to finish without " +
              "reviewing them. You MUST use read_file to review every file you wrote — look for " +
              "corrupted code, gibberish, incomplete functions, or syntax errors. Then use " +
              "browser_check or run_command to verify the output actually works. " +
              "Do NOT finish until you have confirmed your code is correct."
          messages.push({ role: "system", content: writeVerifyMsg, section: "history" })
          this.config.onNudge?.({ tag: "write-without-verify", message: writeVerifyMsg, iteration: i })
          continue
        }

        // Guard: if the child wrote code files, ran browser_check, but never
        // re-read the actual code to verify logical correctness. browser_check
        // only detects JS load errors — it can't find semantic bugs like wrong
        // comparison logic, missing features, or broken helper functions.
        // One-shot: only fire once.
        if (writtenButNotReread.size > 0 && !writeReviewNudged) {
          writeReviewNudged = true
          messages.push({
            role: "assistant",
            content: response.content,
            section: "history",
          })
          const fileList = [...writtenButNotReread].slice(0, 5).join(", ")
          const reviewMsg =
              "CODE REVIEW REQUIRED: You wrote code files but only ran browser_check, which " +
              "only catches JavaScript load errors — it cannot verify logical correctness. " +
              `You MUST use read_file to review your code in: ${fileList}\n` +
              "For each file, check:\n" +
              "1. Every helper function does what its name implies (trace through an example)\n" +
              "2. ALL acceptance criteria have corresponding real logic (not just function names)\n" +
              "3. No comparison or logic errors (e.g. case-insensitive compare where case matters)\n" +
              "Do NOT finish until you have read and verified every code file."
          messages.push({ role: "system", content: reviewMsg, section: "history" })
          this.config.onNudge?.({ tag: "code-review-required", message: reviewMsg, iteration: i })
          continue
        }

        // Guard: if verification just found issues, the agent must fix them,
        // not just describe the problem and finish.
        if (verificationFoundIssues) {
          verificationFoundIssues = false
          messages.push({
            role: "assistant",
            content: response.content,
            section: "history",
          })
          const vfailMsg =
              "VERIFICATION FAILED: Your verification step revealed errors, but you attempted " +
              "to finish without fixing them. You MUST either:\n" +
              "1. Fix the issues directly (edit files, run commands)\n" +
              "2. Re-delegate the task with specific error details\n" +
              "Do NOT suggest manual workarounds (like 'start an HTTP server'). Fix the actual problem."
          messages.push({ role: "system", content: vfailMsg, section: "history" })
          this.config.onNudge?.({ tag: "verification-failed", message: vfailMsg, iteration: i })
          continue
        }

        // Guard: completion validator — enforce code quality before allowing exit.
        // Unlike the other guards which check mechanical properties (did you use tools?
        // did you read files?), this reads the ACTUAL code and checks for stubs.
        // Fires at most once per run to prevent infinite loops.
        if (this.config.completionValidator && !completionValidated) {
          completionValidated = true
          try {
            const validationIssues = await this.config.completionValidator()
            if (validationIssues) {
              messages.push({
                role: "assistant",
                content: response.content,
                section: "history",
              })
              messages.push({ role: "system", content: validationIssues, section: "history" })
              this.config.onNudge?.({ tag: "completion-validator", message: validationIssues, iteration: i })
              continue
            }
          } catch { /* validator failed — don't block the agent */ }
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
      const roundToolCalls: ToolCallRecord[] = []

      // Circuit breaker check — stop retrying if breaker is open
      const circuitStatus = circuitBreaker.getActiveCircuit()
      if (circuitStatus) {
        const cbMsg = `CIRCUIT BREAKER: ${circuitStatus.reason} — change your approach.`
        messages.push({ role: "system", content: cbMsg, section: "history" })
        this.config.onNudge?.({ tag: "circuit-breaker", message: cbMsg, iteration: i })
        if (this.config.verbose) log.logError(`Circuit breaker open: ${circuitStatus.reason}`)
        continue
      }

      for (const call of response.toolCalls) {
        if (this.config.signal?.aborted) {
          return "Agent was cancelled."
        }
        if (this.config.verbose) log.logToolCall(call.name, call.arguments)

        const semanticKey = buildSemanticToolCallKey(call.name, call.arguments as Record<string, unknown>)
        const tool = this.tools.get(call.name)
        if (!tool) {
          const errMsg = `Unknown tool "${call.name}". Available: ${[...this.tools.keys()].join(", ")}`
          if (this.config.verbose) log.logToolError(errMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: errMsg, section: "history" })
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: errMsg, isError: true })
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
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: errMsg, isError: true })
          failuresThisRound++
          continue
        }

        // Execute with timeout racing + transport-failure retry (agenc-core pattern)
        // Race against per-tool-call kill signal so the user can abort individual tools.
        const killManager = this.config.toolKillManager
        const killPromise = killManager?.register(call.id, call.name)

        let execResult: Awaited<ReturnType<typeof executeToolWithTimeout>>
        let killed = false
        let killMessage = ""

        if (killPromise) {
          const result = await Promise.race([
            executeToolWithTimeout(
              call.name,
              call.arguments as Record<string, unknown>,
              (a) => tool.execute(a),
              {
                toolCallTimeoutMs: 0,
                maxRetries: 1,
                signal: this.config.signal,
              },
            ).then((r) => ({ kind: "exec" as const, value: r })),
            killPromise.then((msg: string) => ({ kind: "kill" as const, value: msg })),
          ])
          if (result.kind === "kill") {
            killed = true
            killMessage = result.value
            execResult = { result: "", isError: true, timedOut: false, retryCount: 0, toolFailed: false, durationMs: 0 }
          } else {
            execResult = result.value
          }
          killManager!.unregister(call.id)
        } else {
          execResult = await executeToolWithTimeout(
            call.name,
            call.arguments as Record<string, unknown>,
            (a) => tool.execute(a),
            {
              toolCallTimeoutMs: 0,
              maxRetries: 1,
              signal: this.config.signal,
            },
          )
        }

        if (killed) {
          const msg = `[TOOL KILLED BY USER] ${killMessage}`
          if (this.config.verbose) log.logToolError(msg)
          messages.push({ role: "tool", toolCallId: call.id, content: msg, section: "history" })
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: msg, isError: true })
          failuresThisRound++
          continue
        }

        if (execResult.isError) {
          if (this.config.verbose) log.logToolError(execResult.result)
          messages.push({ role: "tool", toolCallId: call.id, content: execResult.result, section: "history" })
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: execResult.result, isError: true })
          failuresThisRound++
          circuitBreaker.recordFailure(semanticKey, call.name)
          trackToolCallFailureState(true, semanticKey, toolLoopState)
        } else {
          const enriched = enrichResult(execResult.result, {})
          if (this.config.verbose) log.logToolResult(enriched)
          messages.push({ role: "tool", toolCallId: call.id, content: enriched, section: "history" })
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: enriched, isError: false })

          // Circuit breaker: clear on success, record if "success" is a semantic failure
          if (didToolCallFail(false, enriched)) {
            circuitBreaker.recordFailure(semanticKey, call.name)
            trackToolCallFailureState(true, semanticKey, toolLoopState)
          } else {
            circuitBreaker.clearPattern(semanticKey)
            trackToolCallFailureState(false, semanticKey, toolLoopState)
          }

          if (call.name === "delegate" || call.name === "delegate_parallel") {
            delegationThisRound = true
          }

          // Track write-without-verify: if the child writes code/HTML, mark as unverified.
          // read_file, run_command, AND browser_check clear the flag.
          // browser_check launches a real browser that checks for JS errors — this counts
          // as verification. Without this, children that properly verify via browser_check
          // get a spurious WRITE-WITHOUT-VERIFY nudge, wasting iterations.
          if (call.name === "write_file") {
            const writePath = String((call.arguments as Record<string, unknown>).path ?? "")
            if (/\.(js|jsx|ts|tsx|py|html?|css|json)$/i.test(writePath)) {
              wroteUnverifiedFiles = true
              // Track for code review: only read_file on this specific file clears it
              if (/\.(js|jsx|ts|tsx|py)$/i.test(writePath)) {
                writtenButNotReread.add(writePath)
              }
            }
          }
          if (call.name === "read_file") {
            wroteUnverifiedFiles = false
            // Clear the specific file from the re-read tracking
            const readPath = String((call.arguments as Record<string, unknown>).path ?? "")
            writtenButNotReread.delete(readPath)
          }
          if (call.name === "run_command" || call.name === "browser_check") {
            wroteUnverifiedFiles = false
          }
        }
      }

      // ── Accumulate tool calls for parent access ──
      this.allToolCalls.push(...roundToolCalls)

      // ── Structured stuck detection (3-level, agenc-core pattern) ──
      const stuckResult = checkToolLoopStuckDetection(
        roundToolCalls,
        toolLoopState,
        roundStuckState,
      )
      if (stuckResult.shouldBreak) {
        const stuckMsg = `STUCK DETECTION: ${stuckResult.reason ?? "Tool loop is stuck."}`
        messages.push({ role: "system", content: stuckMsg, section: "history" })
        this.config.onNudge?.({ tag: "stuck-detection", message: stuckMsg, iteration: i })
        if (this.config.verbose) log.logError(`Stuck: ${stuckResult.reason}`)

        // Hard break — stop the loop
        const answer = response.content ?? "(Agent stuck in a tool loop — terminating.)"
        if (this.config.verbose) log.logFinalAnswer(answer)
        return answer
      }

      // ── Round progress summary + adaptive budget extension (agenc-core pattern) ──
      const roundStartMs = Date.now()
      const roundProgress = summarizeToolRoundProgress(
        roundToolCalls,
        Date.now() - roundStartMs,
        seenSuccessfulSemanticKeys,
        seenVerificationFailureDiagKeys,
      )
      recentRoundSummaries.push(roundProgress)
      // Keep only last 5 round summaries for extension evaluation
      if (recentRoundSummaries.length > 5) recentRoundSummaries.shift()

      if (roundProgress.hadVerificationCall || roundProgress.hadSuccessfulMutation) {
        const budgetExt = evaluateToolRoundBudgetExtension({
          currentLimit: this.config.maxIterations,
          maxAbsoluteLimit: this.config.maxIterations + 10,
          recentRounds: recentRoundSummaries,
          remainingToolBudget: this.config.maxIterations - i,
        })
        if (budgetExt.decision === "extended" && budgetExt.newLimit > this.config.maxIterations) {
          if (this.config.verbose) {
            log.logError(`Budget extension: ${this.config.maxIterations} → ${budgetExt.newLimit} (${budgetExt.extensionReason})`)
          }
          this.config.maxIterations = budgetExt.newLimit
        }
      }

      // Checkpoint after tool execution round
      lastRoundHadDelegation = delegationThisRound

      // Recovery hints: scan for known failure patterns and inject targeted advice
      const recoveryHints = buildRecoveryHints(roundToolCalls, emittedRecoveryHints)
      for (const hint of recoveryHints) {
        const hintMsg = `RECOVERY HINT: ${hint.message}`
        messages.push({ role: "system", content: hintMsg, section: "history" })
        this.config.onNudge?.({ tag: `recovery-hint:${hint.key}`, message: hintMsg, iteration: i })
        if (this.config.verbose) {
          log.logError(`Recovery hint [${hint.key}]: ${hint.message.slice(0, 100)}`)
        }
      }

      // After a post-delegation verification round, check if the verification
      // tools reported problems (errors, failures) or if the verification was 
      // superficial (no code review). If so, the agent must act.
      if (inPostDelegationVerification) {
        inPostDelegationVerification = false
        // Scan tool results from this round for error signals
        const roundToolResults = messages
          .slice(-response.toolCalls.length * 2) // tool results are the last N messages
          .filter((m) => m.role === "tool")
          .map((m) => m.content ?? "")
        const hasErrors = roundToolResults.some((r) =>
          /error|fail|exception|not found/i.test(r) && !/no errors/i.test(r),
        )
        // Check if the agent did a code review (read_file) during verification
        const toolNamesUsed = response.toolCalls.map((c) => c.name)
        const didCodeReview = toolNamesUsed.includes("read_file")
        const didOnlySurfaceCheck = !didCodeReview && (
          toolNamesUsed.includes("browser_check") || toolNamesUsed.includes("list_directory")
        )
        if (hasErrors || failuresThisRound > 0) {
          verificationFoundIssues = true
        } else if (didOnlySurfaceCheck) {
          inPostDelegationVerification = true
          const incompleteMsg =
              "INCOMPLETE VERIFICATION: You ran browser_check or list_directory but did NOT review " +
              "the actual code with read_file. A page loading without JS errors does NOT mean the logic is correct. " +
              "You MUST now use read_file on the main code files (JS/TS) to verify that:\n" +
              "- All functions contain REAL logic (not stubs like `return true`)\n" +
              "- All required features exist (not just a skeleton)\n" +
              "- There are no TODO comments or placeholder implementations\n" +
              "If you find issues, fix them directly or re-delegate."
          messages.push({ role: "system", content: incompleteMsg, section: "history" })
          this.config.onNudge?.({ tag: "incomplete-verification", message: incompleteMsg, iteration: i })
        }
      }

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

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
import { applyFullCompaction, shouldApplyFullCompaction } from "./context-compaction.js"
import * as log from "./logger.js"
import {
  buildCoherentGenerationMessages,
  buildCoherentPlannerEscalationGoal,
  buildCoherentRepairInstructions,
  buildCoherentVerificationPipelineResult,
  buildCoherentVerificationPlan,
  materializeCoherentSolutionBundle,
  parseCoherentSolutionBundle,
  summarizeCoherentVerifierDecision,
} from "./planner/coherent.js"
import { assessPlannerDecision } from "./planner/decision.js"
import type { PlannerContext } from "./planner/index.js"
import { executePlannerPath } from "./planner/index.js"
import type { CoherentSolutionBundle, Plan, VerifierDecision } from "./planner/types.js"
import { verify } from "./planner/verifier.js"
import { applyPromptBudget, type PromptBudgetDiagnostics } from "./prompt-budget.js"
import type { ToolCallRecord } from "./recovery.js"
import { buildRecoveryHints, buildSemanticToolCallKey, didToolCallFail } from "./recovery.js"
import { applyToolContractGuidance, resolveToolContractGuidance, type ToolContractContext } from "./tool-contract-guidance.js"
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
const FILE_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "append_file"])

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

// ============================================================================
// Progressive context compaction
// ============================================================================

/**
 * How many recent iterations to preserve in full detail.
 * Tool results within this window are kept verbatim.
 * Older results are compacted to summaries.
 */
const COMPACT_PRESERVE_RECENT = 3

/**
 * Tool results shorter than this (chars) are never compacted — they're cheap.
 */
const COMPACT_MIN_SIZE = 500

/**
 * Progressive context compaction — the key to preventing LLM degeneration.
 *
 * Instead of keeping all tool results verbatim until hard truncation drops
 * entire messages, this function surgically compacts old tool results while
 * preserving their semantic signal. This keeps the LLM focused on what
 * matters NOW rather than drowning in stale file contents.
 *
 * Three compaction strategies:
 *   1. Superseded reads: If file X was read, then later written/replaced,
 *      the old read result is actively misleading — compact it.
 *   2. Superseded writes: If file X was written multiple times, only the
 *      LAST write's content matters — earlier writes are compacted.
 *   3. Old tool results: Tool results from >3 iterations ago that are
 *      large (>500 chars) are compacted to a summary line.
 *
 * This is how enterprise systems (Copilot, Cursor, agenc-core) maintain
 * output quality across long agent sessions. Without it, the LLM's
 * attention gets diluted across 50K+ tokens of stale file dumps.
 */
/** @internal — exported for testing */
export function compactMessages(messages: Message[]): Message[] {
  // Build a timeline: for each message, determine which iteration it belongs to.
  // An "iteration" boundary is each assistant message with tool calls.
  const iterationOf = new Map<number, number>()
  let currentIteration = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      currentIteration++
    }
    iterationOf.set(i, currentIteration)
  }
  const latestIteration = currentIteration

  // --- Pass 1: Track file read/write history ---
  // Map: filePath → index of last write (write_file or replace_in_file) tool CALL
  const lastWriteOf = new Map<string, number>()
  // Map: filePath → index of last read (read_file) tool CALL
  const lastReadOf = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "assistant" || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      const args = tc.arguments as Record<string, unknown>
      const path = extractFilePath(tc.name, args)
      if (!path) continue
      if (tc.name === "write_file" || tc.name === "replace_in_file") {
        lastWriteOf.set(path, i)
      } else if (tc.name === "read_file") {
        lastReadOf.set(path, i)
      }
    }
  }

  // --- Pass 2: Identify which tool-result messages to compact ---
  // A tool result is compactable if:
  //   a) It's a read_file result for a file that was later written (superseded)
  //   b) It's a write_file result for a file that was later re-written (superseded)
  //   c) It's old (>COMPACT_PRESERVE_RECENT iterations ago) and large (>COMPACT_MIN_SIZE chars)
  //
  // We also need to match tool RESULTS to their tool CALLS.
  // The flow is: assistant message (with toolCalls) → tool result messages (one per call).
  // We match by toolCallId.

  // Build a map from toolCallId → { tool name, file path, assistant message index }
  const toolCallMeta = new Map<string, { name: string; path: string | null; assistantIdx: number }>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "assistant" || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      const args = tc.arguments as Record<string, unknown>
      toolCallMeta.set(tc.id, {
        name: tc.name,
        path: extractFilePath(tc.name, args),
        assistantIdx: i,
      })
    }
  }

  // --- Pass 3: Build compacted messages ---
  const result: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    // Strategy 4: Compact old assistant tool call ARGUMENTS.
    // When the LLM calls write_file, the FULL file content appears in
    // assistant.toolCalls[].arguments.content — this is sent to the API
    // in addition to the tool result. A 300-line write doubles to ~20K.
    // Compact the arguments of old/superseded tool calls.
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const iter = iterationOf.get(i) ?? 0
      const age = latestIteration - iter
      let needsCompaction = false

      if (age > COMPACT_PRESERVE_RECENT) {
        // Check if any tool call has large arguments
        needsCompaction = m.toolCalls.some((tc) => {
          const args = tc.arguments as Record<string, unknown>
          const content = typeof args.content === "string" ? args.content : ""
          return content.length >= COMPACT_MIN_SIZE
        })
      } else {
        // Even recent calls: compact arguments for superseded writes
        needsCompaction = m.toolCalls.some((tc) => {
          if (tc.name !== "write_file" && tc.name !== "replace_in_file") return false
          const args = tc.arguments as Record<string, unknown>
          const content = typeof args.content === "string" ? args.content : ""
          if (content.length < COMPACT_MIN_SIZE) return false
          const path = extractFilePath(tc.name, args)
          if (!path) return false
          const lastWrite = lastWriteOf.get(path)
          return lastWrite != null && lastWrite > i
        })
      }

      if (needsCompaction) {
        const compactedCalls = m.toolCalls.map((tc) => {
          const args = tc.arguments as Record<string, unknown>
          const content = typeof args.content === "string" ? args.content : ""
          if (content.length < COMPACT_MIN_SIZE) return tc

          const path = extractFilePath(tc.name, args)
          const isSuperseded = path != null && lastWriteOf.has(path) && lastWriteOf.get(path)! > i
          const isOld = age > COMPACT_PRESERVE_RECENT

          if (isSuperseded || isOld) {
            const lineCount = content.split("\n").length
            return {
              ...tc,
              arguments: {
                ...args,
                content: `[compacted — ${lineCount} lines, see tool result]`,
              },
            }
          }
          return tc
        })
        result.push({ ...m, toolCalls: compactedCalls })
      } else {
        result.push(m)
      }
      continue
    }

    // Only compact tool result messages
    if (m.role !== "tool" || !m.toolCallId || !m.content || m.content.length < COMPACT_MIN_SIZE) {
      result.push(m)
      continue
    }

    const meta = toolCallMeta.get(m.toolCallId)
    if (!meta) {
      result.push(m)
      continue
    }

    const iter = iterationOf.get(meta.assistantIdx) ?? 0
    const age = latestIteration - iter

    // Strategy 1: Superseded read — file was read then later written
    if (meta.name === "read_file" && meta.path && lastWriteOf.has(meta.path)) {
      const writeIdx = lastWriteOf.get(meta.path)!
      if (writeIdx > meta.assistantIdx) {
        // This read result is stale — the file was modified after this read
        const lineCount = m.content.split("\n").length
        result.push({
          ...m,
          content: `[compacted — file was modified later] read_file ${meta.path}: ${lineCount} lines (superseded by later write)`,
        })
        continue
      }
    }

    // Strategy 2: Superseded write — file was written then later re-written
    if ((meta.name === "write_file" || meta.name === "replace_in_file") && meta.path && lastWriteOf.has(meta.path)) {
      const lastWrite = lastWriteOf.get(meta.path)!
      if (lastWrite > meta.assistantIdx) {
        // This write was superseded — a later write overwrote this file
        const lineCount = m.content.split("\n").length
        result.push({
          ...m,
          content: `[compacted — file was rewritten later] ${meta.name} ${meta.path}: ${lineCount} lines (superseded)`,
        })
        continue
      }
    }

    // Strategy 3: Old large results — compact anything old regardless of tool type
    if (age > COMPACT_PRESERVE_RECENT) {
      result.push({
        ...m,
        content: compactToolResult(meta.name, meta.path, m.content),
      })
      continue
    }

    // Recent enough — keep verbatim
    result.push(m)
  }

  return result
}

/**
 * Produce a compact summary of a tool result.
 * The summary preserves the SIGNAL (what happened) while dropping the BULK (raw content).
 */
function compactToolResult(toolName: string, filePath: string | null, content: string): string {
  const lineCount = content.split("\n").length
  const charCount = content.length
  const pathLabel = filePath ? ` ${filePath}` : ""
  const semanticSuffix = buildCompactedSemanticSuffix(filePath, content)

  switch (toolName) {
    case "read_file":
      return `[compacted] read_file${pathLabel}: ${lineCount} lines, ${charCount} chars${semanticSuffix}`
    case "write_file": {
      return `[compacted] write_file${pathLabel}: ${lineCount} lines, ${charCount} chars${semanticSuffix}`
    }
    case "replace_in_file":
      return `[compacted] replace_in_file${pathLabel}: replacement applied (${charCount} chars in result)${semanticSuffix}`
    case "run_command": {
      // Keep first and last few lines (often the error or summary)
      const lines = content.split("\n")
      if (lines.length <= 10) return content
      const head = lines.slice(0, 3).join("\n")
      const tail = lines.slice(-3).join("\n")
      return `[compacted] run_command (${lineCount} lines):\n${head}\n  ... (${lineCount - 6} lines omitted) ...\n${tail}`
    }
    case "list_directory":
      return `[compacted] list_directory${pathLabel}: ${lineCount} entries`
    case "search_files":
      return `[compacted] search_files: ${lineCount} result lines`
    case "browser_check": {
      // Keep the status but trim long DOM dumps
      if (charCount < 1000) return content
      return content.slice(0, 800) + `\n... (${charCount - 800} chars omitted)`
    }
    default:
      if (charCount < 500) return content
      return `[compacted] ${toolName}${pathLabel} (${charCount} chars)${semanticSuffix || `: ${extractCompactExcerpt(content)}`}`
  }
}

function buildCompactedSemanticSuffix(filePath: string | null, content: string): string {
  const defs = extractDefinitionSummary(content)
  if (defs) return ` — symbols: ${defs}`
  const excerpt = extractCompactExcerpt(content)
  if (!excerpt) return ""
  const label = filePath && /\.(?:json|ya?ml|toml|md|txt|rst|adoc)$/i.test(filePath)
    ? "summary"
    : "excerpt"
  return ` — ${label}: ${excerpt}`
}

function extractCompactExcerpt(content: string, maxLen = 160): string {
  const firstMeaningfulLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 8 && !/^[/#*\-_=]{3,}$/.test(line))
    ?? ""
  if (!firstMeaningfulLine) return ""
  const normalized = firstMeaningfulLine.replace(/\s+/g, " ")
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized
}

/**
 * Extract a brief summary of definitions (function/class/const names) from code content.
 */
function extractDefinitionSummary(code: string): string | null {
  const names: string[] = []
  const patterns = [
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g,
    /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)\s*\(/g,
    /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/g,
  ]

  for (const re of patterns) {
    let match
    while ((match = re.exec(code)) !== null) {
      if (!names.includes(match[1])) names.push(match[1])
    }
  }
  if (names.length === 0) return null
  if (names.length <= 10) return names.join(", ")
  return names.slice(0, 10).join(", ") + ` (+${names.length - 10} more)`
}

/**
 * Extract file path from a tool call's arguments.
 * Different tools use different arg names for file paths.
 */
function extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
  // Common arg names for file path
  for (const key of ["path", "filePath", "file_path", "file", "filename"]) {
    if (typeof args[key] === "string") return args[key] as string
  }
  // write_file often uses "path" at top level
  if (toolName === "write_file" && typeof args.path === "string") return args.path as string
  if (toolName === "read_file" && typeof args.path === "string") return args.path as string
  return null
}

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
 * Generates a progress summary from dropped messages so the LLM knows what it already did.
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
  const droppedTail = tail.slice(0, -keepCount)
  const keptTail = tail.slice(-keepCount)

  // Build a progress summary from the dropped messages
  const summary = buildDroppedHistorySummary(droppedTail)

  return [
    ...head,
    { role: "system" as const, content: summary, section: "history" as PromptBudgetSection },
    ...keptTail,
  ]
}

/**
 * Build a concise progress summary from messages that are about to be dropped.
 * This tells the LLM what it already accomplished so it doesn't redo work.
 */
function buildDroppedHistorySummary(dropped: Message[]): string {
  const actions: string[] = []
  const notableResults: string[] = []
  const filesWritten = new Set<string>()
  const filesRead = new Set<string>()
  const toolCallMeta = new Map<string, { name: string; path: string | null; command: string | null }>()

  for (const m of dropped) {
    if (m.role !== "assistant" || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      const args = tc.arguments as Record<string, unknown>
      const path = extractFilePath(tc.name, args)
      toolCallMeta.set(tc.id, {
        name: tc.name,
        path,
        command: typeof args.command === "string" ? args.command : null,
      })

      switch (tc.name) {
        case "write_file":
          if (path && !filesWritten.has(path)) {
            filesWritten.add(path)
            actions.push(`wrote ${path}`)
          }
          break
        case "replace_in_file":
          if (path) actions.push(`edited ${path}`)
          break
        case "read_file":
          if (path && !filesRead.has(path)) {
            filesRead.add(path)
            actions.push(`read ${path}`)
          }
          break
        case "run_command": {
          const cmd = typeof args.command === "string"
            ? args.command.slice(0, 60)
            : "command"
          actions.push(`ran: ${cmd}`)
          break
        }
        case "delegate":
        case "delegate_parallel":
          actions.push(`delegated: ${typeof args.goal === "string" ? args.goal.slice(0, 80) : "subtask"}`)
          break
        case "browser_check":
          if (path) actions.push(`browser-checked ${path}`)
          break
        default:
          actions.push(`called ${tc.name}`)
      }
    }
  }

  for (const m of dropped) {
    if (m.role !== "tool" || !m.toolCallId || !m.content) continue
    const meta = toolCallMeta.get(m.toolCallId)
    if (!meta) continue
    const normalized = m.content.replace(/\s+/g, " ").trim()
    const short = normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized
    const pathLabel = meta.path ? ` ${meta.path}` : ""

    if (/^Error:|\b(?:failed|exception|traceback|syntax error|enoent|eacces|permission denied)\b/i.test(normalized) && !/\bno errors\b/i.test(normalized)) {
      notableResults.push(`${meta.name}${pathLabel} failed: ${short}`)
      continue
    }

    if (meta.name === "browser_check" && /\bno errors\b|\bpassed\b/i.test(normalized)) {
      notableResults.push(`browser_check${pathLabel} passed`)
      continue
    }

    if (meta.name === "run_command" && /\b(?:passed|success|0 failed|build succeeded|compiled successfully)\b/i.test(normalized)) {
      const commandLabel = meta.command ? meta.command.slice(0, 50) : "command"
      notableResults.push(`run_command succeeded: ${commandLabel}`)
    }
  }

  if (actions.length === 0 && notableResults.length === 0) {
    return "[Earlier conversation truncated to save context budget.]"
  }

  // Cap at 15 actions to keep the summary concise
  const displayed = actions.length <= 15
    ? actions
    : [...actions.slice(0, 12), `... and ${actions.length - 12} more actions`]
  const displayedResults = notableResults.length <= 8
    ? notableResults
    : [...notableResults.slice(0, 6), `... and ${notableResults.length - 6} more notable results`]

  return (
    "[Earlier conversation truncated. Here is what you already did:]\n" +
    (displayed.length > 0 ? displayed.map((a) => `- ${a}`).join("\n") : "- no retained action summary") +
    (displayedResults.length > 0
      ? `\n[Notable results:]\n${displayedResults.map((item) => `- ${item}`).join("\n")}`
      : "") +
    "\n[Do NOT repeat these actions. Continue from where you left off.]"
  )
}

/** Legacy truncation for non-sectioned messages. */
function truncateLegacy(messages: Message[]): Message[] {
  const head = messages.slice(0, 2)
  let tailSize = 4
  while (tailSize < messages.length - 2) {
    const dropped = messages.slice(2, messages.length - tailSize)
    const summary = buildDroppedHistorySummary(dropped)
    const candidate = [...head, { role: "system" as const, content: summary }, ...messages.slice(-tailSize)]
    if (estimateTokens(candidate) > MAX_CONTEXT_TOKENS) {
      tailSize = Math.max(4, tailSize - 2)
      break
    }
    tailSize += 2
  }
  const dropped = messages.slice(2, messages.length - tailSize)
  const summary = buildDroppedHistorySummary(dropped)
  return [
    ...head,
    { role: "system" as const, content: summary },
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
- Use run_command with ls, cd, cp, mv, rm, find, sed, awk, grep, wc, cut, sort, tr, wget, curl, ping, which, whereis, locate, uniq, ps, kill, top, xargs, tee, sed, awk, etc. A single shell pipeline replaces dozens of tool calls.
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
    let coherentExecution: {
      bundle: CoherentSolutionBundle
      verificationPlan: Plan
      repairAttempts: number
      escalated: boolean
      lastVerifierDecision?: VerifierDecision
      lastVerifiedToolCallCount: number
    } | null = null

    const runCoherentVerification = async (force = false): Promise<VerifierDecision | null> => {
      if (!coherentExecution) return null
      if (!force && coherentExecution.lastVerifierDecision && coherentExecution.lastVerifiedToolCallCount === this.allToolCalls.length) {
        return coherentExecution.lastVerifierDecision
      }

      const decision = await verify(
        this.llm,
        coherentExecution.verificationPlan,
        buildCoherentVerificationPipelineResult(coherentExecution.bundle, this.allToolCalls),
        this.toolList,
        {
          signal: this.config.signal,
          onTrace: this.config.onPlannerTrace,
          skipContractValidation: true,
        },
      )

      coherentExecution.lastVerifierDecision = decision
      coherentExecution.lastVerifiedToolCallCount = this.allToolCalls.length

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

    // ── Planner-first routing (agenc-core pattern) ──────────────
    // For complex tasks (score >= 3), try the planner path BEFORE falling
    // through to the direct tool loop. This produces structured plans with
    // typed execution envelopes for higher delegation quality.
    if (this.config.enablePlanner && !resume && this.config.plannerDelegateFn) {
      this.config.onPlannerTrace?.({ kind: "planning_preflight", mode: "planner-first" })

      const plannerCtx = createPlannerContext()

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

      // Layer 4 LLM routing: pass this.llm so the router can classify
      // ambiguous tasks rather than relying on regex alone.
      const routingDecision = await assessPlannerDecision(goal, messages, this.llm, this.config.signal)

      // Track whether coherent generation fails so we can apply delay commitment:
      // try coherent → if it produces no bundle, escalate to planner rather
      // than dropping all the way to the unstructured direct tool loop.
      let coherentGenerationFailed = false

      if (routingDecision.route === "bounded_coherent_generation") {
        this.config.onPlannerTrace?.({ kind: "coherent-generation-start", route: routingDecision.route })
        this.config.onPlannerTrace?.({
          kind: "planner-architecture-state",
          lane: routingDecision.route,
          status: "preserved",
          reason: "coherent_lane_selected",
        })

        const coherentMessages = buildCoherentGenerationMessages(goal, this.config.workspaceRoot, messages)
        this.config.onLlmCall?.({
          phase: "request",
          messages: coherentMessages,
          tools: [],
          iteration: 0,
        })

        const t0 = Date.now()
        const coherentResponse = await this.llm.chat(coherentMessages, [], { signal: this.config.signal, maxTokens: 16384 })
        const durationMs = Date.now() - t0
        this.llmCalls++
        this.config.onLlmCall?.({
          phase: "response",
          response: coherentResponse,
          iteration: 0,
          durationMs,
        })
        if (coherentResponse.usage) {
          this.usage.promptTokens += coherentResponse.usage.promptTokens
          this.usage.completionTokens += coherentResponse.usage.completionTokens
          this.usage.totalTokens += coherentResponse.usage.totalTokens
        }

        const coherentParse = parseCoherentSolutionBundle(coherentResponse.content ?? "")
        if (coherentParse.bundle) {
          this.config.onPlannerTrace?.({
            kind: "coherent-generation-bundle",
            artifactCount: coherentParse.bundle.artifacts.length,
            artifacts: coherentParse.bundle.artifacts.map((artifact) => ({ path: artifact.path, purpose: artifact.purpose })),
            sharedContracts: coherentParse.bundle.sharedContracts?.map((contract) => contract.name) ?? [],
            invariants: coherentParse.bundle.invariants?.map((invariant) => invariant.id) ?? [],
          })

          const materialized = await materializeCoherentSolutionBundle(coherentParse.bundle, {
            writeFileTool: this.tools.get("write_file"),
            readFileTool: this.tools.get("read_file"),
          })

          for (const artifact of coherentParse.bundle.artifacts) {
            const written = materialized.writtenArtifacts.includes(artifact.path)
            this.allToolCalls.push({
              name: written ? "write_file" : "write_file",
              args: { path: artifact.path, content: artifact.content },
              result: written ? "coherent bundle materialized" : `Error: bundle materialization skipped for ${artifact.path}`,
              isError: !written,
            })
          }
          for (const artifactPath of materialized.readBackArtifacts) {
            this.allToolCalls.push({
              name: "read_file",
              args: { path: artifactPath },
              result: "coherent bundle read-back completed",
              isError: false,
            })
          }

          if (materialized.diagnostics.length === 0) {
            coherentExecution = {
              bundle: coherentParse.bundle,
              verificationPlan: buildCoherentVerificationPlan(coherentParse.bundle, this.config.workspaceRoot),
              repairAttempts: 0,
              escalated: false,
              lastVerifiedToolCallCount: -1,
            }

            this.config.onPlannerTrace?.({
              kind: "coherent-generation-materialized",
              artifactCount: materialized.writtenArtifacts.length,
              artifacts: [...materialized.writtenArtifacts],
              readBackArtifacts: [...materialized.readBackArtifacts],
            })

            messages.push({
              role: "assistant",
              content:
                `Coherent solution bundle materialized with ${materialized.writtenArtifacts.length} files. ` +
                `Architecture: ${coherentParse.bundle.architecture}`,
              section: "history",
            })
            messages.push({
              role: "system",
              content:
                `A coherent multi-file solution bundle has already been written to disk for this goal.\n` +
                `Files: ${materialized.writtenArtifacts.join(", ")}\n` +
                `Phase 2 starts now: the coherent verifier owns acceptance. Preserve the architecture and file interfaces, and make only targeted fixes if evidence shows problems.\n` +
                `Do NOT redesign or decompose the solution unless verification proves the architecture is broken.`,
              section: "history",
            })

            const initialCoherentDecision = await runCoherentVerification(true)
            if (initialCoherentDecision && initialCoherentDecision.overall !== "pass") {
              const initialSummary = summarizeCoherentVerifierDecision(initialCoherentDecision)
              this.config.onPlannerTrace?.({
                kind: "coherent-generation-repair-needed",
                repairAttempt: 1,
                issueCount: initialSummary.issueCount,
                issues: [...initialSummary.issues],
                affectedArtifacts: [...initialSummary.affectedArtifacts],
              })
              this.config.onPlannerTrace?.({
                kind: "planner-architecture-state",
                lane: routingDecision.route,
                status: "repairing_in_place",
                reason: "coherent_verifier_requested_repair",
                architecture: coherentParse.bundle.architecture,
              })
              messages.push({
                role: "system",
                content: buildCoherentRepairInstructions(coherentParse.bundle, initialCoherentDecision, 1),
                section: "history",
              })
            }

            this.config.onPlannerTrace?.({
              kind: "coherent-generation-handoff",
              artifactCount: materialized.writtenArtifacts.length,
              verificationRoute: "coherent_verifier_then_direct_tool_loop",
            })
          } else {
            this.config.onPlannerTrace?.({
              kind: "coherent-generation-failed",
              stage: "materialization",
              diagnostics: [...materialized.diagnostics],
            })
            coherentGenerationFailed = true
          }
        } else {
          this.config.onPlannerTrace?.({
            kind: "coherent-generation-failed",
            stage: "bundle_parse",
            diagnostics: [...coherentParse.diagnostics],
          })
          coherentGenerationFailed = true
        }
      }

      // Delay commitment: if coherent generation was attempted but produced no
      // valid bundle, escalate to the planner instead of dropping to the
      // unstructured direct tool loop.  This is the "try coherent → verify →
      // fallback to planner" pattern — the system only over-commits to planning
      // when the simpler path demonstrably failed.
      if (coherentGenerationFailed && this.config.plannerDelegateFn) {
        this.config.onPlannerTrace?.({
          kind: "planner-architecture-state",
          lane: "full_planner_decomposition",
          status: "repairing_in_place",
          reason: "coherent_generation_failed_escalating_to_planner",
        })
        const escalatedResult = await executePlannerPath(
          goal,
          plannerCtx,
          this.config.plannerDelegateFn,
          { forceRoute: "full_planner_decomposition" },
        )
        if (escalatedResult.handled) {
          const answer = escalatedResult.answer ?? "(planner produced no answer)"
          if (this.config.verbose) log.logFinalAnswer(answer)
          return answer
        }
      }

      // Planner declined — fall through to direct tool loop
      if (this.config.verbose && plannerResult.skipReason) {
        log.logError(`Planner skipped: ${plannerResult.skipReason}`)
      }

      let directLoopFallbackSource: "planner_declined" | "planner_verifier_low_complexity" = "planner_declined"

      // If the planner tried but verification failed, prefer a second
      // structured planner pass over falling through to an unstructured loop.
      if (plannerResult.verifierDecision && plannerResult.verifierDecision.overall !== "pass") {
        const unresolvedIssues = plannerResult.verifierDecision.steps
          .filter(s => s.outcome !== "pass")
          .flatMap(s => s.issues.filter(i => !i.startsWith("[non-blocking]")))

        const planStepCount = plannerResult.plan?.steps.length ?? 0
        const uniqueTargetArtifacts = new Set(
          (plannerResult.plan?.steps ?? [])
            .flatMap((step) => step.stepType === "subagent_task"
              ? step.executionContext.targetArtifacts
              : [])
            .map((artifact) => artifact.replace(/^\.\//, "")),
        )
        const isSmallSingleArtifactFallback =
          planStepCount <= 1
          && plannerResult.verifierDecision.steps.length <= 1
          && uniqueTargetArtifacts.size <= 1
        const isComplexPlannerRun = !isSmallSingleArtifactFallback

        if (isComplexPlannerRun) {
          const remediationContext =
            `Planner remediation context:\n` +
            `A previous structured execution failed verification. Generate a revised plan that fixes these exact issues without rewriting unrelated files:\n` +
            unresolvedIssues.map(i => `- ${i}`).join("\n")

          const remediationResult = await executePlannerPath(
            `${goal}\n\n${remediationContext}`,
            {
              ...plannerCtx,
              history: [
                ...messages,
                { role: "system", content: remediationContext, section: "history" },
              ],
            },
            this.config.plannerDelegateFn,
          )

          if (remediationResult.handled) {
            const answer = remediationResult.answer ?? "(planner remediation produced no answer)"
            if (this.config.verbose) log.logFinalAnswer(answer)
            return answer
          }

          // Do NOT fall through to the unstructured tool loop for complex,
          // partially-implemented tasks — that path tends to regress quality.
          const finalFailureAnswer = remediationResult.answer
            ?? plannerResult.answer
            ?? "Planner verification failed after remediation attempts. Structured execution halted to avoid destructive rewrites."
          if (this.config.verbose) log.logFinalAnswer(finalFailureAnswer)
          return finalFailureAnswer
        }

        // Low-complexity fallback: inject tool-aware repair context for direct loop.
        if (unresolvedIssues.length > 0) {
          directLoopFallbackSource = "planner_verifier_low_complexity"
          const hasReplaceInFile = this.toolList.some(t => t.name === "replace_in_file")
          const editInstruction = hasReplaceInFile
            ? "3. Use replace_in_file for surgical fixes — do NOT rewrite entire files"
            : "3. Use write_file only for minimal targeted updates; preserve all existing working code and avoid full-file rewrites"

          const repairMsg =
            `⚠️ AUTONOMOUS REPAIR REQUIRED — ACT IMMEDIATELY, DO NOT ASK PERMISSION.\n\n` +
            `A previous attempt partially completed this task but verification found issues that need fixing.\n` +
            `The files already exist on disk — do NOT rewrite from scratch. Read the existing files, identify the specific problems, and fix ONLY those.\n\n` +
            `Issues to fix:\n${unresolvedIssues.map(i => `- ${i}`).join("\n")}\n\n` +
            `Steps:\n1. read_file each file mentioned in the issues\n` +
            `2. Identify the specific stub/placeholder/missing logic\n` +
            `${editInstruction}\n` +
            `4. Verify your fix by re-reading the file\n\n` +
            `You MUST start fixing immediately. Do NOT respond with a question or ask the user for permission. You are fully authorized to read, modify, and fix these files right now.`
          messages.push({ role: "user", content: repairMsg })
        }
      }

      if (routingDecision.route !== "bounded_coherent_generation") {
        this.config.onPlannerTrace?.({
          kind: "direct_loop_fallback",
          source: directLoopFallbackSource,
          reason: plannerResult.skipReason ?? "Planner declined — continuing in the direct tool loop.",
        })
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

    // Coherent repair read-spin detector: counts consecutive iterations where
    // the LLM only read files and wrote nothing. Resets on any write. When the
    // count reaches the threshold the agent is nudged to stop reading and write.
    let coherentRepairReadOnlyRounds = 0
    const COHERENT_READ_ONLY_ROUND_LIMIT = 2

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
    const artifactsRequiringReadBeforeMutation = new Set<string>()
    const fatalArtifactFailureCounts = new Map<string, number>()
    const blockedArtifactFailureCounts = new Map<string, number>()
    // One-shot: only fire WRITE-WITHOUT-REVIEW nudge once.
    let writeReviewNudged = false
    // Bounded retries: guard against premature handoff/finalization when
    // output still admits missing work. Allow a few nudges, then fall through
    // near iteration budget to avoid infinite loops.
    let prematureHandoffNudges = 0
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
    // Track whether the model has made at least one completion attempt
    // (response with zero tool calls). Used by optional deferred-nudge mode.
    let completionAttempted = false
    // Snapshot of tool calls from the previous iteration — used for contract guidance.
    let lastRoundToolCallsSnapshot: readonly { name: string; isError: boolean }[] = []
    // Full history compaction: tracks when the last ArtifactCompactionState anchor was applied.
    // Initialised to -(FULL_COMPACTION_INTERVAL) so the first eligible compaction fires immediately.
    let lastFullCompactionIteration = -8

    // Fixed ceiling for adaptive budget extension.  Must be computed from the
    // ORIGINAL maxIterations BEFORE the loop mutates it so extensions can't
    // ratchet the cap upward indefinitely.
    const absoluteIterationCap = this.config.maxIterations + 10

    const recordBlockedArtifactFailure = (artifactPath: string, threshold: number, reason: string): string | null => {
      const normalizedPath = normalizeArtifactPath(artifactPath)
      if (!normalizedPath) return null
      const count = (blockedArtifactFailureCounts.get(normalizedPath) ?? 0) + 1
      blockedArtifactFailureCounts.set(normalizedPath, count)
      if (count >= threshold) {
        return `${reason} on ${normalizedPath}. Stopping this agent attempt so the parent can retry or replan from a clean state.`
      }
      return null
    }

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

      // ── Full history compaction (ArtifactCompactionState anchor) ──
      // At intervals, extract a structured snapshot of the agent's progress and
      // replace old history with a compact session anchor message. This is the
      // primary token saver for long sessions (10+ iterations of large outputs).
      if (shouldApplyFullCompaction(messages, i, lastFullCompactionIteration)) {
        const { compacted: fullyCompacted, state } = applyFullCompaction(messages, i)
        messages.splice(0, messages.length, ...fullyCompacted)
        lastFullCompactionIteration = i
        this.config.onNudge?.({
          tag: "context-compaction",
          message:
            `Session checkpoint at iteration ${i}: ${state.writtenFiles.length} file records captured, ` +
            `history compacted from ${messages.length + (messages.length - fullyCompacted.length)} to ${fullyCompacted.length} messages`,
          iteration: i,
        })
      }

      // ── Context management: compact then truncate ──
      // Compaction replaces stale tool results with summaries (progressive),
      // then truncation drops entire messages if still over budget (hard limit).
      // This two-phase approach keeps context relevant, not just recent.
      const compacted = compactMessages(messages)
      const compactedCount = compacted.filter(
        (m, idx) => m.content !== messages[idx]?.content,
      ).length
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

      // ── Tool contract guidance ──
      // Resolve per-turn guidance from the priority-sorted resolver chain and
      // apply it before the LLM call:  filter the tool list for "block_other_tools"
      // contracts, and inject a transient system instruction for "suggestion" contracts.
      const contractCtx: ToolContractContext = {
        iteration: i,
        availableToolNames: this.toolList.map(t => t.name),
        lastRoundHadDelegation,
        inPostDelegationVerification,
        artifactsRequiringReadBeforeMutation,
        wroteUnverifiedFiles,
        writtenButNotReread,
        lastRoundToolCalls: lastRoundToolCallsSnapshot,
        isKeyBlocked: (key) => circuitBreaker.isKeyBlocked(key) !== null,
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

      // Notify listener before LLM call (for debug/trace)
      this.config.onLlmCall?.({
        phase: "request",
        messages: contractMessages,
        tools: chatToolsForLLM,
        iteration: i,
      })

      // Ask the LLM what to do next
      const t0 = Date.now()
      let response
      try {
        response = await this.llm.chat(contractMessages, chatToolsForLLM, { signal: this.config.signal })
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
        completionAttempted = true

        if (coherentExecution) {
          const coherentDecision = await runCoherentVerification(false)
          if (coherentDecision && coherentDecision.overall !== "pass") {
            messages.push({
              role: "assistant",
              content: response.content,
              section: "history",
            })

            const summary = summarizeCoherentVerifierDecision(coherentDecision)
            const nextRepairAttempt = coherentExecution.repairAttempts + 1
            this.config.onPlannerTrace?.({
              kind: "coherent-generation-repair-needed",
              repairAttempt: nextRepairAttempt,
              issueCount: summary.issueCount,
              issues: [...summary.issues],
              affectedArtifacts: [...summary.affectedArtifacts],
            })
            this.config.onPlannerTrace?.({
              kind: "planner-architecture-state",
              lane: "bounded_coherent_generation",
              status: "repairing_in_place",
              reason: "coherent_completion_blocked_by_verifier",
              architecture: coherentExecution.bundle.architecture,
            })

            if (coherentExecution.repairAttempts < 1) {
              coherentExecution.repairAttempts = nextRepairAttempt
              const repairMsg = buildCoherentRepairInstructions(coherentExecution.bundle, coherentDecision, nextRepairAttempt)
              messages.push({ role: "system", content: repairMsg, section: "history" })
              this.config.onNudge?.({ tag: "coherent-repair-required", message: repairMsg, iteration: i })
              continue
            }

            if (!coherentExecution.escalated && this.config.enablePlanner && this.config.plannerDelegateFn) {
              coherentExecution.escalated = true
              this.config.onPlannerTrace?.({
                kind: "coherent-generation-escalated",
                target: "planner_repair_path",
                issueCount: summary.issueCount,
                reason: "coherent_repair_still_failing",
              })
              this.config.onPlannerTrace?.({
                kind: "planner-architecture-state",
                lane: "bounded_coherent_generation",
                status: "abandoned",
                reason: "coherent_repair_still_failing",
                architecture: coherentExecution.bundle.architecture,
              })

              const remediationResult = await executePlannerPath(
                buildCoherentPlannerEscalationGoal(goal, coherentExecution.bundle, coherentDecision),
                createPlannerContext(),
                this.config.plannerDelegateFn,
              )

              if (remediationResult.handled) {
                const answer = remediationResult.answer ?? "(planner remediation produced no answer)"
                if (this.config.verbose) log.logFinalAnswer(answer)
                return answer
              }
            }

            coherentExecution.repairAttempts = nextRepairAttempt
            const fallbackRepairMsg = buildCoherentRepairInstructions(coherentExecution.bundle, coherentDecision, nextRepairAttempt)
            messages.push({ role: "system", content: fallbackRepairMsg, section: "history" })

            // Hard exit: if the verifier has rejected the agent's completion
            // attempt too many times in a row, stop looping and return the best
            // answer we have.  Without this, when escalation is unavailable or
            // fails, the loop runs until the iteration cap (which can itself
            // grow via the budget extension).
            if (nextRepairAttempt > 4) {
              const bestAnswer = response.content ?? "(coherent generation completed — verifier disagreement unresolved)"
              if (this.config.verbose) log.logFinalAnswer(bestAnswer)
              return bestAnswer
            }
            continue
          }

          // Coherent verifier confirmed pass — return the answer immediately.
          // Bypassing quality guards here is intentional: the verifier already
          // evaluated the actual code and found no issues. Without this early
          // return, phrases like "I've added the missing imports" in the agent's
          // completion text can trigger the premature-handoff heuristic, causing
          // an infinite loop of unnecessary rewrites even when work is done.
          if (coherentDecision?.overall === "pass") {
            const coherentAnswer = response.content ?? "(no response)"
            if (this.config.verbose) log.logFinalAnswer(coherentAnswer)
            return coherentAnswer
          }
        }

        // Guard: if this is iteration 0 and the agent has tools, it likely
        // bailed without doing any work. Nudge it once to actually act.
        if (
          i === 0
          && this.toolList.length > 0
          && !earlyExitNudged
          && !(coherentExecution && coherentExecution.lastVerifierDecision?.overall === "pass")
        ) {
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

        const asksToContinue = /\b(?:would you like me to|do you want me to|should i (?:continue|proceed|implement|fix))\b/i.test(answer)
        const unresolvedGaps = /\b(?:unimplemented|not implemented|missing|placeholder|issues and deficiencies|plan for fixes|further refinements?|full compliance may require|may require additional|not fully (?:implemented|complete)|deep validation|additional delegation)\b/i.test(answer)
        if (
          this.toolList.length > 0 &&
          (asksToContinue || unresolvedGaps) &&
          prematureHandoffNudges < 3 &&
          i < this.config.maxIterations - 1
        ) {
          prematureHandoffNudges += 1
          messages.push({ role: "assistant", content: answer, section: "history" })
          const continueMsg =
              "PREMATURE HANDOFF DETECTED: Do not ask the user whether to continue and do not stop at partial completion language. " +
              "Use tools now to implement and verify any missing parts, then return a completed result with concrete evidence."
          messages.push({ role: "system", content: continueMsg, section: "history" })
          this.config.onNudge?.({ tag: "premature-handoff", message: continueMsg, iteration: i })
          continue
        }

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
      let forcedAbortRoundMessage: string | null = null
      let forcedAbortLoopMessage: string | null = null

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

        // Per-key circuit breaker check — skip this specific call pattern if it has
        // been blocked by repeated failures, while allowing other calls in the round.
        const keyBlock = circuitBreaker.isKeyBlocked(semanticKey)
        if (keyBlock) {
          const keyBlockMsg = `SKIPPED (circuit blocked): ${keyBlock.reason} Try a different approach for this call.`
          if (this.config.verbose) log.logToolError(keyBlockMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: keyBlockMsg, section: "history" })
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: keyBlockMsg, isError: true })
          failuresThisRound++
          continue
        }

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

        const requestedPath = typeof (call.arguments as Record<string, unknown>).path === "string"
          ? normalizeArtifactPath(String((call.arguments as Record<string, unknown>).path))
          : ""
        if (FILE_MUTATION_TOOLS.has(call.name) && requestedPath && artifactsRequiringReadBeforeMutation.has(requestedPath)) {
          const blockedMsg =
            `MUTATION BLOCKED for ${requestedPath} — you must read the current artifact before attempting another mutation.\n` +
            "  - The previous mutation on this artifact produced a structured integrity failure.\n" +
            "  - Use read_file on the exact same path first, then plan a targeted repair from the current file state."
          if (this.config.verbose) log.logToolError(blockedMsg)
          messages.push({ role: "tool", toolCallId: call.id, content: blockedMsg, section: "history" })
          roundToolCalls.push({
            name: call.name,
            args: call.arguments as Record<string, unknown>,
            result: blockedMsg,
            isError: true,
            outcome: {
              ok: false,
              summary: `MUTATION BLOCKED for ${requestedPath}`,
              severity: "recoverable",
              directive: "abort_round",
              errorCode: "artifact_inspection_required",
              details: [
                "Use read_file on the same artifact before any further write/replace/append attempt.",
              ],
              artifacts: [{ path: requestedPath, preservedExisting: true, requiresReadBeforeMutation: true }],
            },
          })
          failuresThisRound++
          forcedAbortLoopMessage = recordBlockedArtifactFailure(
            requestedPath,
            3,
            "Repeated mutation-blocked attempts",
          )
          forcedAbortRoundMessage = `Artifact guard triggered for ${requestedPath}. Read the current file before retrying any mutation.`
          break
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
          roundToolCalls.push({ name: call.name, args: call.arguments as Record<string, unknown>, result: execResult.result, isError: true, outcome: execResult.outcome })
          failuresThisRound++
          circuitBreaker.recordFailure(semanticKey, call.name)
          trackToolCallFailureState(true, semanticKey, toolLoopState)

            const errorPath = typeof (call.arguments as Record<string, unknown>).path === "string"
              ? normalizeArtifactPath(String((call.arguments as Record<string, unknown>).path))
              : ""
            if (
              call.name === "replace_in_file"
              && errorPath
              && /old_string not found/i.test(execResult.result)
            ) {
              artifactsRequiringReadBeforeMutation.add(errorPath)
              const repeatedMissAbort = recordBlockedArtifactFailure(
                errorPath,
                3,
                "Repeated replace_in_file old_string misses",
              )
              if (repeatedMissAbort && !forcedAbortLoopMessage) {
                forcedAbortLoopMessage = repeatedMissAbort
              }
              if (!forcedAbortRoundMessage) {
                forcedAbortRoundMessage =
                  `replace_in_file could not find the requested text in ${errorPath}. ` +
                  "Read the current file and switch to an exact-match repair or full-file rewrite if the content has drifted."
              }
            }
        } else {
          const enriched = enrichResult(execResult.result, {})
          const semanticFailure = execResult.outcome ? !execResult.outcome.ok : didToolCallFail(false, enriched)
          if (this.config.verbose) log.logToolResult(enriched)
          messages.push({ role: "tool", toolCallId: call.id, content: enriched, section: "history" })
          roundToolCalls.push({
            name: call.name,
            args: call.arguments as Record<string, unknown>,
            result: enriched,
            isError: semanticFailure,
            outcome: execResult.outcome,
          })

          // Semantic failures (e.g. write rejected, tool-reported failure text)
          // must count as round failures so stuck detection can trigger.
          if (semanticFailure) {
            failuresThisRound++

            const semanticFailurePath = typeof (call.arguments as Record<string, unknown>).path === "string"
              ? normalizeArtifactPath(String((call.arguments as Record<string, unknown>).path))
              : ""
            if (
              call.name === "replace_in_file"
              && semanticFailurePath
              && /old_string not found/i.test(enriched)
            ) {
              artifactsRequiringReadBeforeMutation.add(semanticFailurePath)
              const repeatedMissAbort = recordBlockedArtifactFailure(
                semanticFailurePath,
                3,
                "Repeated replace_in_file old_string misses",
              )
              if (repeatedMissAbort && !forcedAbortLoopMessage) {
                forcedAbortLoopMessage = repeatedMissAbort
              }
              if (!forcedAbortRoundMessage) {
                forcedAbortRoundMessage =
                  `replace_in_file could not find the requested text in ${semanticFailurePath}. ` +
                  "Read the current file and switch to an exact-match repair or full-file rewrite if the content has drifted."
              }
            }
          }

          // Circuit breaker: clear on success, record if "success" is a semantic failure
          if (semanticFailure) {
            circuitBreaker.recordFailure(semanticKey, call.name)
            trackToolCallFailureState(true, semanticKey, toolLoopState)
          } else {
            circuitBreaker.clearPattern(semanticKey)
            trackToolCallFailureState(false, semanticKey, toolLoopState)
          }

          if (call.name === "delegate" || call.name === "delegate_parallel") {
            delegationThisRound = true
          }

          for (const artifact of execResult.outcome?.artifacts ?? []) {
            const normalizedPath = normalizeArtifactPath(artifact.path)
            if (!normalizedPath) continue
            if (artifact.requiresReadBeforeMutation) {
              artifactsRequiringReadBeforeMutation.add(normalizedPath)
            } else {
              artifactsRequiringReadBeforeMutation.delete(normalizedPath)
              fatalArtifactFailureCounts.delete(normalizedPath)
              blockedArtifactFailureCounts.delete(normalizedPath)
            }
          }

          if (execResult.outcome?.severity === "fatal") {
            for (const artifact of execResult.outcome.artifacts ?? []) {
              const normalizedPath = normalizeArtifactPath(artifact.path)
              if (!normalizedPath) continue
              const count = (fatalArtifactFailureCounts.get(normalizedPath) ?? 0) + 1
              fatalArtifactFailureCounts.set(normalizedPath, count)
              if (count >= 2) {
                forcedAbortLoopMessage =
                  `Repeated fatal mutation failures on ${normalizedPath}. Stopping this agent attempt so the parent can retry or replan from a clean state.`
              }
              if (!forcedAbortLoopMessage) {
                forcedAbortLoopMessage = recordBlockedArtifactFailure(
                  normalizedPath,
                  3,
                  "Repeated blocked mutation failures",
                )
              }
            }
          } else if (
            execResult.outcome?.errorCode === "artifact_incomplete_mutation"
            || execResult.outcome?.errorCode === "artifact_inspection_required"
          ) {
            for (const artifact of execResult.outcome.artifacts ?? []) {
              if (forcedAbortLoopMessage) break
              forcedAbortLoopMessage = recordBlockedArtifactFailure(
                artifact.path,
                3,
                "Repeated incomplete/blocked mutation failures",
              )
            }
          }

          // Track write-without-verify: if the child writes code/HTML, mark as unverified.
          // read_file, run_command, AND browser_check clear the flag.
          // browser_check launches a real browser that checks for JS errors — this counts
          // as verification. Without this, children that properly verify via browser_check
          // get a spurious WRITE-WITHOUT-VERIFY nudge, wasting iterations.
          if (call.name === "write_file") {
            const writePath = String((call.arguments as Record<string, unknown>).path ?? "")
            const preservedExisting = execResult.outcome?.artifacts?.some((artifact) => artifact.preservedExisting) ?? false
            if (/\.(js|jsx|ts|tsx|py|html?|css|json)$/i.test(writePath) && !preservedExisting) {
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
            const normalizedReadPath = normalizeArtifactPath(readPath)
            artifactsRequiringReadBeforeMutation.delete(normalizedReadPath)
          }
          if (call.name === "run_command" || call.name === "browser_check") {
            wroteUnverifiedFiles = false
          }

          if (execResult.outcome?.directive === "abort_loop" && !forcedAbortLoopMessage) {
            forcedAbortLoopMessage = execResult.outcome.summary
          } else if (execResult.outcome?.directive === "abort_round" && !forcedAbortRoundMessage) {
            forcedAbortRoundMessage = execResult.outcome.summary
          }

          if (forcedAbortLoopMessage || forcedAbortRoundMessage) {
            break
          }
        }
      }

      // ── Accumulate tool calls for parent access ──
      this.allToolCalls.push(...roundToolCalls)

      if (forcedAbortLoopMessage) {
        messages.push({ role: "system", content: forcedAbortLoopMessage, section: "history" })
        this.config.onNudge?.({ tag: "fatal-tool-outcome", message: forcedAbortLoopMessage, iteration: i })
        if (this.config.verbose) log.logError(forcedAbortLoopMessage)
        return forcedAbortLoopMessage
      }

      if (forcedAbortRoundMessage) {
        messages.push({ role: "system", content: forcedAbortRoundMessage, section: "history" })
        this.config.onNudge?.({ tag: "abort-round-tool-outcome", message: forcedAbortRoundMessage, iteration: i })
        if (this.config.verbose) log.logError(forcedAbortRoundMessage)
        this.config.onStep?.(messages, i)
        continue
      }

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

      // ── Coherent repair read-spin detection ──────────────────
      // When a coherent bundle is being repaired, track consecutive iterations
      // with no writes. The repair loop deadlocks when the write guard blocks
      // writes AND "do not redesign" blocks restructuring — the LLM ends up
      // reading the same files repeatedly. After COHERENT_READ_ONLY_ROUND_LIMIT
      // read-only rounds, inject a direct instruction to stop reading and write.
      if (coherentExecution) {
        const roundHadWrite = roundToolCalls.some(
          tc => !tc.isError && (tc.name === "write_file" || tc.name === "replace_in_file"),
        )
        if (roundHadWrite) {
          coherentRepairReadOnlyRounds = 0
        } else {
          const roundHadRead = roundToolCalls.some(tc => tc.name === "read_file")
          if (roundHadRead) {
            coherentRepairReadOnlyRounds++
            if (coherentRepairReadOnlyRounds >= COHERENT_READ_ONLY_ROUND_LIMIT) {
              coherentRepairReadOnlyRounds = 0
              const repairFiles = coherentExecution.bundle.artifacts.map(a => a.path).join(", ")
              const spinMsg =
                `REPAIR STALL DETECTED: You have read files ${COHERENT_READ_ONLY_ROUND_LIMIT} iterations in a row without writing anything. ` +
                `Stop reading and write the fix NOW.\n` +
                `Files in scope: ${repairFiles}\n` +
                `REQUIRED NEXT ACTION: call write_file (or replace_in_file) to apply the fix. ` +
                `If the write guard is blocking you because a function is missing, include ALL existing functions PLUS the fix in your write. ` +
                `If the issue requires restructuring (e.g. removing an ES module import), restructure now — rewrite the entire affected file.`
              messages.push({ role: "system", content: spinMsg, section: "history" })
              this.config.onNudge?.({ tag: "coherent-repair-stall", message: spinMsg, iteration: i })
              if (this.config.verbose) log.logError(`Coherent repair stall at iteration ${i}`)
            }
          }
        }
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
          maxAbsoluteLimit: absoluteIterationCap,
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
      lastRoundToolCallsSnapshot = roundToolCalls.map(c => ({ name: c.name, isError: c.isError }))

      // Recovery hints: scan for known failure patterns and inject targeted advice
      const recoveryHints = buildRecoveryHints(roundToolCalls, emittedRecoveryHints)
      for (const hint of recoveryHints) {
        if (this.config.deferRecoveryHintsUntilCompletionAttempt && !completionAttempted) {
          continue
        }
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

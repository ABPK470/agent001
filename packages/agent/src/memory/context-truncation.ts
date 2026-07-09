/**
 * Context truncation — budget-aware message dropping/truncation and
 * progress summary generation for dropped history.
 *
 * Extracted from context-management.ts.
 *
 * @module
 */

import { MessageRole } from "../domain/enums/message.js"
import type { Message, PromptBudgetSection } from "../domain/agent-types.js"
import { DROP_PRIORITY } from "../domain/agent-types.js"
import { estimateTokens, extractFilePath, MAX_CONTEXT_TOKENS } from "./context-management/index.js"
import { applyPromptBudget, type PromptBudgetDiagnostics } from "./prompt-budget/index.js"

// ============================================================================
// Truncation
// ============================================================================

export interface TruncationResult {
  readonly messages: Message[]
  readonly budgetDiagnostics?: PromptBudgetDiagnostics
}

export function truncateMessages(messages: Message[], modelHint?: string): TruncationResult {
  const MAX_RESULT_LEN = 8000
  const trimmed = messages.map((m) => {
    if (m.role === MessageRole.Tool && m.content && m.content.length > MAX_RESULT_LEN) {
      return { ...m, content: m.content.slice(0, MAX_RESULT_LEN) + "\n... (output truncated)" }
    }
    return m
  })

  if (estimateTokens(trimmed, modelHint) <= MAX_CONTEXT_TOKENS) return { messages: trimmed }
  if (trimmed.length <= 4) return { messages: trimmed }

  const hasStructuredPrompt = trimmed.some((m) => m.section != null)

  if (hasStructuredPrompt) {
    const budgetResult = applyPromptBudget(trimmed, {
      contextWindowTokens: MAX_CONTEXT_TOKENS,
      maxOutputTokens: 4096,
      charPerToken: 4,
      hardMaxPromptChars: MAX_CONTEXT_TOKENS * 4,
      model: modelHint
    })
    if (budgetResult.messages.length > 0) {
      // Second pass — distribute the *history* section budget across
      // tool-result messages so no single result can starve the others.
      // Without this the static MAX_RESULT_LEN cap above is the only
      // defence, and it doesn't adapt to how many tool results landed
      // in this iteration.
      const finalMessages = enforcePerToolResultCap(
        budgetResult.messages,
        budgetResult.diagnostics.caps.historyChars
      )
      return { messages: finalMessages, budgetDiagnostics: budgetResult.diagnostics }
    }
    return { messages: truncateBySection(trimmed) }
  }

  return { messages: truncateLegacy(trimmed) }
}

/**
 * Distribute a section budget across all tool-result messages so the
 * largest result can't crowd out the rest. Each result is capped at
 * `floor(historyBudget / toolMessageCount)` clamped to [1024, 16384]
 * chars. Pure post-process — operates on the already-allocated message
 * array so it cannot grow the prompt.
 */
function enforcePerToolResultCap(messages: Message[], historyBudgetChars: number): Message[] {
  const PER_RESULT_MIN = 1024
  const PER_RESULT_MAX = 16384
  const toolMsgCount = messages.reduce((n, m) => n + (m.role === MessageRole.Tool ? 1 : 0), 0)
  if (toolMsgCount === 0) return messages
  const perResultCap = Math.min(
    PER_RESULT_MAX,
    Math.max(PER_RESULT_MIN, Math.floor(historyBudgetChars / toolMsgCount))
  )
  let mutated = false
  const out = messages.map((m) => {
    if (m.role !== MessageRole.Tool || !m.content || m.content.length <= perResultCap) return m
    mutated = true
    return {
      ...m,
      content: m.content.slice(0, perResultCap) + "\n... (output truncated by section budget)"
    }
  })
  return mutated ? out : messages
}

function truncateBySection(messages: Message[]): Message[] {
  let current = [...messages]

  for (const section of DROP_PRIORITY) {
    if (estimateTokens(current) <= MAX_CONTEXT_TOKENS) break

    if (section === "history") {
      current = dropOldestHistory(current)
    } else {
      current = current.filter((m) => m.section !== section)
    }
  }

  if (estimateTokens(current) > MAX_CONTEXT_TOKENS) {
    current = truncateLegacy(current)
  }

  return current
}

function dropOldestHistory(messages: Message[]): Message[] {
  const systemEnd = messages.findIndex(
    (m) =>
      m.role !== "system" &&
      m.section !== "system_anchor" &&
      m.section !== "system_runtime" &&
      m.section !== "memory_working" &&
      m.section !== "memory_episodic" &&
      m.section !== "memory_semantic"
  )
  if (systemEnd < 0) return messages

  const userIdx = messages.findIndex(
    (m) => m.section === "user" || (m.role === MessageRole.User && !m.section)
  )
  const historyStart = Math.max(systemEnd, userIdx + 1)

  const head = messages.slice(0, historyStart)
  const tail = messages.slice(historyStart)

  if (tail.length <= 6) return messages

  const keepCount = Math.max(6, Math.floor(tail.length / 2))
  const droppedTail = tail.slice(0, -keepCount)
  const keptTail = tail.slice(-keepCount)

  const summary = buildDroppedHistorySummary(droppedTail)

  return [
    ...head,
    { role: MessageRole.System, content: summary, section: "history" as PromptBudgetSection },
    ...keptTail
  ]
}

// ============================================================================
// Progress summary for dropped history
// ============================================================================

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
        command: typeof args.command === "string" ? args.command : null
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
          const cmd = typeof args.command === "string" ? args.command.slice(0, 60) : "command"
          actions.push(`ran: ${cmd}`)
          break
        }
        case "delegate":
        case "delegate_parallel":
          actions.push(`delegated: ${typeof args.goal === "string" ? args.goal.slice(0, 80) : "subtask"}`)
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

    if (
      /^Error:|\b(?:failed|exception|traceback|syntax error|enoent|eacces|permission denied)\b/i.test(
        normalized
      ) &&
      !/\bno errors\b/i.test(normalized)
    ) {
      notableResults.push(`${meta.name}${pathLabel} failed: ${short}`)
      continue
    }

    if (
      meta.name === "run_command" &&
      /\b(?:passed|success|0 failed|build succeeded|compiled successfully)\b/i.test(normalized)
    ) {
      const commandLabel = meta.command ? meta.command.slice(0, 50) : "command"
      notableResults.push(`run_command succeeded: ${commandLabel}`)
    }
  }

  if (actions.length === 0 && notableResults.length === 0) {
    return "[Earlier conversation truncated to save context budget.]"
  }

  const displayed =
    actions.length <= 15 ? actions : [...actions.slice(0, 12), `... and ${actions.length - 12} more actions`]
  const displayedResults =
    notableResults.length <= 8
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

function truncateLegacy(messages: Message[]): Message[] {
  const head = messages.slice(0, 2)
  let tailSize = 4
  while (tailSize < messages.length - 2) {
    const dropped = messages.slice(2, messages.length - tailSize)
    const summary = buildDroppedHistorySummary(dropped)
    const candidate = [...head, { role: MessageRole.System, content: summary }, ...messages.slice(-tailSize)]
    if (estimateTokens(candidate) > MAX_CONTEXT_TOKENS) {
      tailSize = Math.max(4, tailSize - 2)
      break
    }
    tailSize += 2
  }
  const dropped = messages.slice(2, messages.length - tailSize)
  const summary = buildDroppedHistorySummary(dropped)
  return [...head, { role: MessageRole.System, content: summary }, ...messages.slice(-tailSize)]
}

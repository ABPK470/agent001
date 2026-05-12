/**
 * Context management — progressive compaction and budget-aware truncation.
 *
 * Two-phase approach to keeping context relevant within LLM token budgets:
 *   1. **Compaction**: Replace stale tool results with concise summaries
 *      (superseded reads, superseded writes, old large results).
 *   2. **Truncation**: Drop entire messages or sections when still over budget
 *      (section-aware with priority ordering, or legacy head+tail).
 *
 * Extracted from agent.ts for testability and separation of concerns.
 *
 * @module
 */

import type { Message } from "./types.js"

// ============================================================================
// Constants
// ============================================================================

/** Max token budget for the request body. */
export const MAX_CONTEXT_TOKENS = 64000

/**
 * How many recent iterations to preserve in full detail.
 * Tool results within this window are kept verbatim.
 */
const COMPACT_PRESERVE_RECENT = 3

/** Tool results shorter than this (chars) are never compacted. */
const COMPACT_MIN_SIZE = 500

// ============================================================================
// Token estimation
// ============================================================================

/**
 * Rough token estimate: ~4 chars per token for English text.
 * Intentionally conservative — better to truncate early than crash.
 */
export function estimateTokens(messages: Message[]): number {
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

// ============================================================================
// File path extraction
// ============================================================================

/**
 * Extract file path from a tool call's arguments.
 * Different tools use different arg names for file paths.
 */
export function extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "file", "filename"]) {
    if (typeof args[key] === "string") return args[key] as string
  }
  if (toolName === "write_file" && typeof args.path === "string") return args.path as string
  if (toolName === "read_file" && typeof args.path === "string") return args.path as string
  return null
}

// ============================================================================
// Progressive context compaction
// ============================================================================

/**
 * Progressive context compaction — surgically compact stale tool results
 * while preserving their semantic signal. Keeps the LLM focused on what
 * matters NOW rather than drowning in stale file contents.
 *
 * Four compaction strategies:
 *   1. Superseded reads: file was read then later written — compact the read
 *   2. Superseded writes: file was written then later re-written — compact earlier write
 *   3. Old tool results: results from >3 iterations ago — compact to summary
 *   4. Old tool call arguments: large write contents in assistant messages — compact
 *
 * @internal — exported for testing
 */
export function compactMessages(messages: Message[]): Message[] {
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

  // Track file read/write history
  const lastWriteOf = new Map<string, number>()
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

  // Map toolCallId → metadata for matching results to calls
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

  // Build compacted messages
  const result: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    // Strategy 4: Compact old assistant tool call ARGUMENTS
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const iter = iterationOf.get(i) ?? 0
      const age = latestIteration - iter
      let needsCompaction = false

      if (age > COMPACT_PRESERVE_RECENT) {
        needsCompaction = m.toolCalls.some((tc) => {
          const args = tc.arguments as Record<string, unknown>
          const content = typeof args.content === "string" ? args.content : ""
          return content.length >= COMPACT_MIN_SIZE
        })
      } else {
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

    // Strategy 1: Superseded read
    if (meta.name === "read_file" && meta.path && lastWriteOf.has(meta.path)) {
      const writeIdx = lastWriteOf.get(meta.path)!
      if (writeIdx > meta.assistantIdx) {
        const lineCount = m.content.split("\n").length
        result.push({
          ...m,
          content: `[compacted — file was modified later] read_file ${meta.path}: ${lineCount} lines (superseded by later write)`,
        })
        continue
      }
    }

    // Strategy 2: Superseded write
    if ((meta.name === "write_file" || meta.name === "replace_in_file") && meta.path && lastWriteOf.has(meta.path)) {
      const lastWrite = lastWriteOf.get(meta.path)!
      if (lastWrite > meta.assistantIdx) {
        const lineCount = m.content.split("\n").length
        result.push({
          ...m,
          content: `[compacted — file was rewritten later] ${meta.name} ${meta.path}: ${lineCount} lines (superseded)`,
        })
        continue
      }
    }

    // Strategy 3: Old large results
    if (age > COMPACT_PRESERVE_RECENT) {
      result.push({
        ...m,
        content: compactToolResult(meta.name, meta.path, m.content),
      })
      continue
    }

    result.push(m)
  }

  return result
}

// Re-export truncation for backwards compatibility
export { truncateMessages, type TruncationResult } from "./context-truncation.js"

// Tool-result compaction helpers live in a sibling module to keep this
// file focused on iteration tracking + compaction orchestration.
import { compactToolResult } from "./context-management/result-summary.js"

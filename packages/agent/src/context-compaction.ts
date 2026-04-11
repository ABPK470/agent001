/**
 * Context compaction — structured history compression with session anchoring.
 *
 * Two complementary mechanisms:
 *   1. ArtifactCompactionState — extracts the semantic meaning of the conversation
 *      history into a typed snapshot (files written, commands run, errors, current state).
 *   2. LLMStatefulResumeAnchor — a synthetic session checkpoint message that encodes
 *      the state snapshot as natural language, replacing the compacted raw history so
 *      the LLM can continue without retransmitting stale turns.
 *
 * Provider-level prompt caching (Anthropic cache_control / OpenAI prefix caching)
 * is handled in the LLM client layer and is complementary to this mechanism.
 *
 * @module
 */

import type { Message, PromptBudgetSection } from "./types.js"

// ── Types ─────────────────────────────────────────────────────────────────────

/** One file that was written during the session. */
export interface CompactedFileRecord {
  readonly path: string
  readonly writeCount: number
  readonly linesAtLastWrite: number
  readonly lastVerified: boolean
}

/**
 * Structured snapshot of everything the agent accomplished before the compaction
 * boundary. Equivalent to agenc-core's ArtifactCompactionState.
 */
export interface ArtifactCompactionState {
  readonly compactedAtIteration: number
  readonly goal: string
  readonly completedToolRounds: number
  readonly toolCallCounts: Record<string, number>
  readonly writtenFiles: CompactedFileRecord[]
  readonly verifiedFiles: readonly string[]
  readonly successfulCommands: readonly string[]
  readonly failedCommands: readonly string[]
  readonly pendingNextAction: string | undefined
  readonly repairEpisodes: number
  readonly lastErrorSummary: string | undefined
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum iteration before full compaction is considered. */
const FULL_COMPACTION_MIN_ITERATION = 10
/** Minimum message count before full compaction fires. */
const FULL_COMPACTION_MIN_MESSAGES = 50
/** Minimum iterations since last compaction before the next is allowed. */
const FULL_COMPACTION_INTERVAL = 8
/** Number of most-recent iterations to preserve verbatim. */
const FULL_COMPACTION_PRESERVE_RECENT = 4

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true when a full history compaction should be applied.
 */
export function shouldApplyFullCompaction(
  messages: readonly Message[],
  currentIteration: number,
  lastCompactionIteration: number,
): boolean {
  if (currentIteration < FULL_COMPACTION_MIN_ITERATION) return false
  if (messages.length < FULL_COMPACTION_MIN_MESSAGES) return false
  if (currentIteration - lastCompactionIteration < FULL_COMPACTION_INTERVAL) return false
  return true
}

/**
 * Apply full history compaction.
 *
 * Partitions the message history into:
 *   - System messages (kept verbatim)
 *   - The first user message / goal (kept verbatim)
 *   - A compactable zone → ArtifactCompactionState resume anchor
 *   - Recent N iterations (kept verbatim)
 *
 * Returns a shorter message array and the extracted state object.
 */
export function applyFullCompaction(
  messages: readonly Message[],
  currentIteration: number,
): { readonly compacted: Message[]; readonly state: ArtifactCompactionState } {
  const systemMessages: Message[] = []
  let goalMessage: Message | undefined
  const afterGoalMessages: Message[] = []

  let pastGoal = false
  for (const m of messages) {
    if (!pastGoal) {
      if (
        m.role === "system"
        || m.section === "system_anchor"
        || m.section === "system_runtime"
        || m.section === "memory_working"
        || m.section === "memory_episodic"
        || m.section === "memory_semantic"
      ) {
        systemMessages.push(m)
        continue
      }
      if (m.role === "user") {
        goalMessage = m
        pastGoal = true
        continue
      }
      afterGoalMessages.push(m)
      continue
    }
    afterGoalMessages.push(m)
  }

  // Find iteration boundaries (assistant messages with tool calls)
  const iterBoundaries: number[] = []
  for (let i = 0; i < afterGoalMessages.length; i++) {
    const m = afterGoalMessages[i]
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      iterBoundaries.push(i)
    }
  }

  const keepFromIdx =
    iterBoundaries.length > FULL_COMPACTION_PRESERVE_RECENT
      ? iterBoundaries[iterBoundaries.length - FULL_COMPACTION_PRESERVE_RECENT]
      : 0

  const compactableZone = afterGoalMessages.slice(0, keepFromIdx)
  const recentZone = afterGoalMessages.slice(keepFromIdx)

  const goalText = goalMessage?.content ?? ""
  const state = extractCompactionState(compactableZone, goalText, currentIteration)
  const anchorMessage = buildResumeAnchorMessage(state)

  const compacted: Message[] = [
    ...systemMessages,
    ...(goalMessage ? [goalMessage] : []),
    anchorMessage,
    ...recentZone,
  ]

  return { compacted, state }
}

/**
 * Extract an ArtifactCompactionState from a slice of messages.
 * Exported for testing.
 */
export function extractCompactionState(
  messages: readonly Message[],
  goal: string,
  currentIteration: number,
): ArtifactCompactionState {
  const toolCallCounts: Record<string, number> = {}
  const writeMap = new Map<
    string,
    { writeCount: number; linesAtLastWrite: number; lastWriteMsgIdx: number }
  >()
  const readAfterWrite = new Set<string>()
  const successfulCommands: string[] = []
  const failedCommands: string[] = []
  let toolRoundCount = 0
  let repairEpisodes = 0
  let lastAssistantText: string | undefined
  let lastErrorSummary: string | undefined

  const toolCallMeta = new Map<
    string,
    { name: string; path: string | null; command: string | null; msgIdx: number }
  >()

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        toolRoundCount++
        for (const tc of m.toolCalls) {
          toolCallCounts[tc.name] = (toolCallCounts[tc.name] ?? 0) + 1
          const args = tc.arguments as Record<string, unknown>
          const path = extractFilePath(args)
          const command = typeof args.command === "string" ? (args.command as string) : null
          toolCallMeta.set(tc.id, { name: tc.name, path, command, msgIdx: i })

          if (tc.name === "write_file" || tc.name === "replace_in_file") {
            if (path) {
              const existing = writeMap.get(path)
              const content = typeof args.content === "string" ? (args.content as string) : ""
              const lineCount = content
                ? content.split("\n").length
                : (existing?.linesAtLastWrite ?? 0)
              writeMap.set(path, {
                writeCount: (existing?.writeCount ?? 0) + 1,
                linesAtLastWrite: lineCount,
                lastWriteMsgIdx: i,
              })
            }
          } else if (tc.name === "read_file") {
            if (path) {
              const writeInfo = writeMap.get(path)
              if (writeInfo && i > writeInfo.lastWriteMsgIdx) {
                readAfterWrite.add(path)
              }
            }
          }
        }
      }
      if (m.content) {
        const text = m.content.trim()
        if (text) {
          lastAssistantText = text.length > 300 ? text.slice(0, 300) + "..." : text
        }
      }
      continue
    }

    if (m.role === "tool" && m.toolCallId && m.content) {
      const meta = toolCallMeta.get(m.toolCallId)
      if (!meta) continue
      const content = m.content

      if (
        /^Error:|\b(?:failed|exception|traceback|enoent|eacces|permission denied)\b/i.test(content)
        && !/\bno errors\b/i.test(content)
      ) {
        const short = content.slice(0, 150).replace(/\s+/g, " ")
        lastErrorSummary = `${meta.name}${meta.path ? ` ${meta.path}` : ""}: ${short}`
      }

      if (meta.name === "run_command" && meta.command) {
        const isSuccess =
          /\b(?:passed|success|0 failed|build succeeded|compiled|done)\b/i.test(content)
          && !/\b(?:error|failed|exception)\b/i.test(content)
        const isFailure =
          /\b(?:error|failed|exception|syntax error)\b/i.test(content)
          && !/\bno errors\b|\bno.*failed\b/i.test(content)
        if (isSuccess) {
          successfulCommands.push(meta.command.slice(0, 80))
        } else if (isFailure) {
          failedCommands.push(meta.command.slice(0, 80))
        }
      }
    }
  }

  for (const [path, info] of writeMap) {
    if (info.writeCount > 1 && readAfterWrite.has(path)) {
      repairEpisodes++
    }
  }

  const writtenFiles: CompactedFileRecord[] = []
  for (const [path, info] of writeMap) {
    writtenFiles.push({
      path,
      writeCount: info.writeCount,
      linesAtLastWrite: info.linesAtLastWrite,
      lastVerified: readAfterWrite.has(path),
    })
  }
  writtenFiles.sort((a, b) => a.path.localeCompare(b.path))

  return {
    compactedAtIteration: currentIteration,
    goal,
    completedToolRounds: toolRoundCount,
    toolCallCounts,
    writtenFiles,
    verifiedFiles: writtenFiles.filter(f => f.lastVerified).map(f => f.path),
    successfulCommands: [...new Set(successfulCommands)].slice(0, 10),
    failedCommands: [...new Set(failedCommands)].slice(0, 5),
    pendingNextAction: lastAssistantText,
    repairEpisodes,
    lastErrorSummary,
  }
}

/**
 * Build a LLMStatefulResumeAnchor message from a compaction state.
 *
 * Summarises what was accomplished so the LLM can continue from the correct
 * state without the token overhead of the full raw history.
 */
export function buildResumeAnchorMessage(state: ArtifactCompactionState): Message {
  const lines: string[] = [
    `[SESSION COMPACTED — iteration ${state.compactedAtIteration}]`,
    `Goal: ${state.goal.slice(0, 200)}${state.goal.length > 200 ? "..." : ""}`,
    `Tool rounds completed: ${state.completedToolRounds}`,
  ]

  if (state.writtenFiles.length > 0) {
    const fileList = state.writtenFiles
      .map(
        f =>
          `  - ${f.path} (${f.writeCount === 1 ? "1 write" : `${f.writeCount} writes`}, ~${f.linesAtLastWrite} lines` +
          `${f.lastVerified ? ", read-verified" : ""})`,
      )
      .join("\n")
    lines.push(`Files written:\n${fileList}`)
  }

  if (state.verifiedFiles.length > 0) {
    lines.push(`Verified working: ${state.verifiedFiles.join(", ")}`)
  }

  if (state.successfulCommands.length > 0) {
    lines.push(`Commands passed: ${state.successfulCommands.slice(0, 5).join("; ")}`)
  }

  if (state.failedCommands.length > 0) {
    lines.push(
      `Commands that failed (do NOT retry without a fix): ${state.failedCommands.slice(0, 3).join("; ")}`,
    )
  }

  const toolSummary = Object.entries(state.toolCallCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ")
  if (toolSummary) lines.push(`Tool call totals: ${toolSummary}`)

  if (state.repairEpisodes > 0) {
    lines.push(
      `Repair cycles detected: ${state.repairEpisodes} (files required multiple write+verify passes)`,
    )
  }

  if (state.lastErrorSummary) {
    lines.push(`Last recorded error: ${state.lastErrorSummary}`)
  }

  if (state.pendingNextAction) {
    lines.push(`Pending (what was next): ${state.pendingNextAction}`)
  }

  lines.push("[Do NOT repeat the completed steps above. Continue from this checkpoint.]")

  return {
    role: "system",
    content: lines.join("\n"),
    section: "history" as PromptBudgetSection,
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractFilePath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "file", "filename"]) {
    if (typeof args[key] === "string") return args[key] as string
  }
  return null
}

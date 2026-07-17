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
 * Implementation split:
 *   context-compaction/extract-state.ts  — extractCompactionState + extractFilePath
 *   context-compaction/resume-anchor.ts  — buildResumeAnchorMessage
 *
 * @module
 */

import { MessageRole } from "../../domain/enums/message.js"
import type { Message } from "../../domain/types/agent-types.js"
import { extractCompactionState } from "./extract-state.js"
import { buildResumeAnchorMessage } from "./resume-anchor.js"

// ── Re-exports ─────────────────────────────────────────────────────

export { extractCompactionState } from "./extract-state.js"
export { buildResumeAnchorMessage } from "./resume-anchor.js"

// ── Types ─────────────────────────────────────────────────────────

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

// ── Constants ─────────────────────────────────────────────────────

/**
 * Compaction cadence — tightened from the original (10/8/50) to (6/5/30)
 * after the prompt-diet audit showed the agent was running 6+ stale
 * iterations of full tool history before the first compaction fired.
 *
 * All three are env-overridable so we can tune without redeploy:
 *   MIA_COMPACT_MIN_ITER       (default 6)
 *   MIA_COMPACT_INTERVAL       (default 5)
 *   MIA_COMPACT_MIN_MESSAGES   (default 30)
 */
function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : defaultValue
}

/** Minimum iteration before full compaction is considered. */
const FULL_COMPACTION_MIN_ITERATION = envInt("MIA_COMPACT_MIN_ITER", 6)
/** Minimum message count before full compaction fires. */
const FULL_COMPACTION_MIN_MESSAGES = envInt("MIA_COMPACT_MIN_MESSAGES", 30)
/** Minimum iterations since last compaction before the next is allowed. */
const FULL_COMPACTION_INTERVAL = envInt("MIA_COMPACT_INTERVAL", 5)
/** Number of most-recent iterations to preserve verbatim. */
const FULL_COMPACTION_PRESERVE_RECENT = 4

// ── Public API ────────────────────────────────────────────────────

/** Returns true when a full history compaction should be applied. */
export function shouldApplyFullCompaction(
  messages: readonly Message[],
  currentIteration: number,
  lastCompactionIteration: number
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
  currentIteration: number
): { readonly compacted: Message[]; readonly state: ArtifactCompactionState } {
  const systemMessages: Message[] = []
  let goalMessage: Message | undefined
  const afterGoalMessages: Message[] = []

  let pastGoal = false
  for (const m of messages) {
    if (!pastGoal) {
      if (
        m.role === MessageRole.System ||
        m.section === "system_anchor" ||
        m.section === "system_runtime" ||
        m.section === "memory_working" ||
        m.section === "memory_episodic" ||
        m.section === "memory_semantic"
      ) {
        systemMessages.push(m)
        continue
      }
      if (m.role === MessageRole.User) {
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
    if (m.role === MessageRole.Assistant && m.toolCalls && m.toolCalls.length > 0) {
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
    ...recentZone
  ]

  return { compacted, state }
}

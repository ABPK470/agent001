/**
 * Per-iteration LLM-prep helper. Compaction → truncation → tool-contract guidance.
 * Extracted from agent.ts.
 *
 * @module
 */

import type { AgentLoopState } from "../application/shell/loop.js"
import { MessageRole } from "../domain/enums/message.js"
import * as log from "../logger.js"
import { applyFullCompaction, compactMessages, shouldApplyFullCompaction, truncateMessages } from "../memory/index.js"
import { applyToolContractGuidance, resolveToolContractGuidance, type ToolContractContext } from "../tools/index.js"
import type { AgentConfig, Message, Tool } from "../types.js"

/**
 * Maximum number of `hint: true` system messages retained in history.
 * Older hints are dropped before each LLM call (Gap 11) — once a budget
 * warning, recovery hint, or stuck-detection nudge is superseded by a
 * newer one, the older one is pure noise that competes with real
 * tool-result history for the budget. Override via MIA_MAX_RUNTIME_HINTS.
 */
const MAX_RUNTIME_HINTS = (() => {
  const raw = process.env.MIA_MAX_RUNTIME_HINTS
  const n = raw ? Number.parseInt(raw, 10) : 4
  return Number.isFinite(n) && n > 0 ? n : 4
})()

/**
 * Drop all but the most recent N `hint: true` messages. Returns the
 * same array reference when nothing was removed (zero-cost when there
 * are few hints, which is the common case).
 */
export function capRuntimeHints(messages: Message[], maxHints: number = MAX_RUNTIME_HINTS): Message[] {
  let count = 0
  for (const m of messages) if (m.hint) count++
  if (count <= maxHints) return messages
  const toDrop = count - maxHints
  let dropped = 0
  const out: Message[] = []
  for (const m of messages) {
    if (m.hint && dropped < toDrop) {
      dropped++
      continue
    }
    out.push(m)
  }
  return out
}

export interface IterationPrepResult {
  contractMessages: Message[]
  chatToolsForLLM: Tool[]
}

export interface IterationPrepInput {
  messages: Message[]
  iteration: number
  state: AgentLoopState
  toolList: Tool[]
  /** Optional model identifier for token-estimate calibration (Gap 7). */
  modelHint?: string
  config: {
    verbose: boolean
    onNudge: AgentConfig["onNudge"]
    onPlannerTrace?: AgentConfig["onPlannerTrace"]
  }
}

export function prepareIterationContext(input: IterationPrepInput): IterationPrepResult {
  const { messages, iteration: i, state, toolList, modelHint, config } = input

  // ── Full history compaction ──
  if (shouldApplyFullCompaction(messages, i, state.lastFullCompactionIteration)) {
    const { compacted: fullyCompacted, state: compactionState } = applyFullCompaction(messages, i)
    messages.splice(0, messages.length, ...fullyCompacted)
    state.lastFullCompactionIteration = i
    config.onNudge?.({
      tag: "context-compaction",
      message: `Session checkpoint at iteration ${i}: ${compactionState.writtenFiles.length} file records captured`,
      iteration: i,
    })
  }

  // ── Context management: compact then truncate ──
  const capped = capRuntimeHints(messages)
  if (capped !== messages) {
    // Mutate the source array so the agent loop sees the cap too —
    // otherwise stale hints would re-accumulate over iterations.
    messages.splice(0, messages.length, ...capped)
  }
  const compacted = compactMessages(messages)
  const compactedCount = compacted.filter((m, idx) => m.content !== messages[idx]?.content).length
  if (compactedCount > 0) {
    const savedChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0)
      - compacted.reduce((s, m) => s + (m.content?.length ?? 0), 0)
    config.onNudge?.({
      tag: "context-compaction",
      message: `Compacted ${compactedCount} stale tool results, saved ~${Math.round(savedChars / 4)} tokens`,
      iteration: i,
    })
  }
  const truncationResult = truncateMessages(compacted, modelHint)
  const chatMessages = truncationResult.messages

  if (truncationResult.budgetDiagnostics) {
    const diag = truncationResult.budgetDiagnostics
    config.onNudge?.({
      tag: "prompt-budget",
      message: `Prompt budget applied: ${diag.totalBeforeChars} → ${diag.totalAfterChars} chars` +
        (diag.droppedSections.length > 0 ? `, dropped: ${diag.droppedSections.join(", ")}` : "") +
        (diag.constrained ? " [constrained]" : ""),
      iteration: i,
    })
    // Phase 6: emit a structured planner-prompt-budget trace once per
    // iteration when the budget materially affected the prompt. This is
    // what the dashboard widget consumes to track p95 prompt size and
    // per-section drops.
    if (config.onPlannerTrace && diag.constrained) {
      const sectionAfterChars: Record<string, number> = {}
      const sectionAfterMessages: Record<string, number> = {}
      const sectionTruncatedMessages: Record<string, number> = {}
      for (const [section, stats] of Object.entries(diag.sections)) {
        sectionAfterChars[section] = stats.afterChars
        sectionAfterMessages[section] = stats.afterMessages
        sectionTruncatedMessages[section] = stats.truncatedMessages
      }
      config.onPlannerTrace({
        kind: "planner-prompt-budget",
        iteration: i,
        model: modelHint ?? null,
        totalBeforeChars: diag.totalBeforeChars,
        totalAfterChars: diag.totalAfterChars,
        totalChars: diag.caps.totalChars,
        constrained: diag.constrained,
        droppedSections: [...diag.droppedSections],
        sectionAfterChars,
        sectionAfterMessages,
        sectionTruncatedMessages,
      })
    }
  }

  // ── Tool contract guidance ──
  const contractCtx: ToolContractContext = {
    iteration: i,
    availableToolNames: toolList.map(t => t.name),
    lastRoundHadDelegation: state.lastRoundHadDelegation,
    lastDelegationWasReadOnly: state.lastDelegationWasReadOnly,
    inPostDelegationVerification: state.inPostDelegationVerification,
    artifactsRequiringReadBeforeMutation: state.artifactsRequiringReadBeforeMutation,
    wroteUnverifiedFiles: state.wroteUnverifiedFiles,
    writtenButNotReread: state.writtenButNotReread,
    lastRoundToolCalls: state.lastRoundToolCallsSnapshot,
    isKeyBlocked: (key) => state.circuitBreaker.isKeyBlocked(key) !== null,
  }
  const contractGuidance = resolveToolContractGuidance(contractCtx)
  let chatToolsForLLM = toolList
  const contractMessages = [...chatMessages]
  if (contractGuidance) {
    const applied = applyToolContractGuidance(contractGuidance, toolList.map(t => t.name))
    const nameSet = new Set(applied.filteredToolNames)
    chatToolsForLLM = toolList.filter(t => nameSet.has(t.name))
    if (applied.injectedInstruction && contractMessages.length > 0) {
      contractMessages.push({ role: MessageRole.System, content: applied.injectedInstruction, section: "history" })
    }
    if (config.verbose) {
      log.logError(`[contract:${contractGuidance.resolverName}] enforcement=${contractGuidance.enforcement}, tools=${applied.filteredToolNames.join(",")}`)
    }
  }

  return { contractMessages, chatToolsForLLM }
}

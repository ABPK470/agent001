/**
 * Per-iteration LLM-prep helper. Compaction → truncation → tool-contract guidance.
 * Extracted from agent.ts.
 *
 * @module
 */

import type { AgentLoopState } from "../loop/agent-loop-state.js"
import { applyFullCompaction, shouldApplyFullCompaction } from "../context/context-compaction.js"
import { compactMessages, truncateMessages } from "../context/context-management.js"
import * as log from "../logger.js"
import { applyToolContractGuidance, resolveToolContractGuidance, type ToolContractContext } from "../tool-helpers/tool-contract-guidance.js"
import type { AgentConfig, Message, Tool } from "../types.js"

export interface IterationPrepResult {
  contractMessages: Message[]
  chatToolsForLLM: Tool[]
}

export interface IterationPrepInput {
  messages: Message[]
  iteration: number
  state: AgentLoopState
  toolList: Tool[]
  config: {
    verbose: boolean
    onNudge: AgentConfig["onNudge"]
  }
}

export function prepareIterationContext(input: IterationPrepInput): IterationPrepResult {
  const { messages, iteration: i, state, toolList, config } = input

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
  const truncationResult = truncateMessages(compacted)
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
      contractMessages.push({ role: "system", content: applied.injectedInstruction, section: "history" })
    }
    if (config.verbose) {
      log.logError(`[contract:${contractGuidance.resolverName}] enforcement=${contractGuidance.enforcement}, tools=${applied.filteredToolNames.join(",")}`)
    }
  }

  return { contractMessages, chatToolsForLLM }
}

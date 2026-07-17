/**
 * Build the synthetic LLMStatefulResumeAnchor message that replaces the
 * compacted raw history.
 *
 * @module
 */

import type { ArtifactCompactionState } from "../context-compaction/index.js"
import type { Message, PromptBudgetSection } from "../../domain/models/agent-types.js"
import { MessageRole } from "../../domain/enums/message.js"

export function buildResumeAnchorMessage(state: ArtifactCompactionState): Message {
  const lines: string[] = [
    `[SESSION COMPACTED — iteration ${state.compactedAtIteration}]`,
    `Goal: ${state.goal.slice(0, 200)}${state.goal.length > 200 ? "..." : ""}`,
    `Tool rounds completed: ${state.completedToolRounds}`
  ]

  if (state.writtenFiles.length > 0) {
    const fileList = state.writtenFiles
      .map(
        (f) =>
          `  - ${f.path} (${f.writeCount === 1 ? "1 write" : `${f.writeCount} writes`}, ~${f.linesAtLastWrite} lines` +
          `${f.lastVerified ? ", read-verified" : ""})`
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
      `Commands that failed (do NOT retry without a fix): ${state.failedCommands.slice(0, 3).join("; ")}`
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
      `Repair cycles detected: ${state.repairEpisodes} (files required multiple write+verify passes)`
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
    role: MessageRole.System,
    content: lines.join("\n"),
    section: "history" as PromptBudgetSection
  }
}

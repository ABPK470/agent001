/**
 * Episodic memory quality — classifies completed runs at ingest time.
 *
 * `shortcutEligible` means: safe to tell the model it may skip redundant
 * discovery (search_catalog, etc.) because this episodic row records a
 * prior substantive success for a similar goal. Decided from run status,
 * trace tools, and correction signals — not prose pattern matching at prompt time.
 */

import { isUserSafeFailureAnswer, RunStatus } from "@mia/agent"
import { EpisodicAnswerKind } from "../../../shared/enums/memory.js"

/** Tools that do not constitute warehouse / execution work on their own. */
const LOW_SIGNAL_TOOLS = new Set([
  "ask_user",
  "note",
  "send_message",
  "check_messages",
  "wait_for_response"
])

/** Tools that indicate the run did real discovery or execution work. */
const SUBSTANTIVE_TOOLS = new Set([
  "query_mssql",
  "explore_mssql_schema",
  "search_catalog",
  "read_file",
  "write_file",
  "run_command",
  "sync_preview",
  "sync_execute",
  "profile_data",
  "inspect_definition",
  "discover_relationships",
  "recall_prior_result",
  "fetch_url",
  "export_query_to_file",
  "import_attachment",
  "read_attachment",
  "render_chart"
])

export interface EpisodicRunInput {
  answer: string | null
  status: string
  tools: string[]
  trace: ReadonlyArray<{ kind: string; tool?: string }>
  hasCorrections: boolean
}

export interface EpisodicRunClassification {
  answerKind: EpisodicAnswerKind
  shortcutEligible: boolean
}

export function isInternalFailureAnswer(answer: string): boolean {
  const trimmed = answer.trim()
  return (
    trimmed.startsWith("Task FAILED") ||
    trimmed.startsWith("Task verification FAILED") ||
    isUserSafeFailureAnswer(trimmed)
  )
}

export function classifyEpisodicRun(input: EpisodicRunInput): EpisodicRunClassification {
  const answer = input.answer?.trim() ?? ""

  if (input.status !== RunStatus.Completed) {
    return { answerKind: EpisodicAnswerKind.Failure, shortcutEligible: false }
  }
  if (!answer) {
    return { answerKind: EpisodicAnswerKind.Empty, shortcutEligible: false }
  }
  if (isInternalFailureAnswer(answer)) {
    return { answerKind: EpisodicAnswerKind.Failure, shortcutEligible: false }
  }
  if (input.hasCorrections) {
    return { answerKind: EpisodicAnswerKind.Substantive, shortcutEligible: false }
  }
  if (isClarificationOnlyRun(input.tools, input.trace)) {
    return { answerKind: EpisodicAnswerKind.Clarification, shortcutEligible: false }
  }

  return { answerKind: EpisodicAnswerKind.Substantive, shortcutEligible: true }
}

function isClarificationOnlyRun(
  tools: readonly string[],
  trace: ReadonlyArray<{ kind: string; tool?: string }>
): boolean {
  if (!tools.includes("ask_user")) return false
  if (tools.some((tool) => SUBSTANTIVE_TOOLS.has(tool))) return false

  const toolCalls = trace
    .filter((entry) => entry.kind === "tool-call" && entry.tool)
    .map((entry) => entry.tool!)
  const lastTool = toolCalls[toolCalls.length - 1]
  if (lastTool === "ask_user") return true

  return !tools.some((tool) => !LOW_SIGNAL_TOOLS.has(tool))
}

export function readEpisodicShortcutEligible(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.["shortcutEligible"] === true
}

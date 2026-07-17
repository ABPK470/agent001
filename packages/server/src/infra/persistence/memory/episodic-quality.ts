/**
 * Episodic memory quality — classifies completed runs at ingest time.
 *
 * `shortcutEligible` means the episodic row carries **reusable discovery
 * evidence** (confirmed tables/columns/queries) so a future run may skip
 * redundant search_catalog / explore_mssql_schema work.
 *
 * Decided from run status, tools, trace, and whether the answer actually
 * asserts findings — not phrase-matching at prompt-build time.
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

/** Tools that indicate real execution or retrieval work beyond chat. */
const SUBSTANTIVE_TOOLS = new Set([
  "query_mssql",
  "explore_mssql_schema",
  "search_catalog",
  "read_file",
  "write_file",
  "run_command",
  "sync_preview",
  "list_sync_definitions",
  "resolve_sync_scope",
  "sync_diff_scan",
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

/** Tools whose purpose is warehouse / catalog discovery. */
const DISCOVERY_TOOLS = new Set([
  "search_catalog",
  "explore_mssql_schema",
  "query_mssql",
  "inspect_definition",
  "discover_relationships",
  "profile_data"
])

/** Qualified SQL identifiers and FROM targets — confirmed reuse artifacts. */
const CONFIRMED_ARTIFACT =
  /\b(?:[a-z_][\w]*\.)+[a-z_][\w]*\b|\[[\w\s]+\]\.\[[\w\s]+\]|\bFROM\s+(?:\[[\w]+\]\.)?(?:dbo\.|\w+\.)/i

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
  if (defersToUser(answer)) {
    return { answerKind: EpisodicAnswerKind.Clarification, shortcutEligible: false }
  }

  const attemptedDiscovery = input.tools.some((tool) => DISCOVERY_TOOLS.has(tool))
  if (attemptedDiscovery && reportsDiscoveryMiss(answer)) {
    return { answerKind: EpisodicAnswerKind.Inconclusive, shortcutEligible: false }
  }

  const shortcutEligible = hasReusableDiscoveryEvidence(answer, input.tools)
  return {
    answerKind: shortcutEligible ? EpisodicAnswerKind.Substantive : EpisodicAnswerKind.Inconclusive,
    shortcutEligible
  }
}

/**
 * Shortcut-worthy when the answer gives the next run something concrete to
 * reuse, or (without discovery tools) delivers knowledge without deferring.
 */
function hasReusableDiscoveryEvidence(answer: string, tools: readonly string[]): boolean {
  if (containsConfirmedArtifacts(answer)) return true

  const attemptedDiscovery = tools.some((tool) => DISCOVERY_TOOLS.has(tool))
  if (attemptedDiscovery) return !reportsDiscoveryMiss(answer)

  return !defersToUser(answer)
}

function containsConfirmedArtifacts(answer: string): boolean {
  return CONFIRMED_ARTIFACT.test(answer)
}

/**
 * Discovery was attempted but the answer reports no catalog hit and names
 * no confirmed object. Distinct from clarification (user must disambiguate).
 */
function reportsDiscoveryMiss(answer: string): boolean {
  if (containsConfirmedArtifacts(answer)) return false

  const normalized = answer.trim().toLowerCase()
  return /\b(?:unable to find|could(?:n't| not) find|no tables?(?:\s+\w+){0,4}\s+(?:mention|match|contain|exist)|(?:does|do) not appear(?: to exist)?|not found in (?:the )?catalog|nothing (?:in the catalog )?matches)\b/.test(
    normalized
  )
}

/**
 * Answer asks the user to disambiguate or supply missing context instead of
 * asserting facts. Leading-sentence check avoids blocking substantive answers
 * that mention clarification deep in the text.
 */
function defersToUser(answer: string): boolean {
  if (containsConfirmedArtifacts(answer)) return false

  const normalized = answer.trim().toLowerCase()
  if (!normalized) return false

  const lead = normalized.slice(0, 240)
  if (
    /^(?:which|what (?:table|column|database|schema)|could you|can you|please clarify|please provide|let me know|if you (?:meant|mean)|do you mean)\b/.test(
      lead
    )
  ) {
    return true
  }

  return normalized.endsWith("?") && normalized.length < 280
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

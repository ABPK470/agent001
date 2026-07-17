/**
 * Goal intent — classify whether a user message is conversational dialogue
 * (text reply is correct) vs. an environment task (tools expected).
 *
 * Uses the goal text plus optional conversation context (`prior_turns` system
 * anchor or the latest assistant message) so short replies like "ok" / "yes"
 * are interpreted correctly:
 *   - After the assistant offered follow-up work → task continuation (tools)
 *   - With no pending offer → passive dialogue (text is fine)
 *
 * @module
 */

import type { Message } from "../../domain/agent-types.js"
import { MessageRole } from "../../domain/enums/message.js"
import {
  DIALOGUE_MEMORY_RE,
  DIALOGUE_RECALL_RE,
  DIALOGUE_RECALL_REFERENCE_RE,
  EXACT_RESPONSE_RE,
  EXPLICIT_ENV_ACTION_RE,
  SESSION_META_DIALOGUE_RE,
  SIMPLE_DIALOGUE_RE
} from "./planner-cluster/internal/decision-patterns.js"

/** Task/work verbs — present in the goal itself → not dialogue. */
const TASK_INTENT_RE =
  /\b(?:build|create|write|run|fix|implement|deploy|query|count|analyze|analyse|find|list|show|generate|delete|update|edit|modify|verify|sync|migrate|refactor|fetch|pull|retrieve|inspect|scan|explore|calculate|compute|split|how many|how much)\b/i

/**
 * Bare one-word check-ins — not data tasks. "test" alone is excluded from
 * TASK_INTENT_RE (common noun in DB questions) but still needs a dialogue path.
 */
const BARE_CHECKIN_RE = /^(?:test|ping|pong|echo)\s*[!.?]*$/i

/** Short consent / go-ahead phrases (need context to distinguish from passive ack). */
const ASSENT_PHRASE_RE =
  /^(?:ok(?:ay)?|k|yes|yep|yeah|y|sure|do it|go ahead|please|go for it|please do|sounds good|that works|let's do it|let's go)\s*[!.?]*$/i

/** Leading assent prefix before a command ("ok, …", "yes, …", "go ahead: …"). */
const LEADING_ASSENT_RE =
  /^(?:ok(?:ay)?|k|yes|yep|yeah|y|sure|please|go ahead|do it|go for it|please do|sounds good|that works|let's do it|let's go)[,.:;]?\s+/i

/** Thanks / closure after receiving an answer — always dialogue. */
const PASSIVE_ACK_RE =
  /^(?:thanks?|thank you|thx|ty|got it|understood|cool|great|nice|perfect|awesome)\s*[!.?]*$/i

/**
 * Assistant offered optional follow-up work — assent to this is a task cue.
 * Mirrors completion-guard premature-handoff patterns.
 */
const ASSISTANT_OFFER_RE =
  /\b(?:(?:I|we) can also|if you (?:want|like)|would you like (?:me to)?|do you want (?:me to)?|should i(?:\s+(?:continue|proceed|implement|fix))?|want me to|let me know if|I could also|happy to|shall I|I can (?:also |)(?:split|run|check|verify|explore|show|list|generate|build|create|fix|update|help|do))\b/i

/** Prior turn ended with an open optional next step (even without "I can also"). */
const ASSISTANT_OPEN_OFFER_RE =
  /\b(?:if you(?:'d| would)? like|optional(?:ly)?|up to you|your call|just (?:say|let me know))\b/i

export interface GoalIntentContext {
  /** Current run messages — used to read `<prior_turns>` or last assistant turn. */
  readonly messages?: readonly Message[]
}

/**
 * True when the goal should be answered conversationally on the first turn
 * without nudging or blocking a text-only response.
 */
export function isDirectDialogueGoal(goal: string, ctx?: GoalIntentContext): boolean {
  const normalized = goal.trim()
  if (!normalized) return true
  if (EXPLICIT_ENV_ACTION_RE.test(normalized)) return false
  if (TASK_INTENT_RE.test(normalized)) return false

  const assentTail = stripAssentPrefix(normalized)
  if (assentTail && (TASK_INTENT_RE.test(assentTail) || assentTail.length > 8)) {
    return false
  }

  if (isAssentPhrase(normalized) && hasActionableAssistantContext(ctx)) {
    return false
  }

  if (SIMPLE_DIALOGUE_RE.test(normalized)) return true
  if (PASSIVE_ACK_RE.test(normalized)) return true
  if (SESSION_META_DIALOGUE_RE.test(normalized)) return true
  if (EXACT_RESPONSE_RE.test(normalized)) return true
  if (DIALOGUE_MEMORY_RE.test(normalized)) return true
  if (
    DIALOGUE_RECALL_RE.test(normalized) &&
    DIALOGUE_RECALL_REFERENCE_RE.test(normalized)
  ) {
    return true
  }

  if (isAssentPhrase(normalized)) return true

  return false
}

/**
 * True when iteration 0 should expose no tools — greetings, meta questions,
 * passive acks, and bare check-ins like "test".
 */
export function isConversationalNoToolGoal(goal: string, ctx?: GoalIntentContext): boolean {
  if (isDirectDialogueGoal(goal, ctx)) return true
  const normalized = goal.trim()
  return normalized.length > 0 && BARE_CHECKIN_RE.test(normalized)
}

/** Skip clarification detectors for conversational / non-data goals. */
export function isClarificationExemptGoal(goal: string, ctx?: GoalIntentContext): boolean {
  if (isDirectSyncExecuteCommand(goal)) return true
  return isConversationalNoToolGoal(goal, ctx)
}

/**
 * Direct `sync_execute planId=<id> confirm=true` command — the exact reply
 * the agent tells the user to send after a sync_preview.
 *
 * This is a structured, agent-generated command, not a natural-language
 * question: there is nothing to clarify. The goal is the command.
 */
const DIRECT_SYNC_EXECUTE_COMMAND_RE =
  /^\s*sync_execute\b[\s\S]{0,160}?\bplanId\s*=\s*["']?[A-Za-z0-9:_-]+["']?[\s\S]{0,160}?\bconfirm\s*=\s*true\b/i

export function isDirectSyncExecuteCommand(goal: string): boolean {
  const stripped = goal.trim().replace(LEADING_ASSENT_RE, "").trim()
  if (!stripped || stripped.endsWith("?")) return false
  return DIRECT_SYNC_EXECUTE_COMMAND_RE.test(stripped)
}

function isAssentPhrase(normalized: string): boolean {
  return ASSENT_PHRASE_RE.test(normalized)
}

/** "yes, split src vs tests" → returns remainder after assent prefix. */
function stripAssentPrefix(normalized: string): string | null {
  const match = normalized.match(
    /^(?:ok(?:ay)?|yes|yep|yeah|sure|please|go ahead)[,.]?\s+(.+)$/i
  )
  const tail = match?.[1]?.trim()
  return tail && tail.length > 0 ? tail : null
}

function hasActionableAssistantContext(ctx?: GoalIntentContext): boolean {
  const narrative = extractPriorAssistantNarrative(ctx?.messages)
  if (!narrative) return false
  return ASSISTANT_OFFER_RE.test(narrative) || ASSISTANT_OPEN_OFFER_RE.test(narrative)
}

/**
 * Most recent assistant narrative: Turn -1 answer inside `<prior_turns>`, else
 * the last assistant message in history.
 */
export function extractPriorAssistantNarrative(
  messages: readonly Message[] | undefined
): string | null {
  if (!messages?.length) return null

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (typeof content !== "string" || !content.includes("<prior_turns>")) continue
    const fromBlock = extractTurnMinusOneAnswer(content)
    if (fromBlock) return fromBlock
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== MessageRole.Assistant) continue
    if (m.section === "system_anchor") continue
    const content = m.content
    return typeof content === "string" && content.trim() ? content : null
  }

  return null
}

/** Parse Turn -1 answer body from a rendered `<prior_turns>` block. */
export function extractTurnMinusOneAnswer(priorTurnsBlock: string): string | null {
  const turnStart = priorTurnsBlock.search(/^Turn -1\b/m)
  if (turnStart < 0) return null

  const slice = priorTurnsBlock.slice(turnStart)
  const answerIdx = slice.search(/^ {2}Answer:\s*$/m)
  if (answerIdx < 0) return null

  const afterAnswer = slice.slice(answerIdx).split("\n").slice(1)
  const lines: string[] = []
  for (const line of afterAnswer) {
    if (/^Turn -\d+\b/.test(line)) break
    if (line.startsWith('When the user uses pronouns')) break
    if (line === "</prior_turns>") break
    if (line.startsWith("    ")) lines.push(line.slice(4))
    else if (line.trim() === "") lines.push("")
    else break
  }

  const text = lines.join("\n").trim()
  return text.length > 0 ? text : null
}

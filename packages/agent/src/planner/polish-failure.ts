/**
 * LLM-polished user-facing failure replies.
 *
 * When the agent hits an internal failure (planner couldn't build a valid
 * plan, all steps failed verification, an integration is missing) we don't
 * want to dump a canned "Something went wrong" line — we want a short,
 * friendly, conversational reply that acknowledges what the user asked
 * and explains we can't help with it. The model gets the goal + an
 * operator-level hint about the failure so it can produce a sensible
 * apology without leaking technical detail.
 *
 * Hard rules enforced via prompt:
 *   - No env var names, no file paths, no JSON, no stack traces.
 *   - No "the team has been notified" claims (we don't actually notify).
 *   - 1–3 sentences max.
 *   - Mention the run reference at the end so the user can forward it.
 */

import type { LLMClient, Message } from "../types.js"

export interface PolishFailureInput {
  /** Original user goal/request. */
  readonly goal: string
  /** Operator-level summary of what actually went wrong. Not shown to user verbatim. */
  readonly operatorSummary: string
  /** Failure category — drives tone (capability vs config vs verification). */
  readonly failureKind:
    | "platform_unconfigured"   // operator config missing
    | "capability_missing"      // tool / feature isn't implemented
    | "verification_failed"     // agent tried but couldn't satisfy criteria
    | "internal"                // catch-all
  /** Run reference the user can forward to an admin. */
  readonly runRef: string
}

const SYSTEM_PROMPT = [
  "You are the voice of an AI assistant replying to an end user whose request could not be completed.",
  "Write a short, kind, plain-language reply (1–3 sentences) acknowledging what they asked and explaining we can't help with it.",
  "",
  "STRICT RULES:",
  "- Do NOT reveal technical details, code, JSON, env var names, file paths, tool names, error codes, or stack traces.",
  "- Do NOT claim that anyone has been notified, alerted, paged, or that the team is investigating.",
  "- Do NOT promise it will be fixed soon or give an ETA.",
  "- Do NOT apologise more than once.",
  "- Do NOT add headings, lists, or markdown formatting.",
  "- Tone: warm, direct, professional, like a helpful colleague.",
  "- Always end with the run reference on its own line, prefixed with 'Reference: ' (no other formatting).",
].join("\n")

function buildUserPrompt(input: PolishFailureInput): string {
  const reasonGuidance = {
    platform_unconfigured: "A backend integration this request needs is not set up on this server. Suggest the user share the reference with an admin so they can configure it.",
    capability_missing:    "This specific capability is not implemented yet — there is no tool that can perform what was asked. Politely say it's not something the assistant can do right now.",
    verification_failed:   "The assistant attempted the work but couldn't produce a result that meets the requirements. Acknowledge the attempt and that it didn't pan out.",
    internal:              "An internal problem prevented completion. Keep it generic.",
  }[input.failureKind]

  return [
    `User asked: """${input.goal.slice(0, 600)}"""`,
    "",
    `Operator-only context (do NOT quote, paraphrase, or hint at this in your reply): ${input.operatorSummary.slice(0, 400)}`,
    "",
    `Situation: ${reasonGuidance}`,
    "",
    `Run reference to include at the end: ${input.runRef}`,
    "",
    "Write the reply now.",
  ].join("\n")
}

const LEAK_PATTERNS = [
  /\b(env|environment)\s+var(iable)?s?\b/i,
  /\bMSSQL\w*\b/,
  /\b[A-Z][A-Z0-9_]{4,}\b/,           // SCREAMING_SNAKE_CASE identifiers
  /\bplanner_failure\b/i,
  /\b(stack\s*trace|exception|TypeError|ReferenceError)\b/i,
  /\.(ts|js|tsx|jsx|json|env)\b/i,
  /\b(tool|function)\s+["'`]?\w+["'`]?\s+(?:not|is)\s+(?:available|configured|implemented)/i,
  /^\s*[{[]/m,                         // looks like JSON
]

function looksLeaky(text: string): boolean {
  if (!text || text.length > 800) return true
  return LEAK_PATTERNS.some((re) => re.test(text))
}

/** Map the operator-facing internal-failure kind onto the prompt's category. */
export function mapFailureKindForPolish(internalKind: string): PolishFailureInput["failureKind"] {
  if (internalKind.startsWith("platform_unconfigured")) return "platform_unconfigured"
  if (internalKind.startsWith("planner_failure:validation")) return "capability_missing"  // unknown_tool, etc.
  if (internalKind.startsWith("planner_failure")) return "internal"
  if (internalKind === "task_failed") return "verification_failed"
  return "internal"
}

/**
 * Try to polish the failure into a friendly natural-language reply via LLM.
 * Returns null if the LLM call fails, times out, or produces something that
 * looks like it leaked technical detail. Caller should fall back to the
 * canned synthesizeGenericFailureAnswer in that case.
 */
export async function polishFailureForUser(
  llm: LLMClient,
  input: PolishFailureInput,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string | null> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildUserPrompt(input) },
  ]

  // Hard deadline so a slow LLM doesn't keep the user staring at "Thinking".
  const timeoutMs = opts?.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = opts?.signal
    ? anySignal([opts.signal, controller.signal])
    : controller.signal

  try {
    const response = await llm.chat(messages, [], { signal, maxTokens: 200 })
    const text = (response.content ?? "").trim()
    if (!text) return null
    if (looksLeaky(text)) return null
    // Ensure the run reference made it in (model can be forgetful).
    if (!text.includes(input.runRef)) {
      return `${text}\n\nReference: ${input.runRef}`
    }
    return text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Combine multiple AbortSignals into one. Aborts when any input aborts.
 * Inline to avoid pulling in another dep; AbortSignal.any is Node 20+.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals)
  }
  const ctrl = new AbortController()
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break }
    s.addEventListener("abort", () => ctrl.abort(), { once: true })
  }
  return ctrl.signal
}

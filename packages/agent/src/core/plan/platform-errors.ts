/**
 * Platform-unconfigured error detection.
 *
 * Some tool failures cannot be repaired by *any* agent action — they require
 * the operator to set an env var, install a credential, or restart the
 * server. Examples: "MSSQL connection X not configured", missing API keys,
 * missing OAuth tokens.
 *
 * The retry/repair loop should NEVER attempt to fix these:
 *   - Each retry will hit the exact same missing config and burn the budget.
 *   - The verifier will produce confusing "incomplete" assessments because
 *     it has no failure class to recognise the cause.
 *
 * The user-facing message MUST stay opaque. End users are not platform
 * developers — they cannot "set MSSQL_HOST" and shouldn't be told to. The
 * full technical detail (subject + remediation) is logged for the operator,
 * and the user is given a run reference to forward.
 */

export interface PlatformUnconfiguredHit {
  /** Short technical label of the missing integration (e.g. "MSSQL connection \"default\""). Operator-facing only. */
  readonly subject: string
  /** Operator-targeted remediation hint. Operator-facing only. */
  readonly remediation: string
}

const PATTERNS: Array<{ regex: RegExp; build: (m: RegExpMatchArray) => PlatformUnconfiguredHit }> = [
  {
    // Match the canonical "MSSQL connection X not configured" message produced
    // by getPool() in any quoting style: "default", 'default', `default`, or
    // bare default (LLM-paraphrased forms in subagent and verifier outputs).
    regex: /MSSQL connection ["'`]?([\w-]+)["'`]? (?:is )?not configured/i,
    build: (m) => ({
      subject: `MSSQL connection "${m[1]}"`,
      remediation:
        "Add a SQL Server connector in the platform menu (Connectors) and restart the server. " +
        "See packages/server/src/api/connectors for the connector model."
    })
  },
  {
    // Generic catch-all for "no MSSQL connection configured" / "not configured"
    // phrasings the LLM might emit when explaining the failure inside a
    // success-shaped tool response.
    regex: /no\s+MSSQL\s+(?:connection|database)\s+(?:is\s+)?configured/i,
    build: () => ({
      subject: `MSSQL`,
      remediation:
        "Add a SQL Server connector in the platform menu (Connectors) and restart the server."
    })
  }
]

/** Returns a hit if the message looks like a platform-unconfigured error, else null. */
export function detectPlatformUnconfigured(message: string): PlatformUnconfiguredHit | null {
  if (!message) return null
  for (const { regex, build } of PATTERNS) {
    const m = message.match(regex)
    if (m) return build(m)
  }
  return null
}

/**
 * Stable sentinel that the server-side run executor matches on to swap in the
 * runId for user reporting. Keep in lockstep with the message in
 * synthesizePlatformUnconfiguredAnswer().
 */
export const PLATFORM_UNCONFIGURED_PREFIX = "This request can’t be completed right now."
const RUN_REF_PLACEHOLDER = "{RUN_REF}"

/**
 * Build the user-facing answer. Deliberately opaque — no env vars, no file
 * paths, no "ask the operator to set X". The user gets one short paragraph
 * and a placeholder for the run reference (the server fills it in). The
 * operator detail is meant to be logged separately, not shown.
 */
export function synthesizePlatformUnconfiguredAnswer(): string {
  return [
    PLATFORM_UNCONFIGURED_PREFIX,
    "",
    `A platform component this request depends on isn’t available on this server. This is a configuration issue on our side, not something you can fix from the chat.`,
    "",
    `Please report this to the platform admin and include the reference: ${RUN_REF_PLACEHOLDER}`
  ].join("\n")
}

/** Replace the {RUN_REF} placeholder with the actual run reference. */
export function fillRunReference(answer: string, runId: string): string {
  return answer.replaceAll(RUN_REF_PLACEHOLDER, runId)
}

/** True if the answer was produced by synthesizePlatformUnconfiguredAnswer. */
export function isPlatformUnconfiguredAnswer(answer: string): boolean {
  return answer.startsWith(PLATFORM_UNCONFIGURED_PREFIX)
}

// ── Generic user-safe failure (planner errors, internal task failures) ──
//
// Same idea as platform-unconfigured but for failures the *agent* itself
// hit (planner couldn't build a valid plan, all steps failed verification,
// the LLM hallucinated a tool, etc). The user must NOT see the JSON
// diagnostic dump — they see one short, plain sentence and a run reference
// to forward to an admin. Operators get the raw detail via server-side
// logs and audit events.

/** Stable sentinel prefix the UI matches to render this as an error card. */
export const GENERIC_FAILURE_PREFIX = "This request couldn’t be completed."

/**
 * Stable invisible marker prepended to LLM-polished failure replies so the
 * UI can still recognise them as failures (and render them in the warning
 * card style with the run-ref chip) without the marker being visible to
 * the user. Uses invisible separator characters plus ASCII so no warning
 * symbol can leak into user-visible text.
 */
export const POLISHED_FAILURE_MARKER = "\u2063pfm:\u2063"

/** True if a string starts with the invisible polished-failure marker. */
export function isPolishedFailureAnswer(answer: string): boolean {
  return answer.startsWith(POLISHED_FAILURE_MARKER)
}

/** Wrap a polished reply with the invisible marker for UI detection. */
export function markPolishedFailure(text: string): string {
  return `${POLISHED_FAILURE_MARKER}${text}`
}

/** Build the opaque generic-failure answer with a placeholder for run reference. */
export function synthesizeGenericFailureAnswer(): string {
  return [
    GENERIC_FAILURE_PREFIX,
    "",
    `Something went wrong while processing this request.`,
    "",
    `Please share this reference with an admin so they can investigate: ${RUN_REF_PLACEHOLDER}`
  ].join("\n")
}

/** True if the answer was produced by synthesizeGenericFailureAnswer. */
export function isGenericFailureAnswer(answer: string): boolean {
  return answer.startsWith(GENERIC_FAILURE_PREFIX)
}

/** True if the answer is any opaque user-safe failure (platform OR generic OR polished). */
export function isUserSafeFailureAnswer(answer: string): boolean {
  return (
    isPlatformUnconfiguredAnswer(answer) || isGenericFailureAnswer(answer) || isPolishedFailureAnswer(answer)
  )
}

/**
 * Detect failure shapes the agent emits as raw text/JSON that should NEVER
 * reach the chat user. Returns operator-facing detail when matched.
 *
 * Cases:
 *   - Raw `{"kind":"planner_failure", ...}` JSON (validation/generation)
 *   - "Task FAILED" / "Task verification FAILED" prefix (verifier gave up)
 */
export interface InternalFailureHit {
  /** Short label for logs / admin alert (e.g. "planner_failure:validation"). */
  readonly kind: string
  /** One-line operator summary (truncated). */
  readonly summary: string
  /** Full raw text for db log / audit. */
  readonly rawDetail: string
}

export function detectInternalFailure(answer: string): InternalFailureHit | null {
  if (!answer) return null
  // Already opaque — leave it alone.
  if (isUserSafeFailureAnswer(answer)) return null

  // Planner failure JSON (buildPlannerFailurePayload output).
  const trimmed = answer.trimStart()
  if (trimmed.startsWith("{") && trimmed.includes('"kind"') && trimmed.includes("planner_failure")) {
    try {
      const parsed = JSON.parse(trimmed) as { kind?: string; stage?: string; reason?: string }
      if (parsed.kind === "planner_failure") {
        const stage = typeof parsed.stage === "string" ? parsed.stage : "unknown"
        const reason = typeof parsed.reason === "string" ? parsed.reason : "(no reason)"
        return {
          kind: `planner_failure:${stage}`,
          summary: reason.slice(0, 280),
          rawDetail: answer
        }
      }
    } catch {
      /* fall through */
    }
  }

  // Verifier "Task FAILED" / "Task verification FAILED" wall.
  if (answer.startsWith("Task FAILED") || answer.startsWith("Task verification FAILED")) {
    const firstLine = answer.split("\n", 1)[0] ?? ""
    return {
      kind: "task_failed",
      summary: firstLine.slice(0, 280),
      rawDetail: answer
    }
  }

  return null
}

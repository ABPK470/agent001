/**
 * AgentChat failure-card helpers — lockstep with agent platform-errors markers.
 */

const PLATFORM_UNCONFIGURED_PREFIX = "This request can\u2019t be completed right now."
const GENERIC_FAILURE_PREFIX = "This request couldn\u2019t be completed."
/** Invisible marker prepended to LLM-polished failure replies. */
export const POLISHED_FAILURE_MARKER = "\u2063pfm:\u2063"

export function isUserSafeFailureAnswer(text: string): boolean {
  return (
    text.startsWith(PLATFORM_UNCONFIGURED_PREFIX) ||
    text.startsWith(GENERIC_FAILURE_PREFIX) ||
    text.startsWith(POLISHED_FAILURE_MARKER)
  )
}

export function stripFailureMarkers(text: string): string {
  if (text.startsWith(POLISHED_FAILURE_MARKER)) return text.slice(POLISHED_FAILURE_MARKER.length)
  return text
}

export function extractRunRef(text: string): string | null {
  const m = text.match(/reference:\s*([A-Za-z0-9._-]+)/i)
  return m ? m[1]! : null
}

export function formatRunFailureMessage(text: string): string {
  const normalized = text.trim().toLowerCase()
  if (
    normalized.startsWith("device flow") ||
    normalized.startsWith("copilot oauth token expired")
  ) {
    return "Authentication with Copilot expired. Please re-authorize and try again."
  }
  return text
}

/** Body shown in the failure notice card (marker + trailing Reference line stripped). */
export function formatFailureAnswerBody(answer: string): {
  body: string
  ref: string | null
} {
  const ref = extractRunRef(answer)
  const stripped = stripFailureMarkers(answer)
  const body = (
    ref
      ? stripped.replace(/\n*\s*Reference:\s*[A-Za-z0-9._-]+\s*$/i, "")
      : stripped
  ).trim()
  return { body, ref }
}

/**
 * Classify operator-facing failure text into a short user-safe reason.
 *
 * Users deserve to know *what kind* of thing went wrong — rate limit,
 * checks not met, temporary outage — without SQL dumps or stack traces.
 *
 * @module
 */

import type { InternalFailureHit } from "./platform-errors.js"

export type UserFacingFailureKind =
  | "rate_limited"
  | "verification_failed"
  | "delegation_failed"
  | "capability_missing"
  | "platform_unconfigured"
  | "internal"

export interface UserFacingFailure {
  readonly kind: UserFacingFailureKind
  /** One plain sentence for the chat answer. */
  readonly userReason: string
}

const RATE_LIMIT_RE =
  /rate\s*limit|request\s*limit\s*exceeded|too\s*many\s*requests|429\b|quota\s*exceeded|throttl/i

const DELEGATION_RE = /delegation\s*failed/i

function firstIssueLine(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("!")) continue
    const issue = trimmed.replace(/^!\s*/, "").trim()
    if (!issue) continue
    if (RATE_LIMIT_RE.test(issue) || DELEGATION_RE.test(issue)) continue
    if (/[{[]/.test(issue) || issue.length > 180) continue
    if (/\.(ts|js|tsx)\b|stack\s*trace|TypeError/i.test(issue)) continue
    return issue
  }
  return null
}

/** Classify an internal failure hit into a user-safe reason sentence. */
export function classifyUserFacingFailure(hit: InternalFailureHit): UserFacingFailure {
  const blob = `${hit.kind}\n${hit.summary}\n${hit.rawDetail}`

  if (RATE_LIMIT_RE.test(blob)) {
    return {
      kind: "rate_limited",
      userReason:
        "The AI service hit a temporary rate limit while working on this request. Please try again in a moment."
    }
  }

  if (hit.kind.startsWith("platform_unconfigured")) {
    return {
      kind: "platform_unconfigured",
      userReason:
        "A platform component this request depends on isn’t available on this server. An admin needs to configure it."
    }
  }

  if (hit.kind.startsWith("planner_failure:validation")) {
    return {
      kind: "capability_missing",
      userReason:
        "This request needs a capability that isn’t available for the current plan. Try a simpler ask, or share the reference with an admin."
    }
  }

  if (DELEGATION_RE.test(blob) && !RATE_LIMIT_RE.test(blob)) {
    return {
      kind: "delegation_failed",
      userReason:
        "A subagent step failed before it could finish. Expand the failed step in the timeline for the full error, or try again."
    }
  }

  if (hit.kind === "task_failed" || /Task verification FAILED|Task FAILED/i.test(hit.rawDetail)) {
    const issue = firstIssueLine(hit.rawDetail)
    if (issue) {
      return {
        kind: "verification_failed",
        userReason: `The work didn’t pass the final checks: ${issue}`
      }
    }
    return {
      kind: "verification_failed",
      userReason:
        "The assistant attempted the work but couldn’t produce a result that meets the requirements after several repair attempts."
    }
  }

  return {
    kind: "internal",
    userReason: "Something went wrong while processing this request."
  }
}

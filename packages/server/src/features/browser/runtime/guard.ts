/**
 * Server-side compliance guard — composes domain policy, per-(upn,host)
 * token bucket, and the audit log so the agent can call a single
 * `checkUrl` / `recordAction` pair before/after every navigation.
 *
 * The guard is bound to a specific `ownerUpn` at construction time so
 * the agent can't accidentally pass it the wrong tenant id.
 *
 * @module
 */

import type { BrowserGuard } from "@mia/agent"

import { appendAudit } from "../application/audit.js"
import { tryConsumeDomainToken } from "../domain/limits.js"
import { evaluatePolicy } from "../domain/policy.js"

export function createGuardForUpn(ownerUpn: string): BrowserGuard {
  return {
    async checkUrl(url: string) {
      const decision = evaluatePolicy(ownerUpn, url)
      if (!decision.allow) {
        appendAudit({
          ownerUpn,
          action: "browse_web.navigate",
          targetUrl: url,
          decision: "deny",
          detail: decision.reason
        })
        return { allow: false, reason: decision.reason }
      }

      // Per-(upn, host) rate limit.
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        return { allow: false, reason: `invalid URL: ${url}` }
      }
      const tok = tryConsumeDomainToken(ownerUpn, host)
      if (!tok.allowed) {
        appendAudit({
          ownerUpn,
          action: "browse_web.navigate",
          targetUrl: url,
          decision: "deny",
          detail: `rate limit exceeded for ${host}`
        })
        return {
          allow: false,
          reason: `rate limit exceeded for ${host}`,
          retryAfterMs: tok.retryAfterMs
        }
      }
      return { allow: true, reason: "" }
    },

    async recordAction(input) {
      try {
        appendAudit({
          ownerUpn,
          action: input.action,
          targetUrl: input.url ?? null,
          detail: input.detail ?? null,
          decision: "allow"
        })
      } catch {
        // best-effort — never break the agent because of an audit-log
        // write failure.
      }
    }
  }
}

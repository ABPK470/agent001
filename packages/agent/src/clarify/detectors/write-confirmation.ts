// write-confirmation detector — "about to write to a real (non-temp) table".
//
// Fires (block-severity) when ctx.lastSqlText contains a DML/DDL
// statement whose target table is NOT a session-temp (#xxx) name.
// The agent is expected to ask the user to confirm before any
// destructive or persisting write proceeds.
//
// Pure function of (lastSqlText). No catalog, no I/O.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"

const VERSION = "1.0.0"

/**
 * Mutating statement keywords. We match the verb followed by either
 * INTO/TABLE/FROM/JOIN-style targets so a SELECT containing the verb
 * inside a string literal does not trigger a false positive in the
 * normal case. The pattern is intentionally conservative — false
 * negatives are preferable to false positives that block reads.
 */
const MUTATING = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+(?:TABLE|VIEW|INDEX|PROCEDURE|FUNCTION)|ALTER\s+(?:TABLE|VIEW)|TRUNCATE\s+TABLE|MERGE\s+INTO|CREATE\s+(?:TABLE|VIEW|PROCEDURE|FUNCTION))\s+([^\s(;]+)/gi

/**
 * Target qualifies as a "temp" target — session (#x) or global (##x)
 * — and is therefore safe to write without user confirmation.
 */
function isTempTarget(name: string): boolean {
  // strip schema prefix, brackets, quotes
  const t = name.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "")
  const last = t.split(".").pop() ?? t
  return last.startsWith("#")
}

export const writeConfirmationDetector: Detector = {
  id: "write-confirmation",
  version: VERSION,

  detect(ctx) {
    const sql = ctx.lastSqlText
    if (!sql) return []
    const out = []
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    // reset lastIndex defensively — exec on /g is stateful
    MUTATING.lastIndex = 0
    while ((m = MUTATING.exec(sql)) !== null) {
      const verb = m[1].replace(/\s+/g, " ").toUpperCase()
      const target = m[2]
      if (isTempTarget(target)) continue
      const subject = `${verb} ${target}`
      if (seen.has(subject)) continue
      seen.add(subject)
      out.push({
        id: makeFindingId("write-confirmation", subject),
        kind: "write-confirmation" as const,
        severity: "block" as const,
        subject,
        reasoning: `Planned/recent SQL contains "${verb} ${target}" — a write against a real (non-temp) object.`,
        suggestedQuestion: `Confirm: should I execute "${verb} ${target}"? (Reply yes to proceed, or describe a safer alternative.)`,
        source: "detector" as const,
      })
    }
    return out
  },
}

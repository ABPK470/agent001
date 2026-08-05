/**
 * Step-block header chrome — muted tags for heal/retry; loud pill only for
 * unrepaired failure. Uniform across all plan-step rollups in chat.
 */

import type { StepBlockOutcome } from "../../lib/events/build-chat-parts"

export type StepHeaderChrome =
  | { kind: "muted"; text: string }
  | { kind: "failed"; detail?: string }

/** Whether a nested verify beat should render in the chat tree. */
export function shouldShowStepCheckInChat(
  outcome: StepBlockOutcome | undefined,
): boolean {
  // Repair success already proves the gate — don't float "Checked work".
  return outcome !== "repaired" && outcome !== "passed"
}

export function stepBlockHeaderChrome(opts: {
  outcome?: StepBlockOutcome
  detail?: string
  isRetrying: boolean
  isFailed: boolean
}): StepHeaderChrome | null {
  if (opts.isRetrying) return { kind: "muted", text: "(retrying)" }
  if (opts.outcome === "repaired") {
    const dur = opts.detail?.trim()
    // Duration first when present: "· 2.7s (auto-repaired)"
    if (dur && !/^attempt\s+\d+/i.test(dur) && !dur.startsWith("(")) {
      return { kind: "muted", text: `· ${dur} (auto-repaired)` }
    }
    return { kind: "muted", text: "(auto-repaired)" }
  }
  if (opts.isFailed) return { kind: "failed", detail: opts.detail }
  if (opts.detail?.trim()) return { kind: "muted", text: `· ${opts.detail.trim()}` }
  return null
}

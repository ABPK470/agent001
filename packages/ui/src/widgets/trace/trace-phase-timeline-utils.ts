/**
 * Phase timeline display — relative offsets and outcome-aware row kinds.
 */

export type TimelineEventKind = "neutral" | "warn" | "error" | "tools" | "complete"

/** Phase/tree outcome for timeline chrome — not “the word Finished”. */
export type TimelinePhaseOutcome = "success" | "failed" | "running"

const MS_RE = /(\d+(?:\.\d+)?)\s*ms\b/i
const TOOLS_RE = /^Tools:/i
const COMPLETE_RE = /^(Finished|Completed|done\b)/i
const STEPS_FINISHED_RE = /^(Finished|Completed)\s+(\d+)\/(\d+)\s+steps\s*\(([^)]*)\)/i

export function parseEventMs(text: string): number | null {
  const match = text.match(MS_RE)
  if (!match?.[1]) return null
  return Math.round(parseFloat(match[1]))
}

export function timelinePhaseOutcome(input: {
  phaseStatus: "running" | "done" | "error"
  nodeStatus: "success" | "failed" | "running" | "skipped"
  nodeHasError: boolean
  branchHasError: boolean
}): TimelinePhaseOutcome {
  if (
    input.nodeHasError ||
    input.branchHasError ||
    input.nodeStatus === "failed" ||
    input.phaseStatus === "error"
  ) {
    return "failed"
  }
  if (input.phaseStatus === "done" && input.nodeStatus === "success") return "success"
  if (input.nodeStatus === "running" || input.phaseStatus === "running") return "running"
  return "success"
}

/**
 * Completion rows follow phase/tree outcome — never greenwash a failed branch
 * just because the lifecycle string says "Finished".
 */
export function timelineEventKind(
  text: string,
  tone: string | undefined,
  _isLast: boolean,
  outcome: TimelinePhaseOutcome,
): TimelineEventKind {
  if (tone === "error") return "error"
  if (tone === "warn") return "warn"
  if (TOOLS_RE.test(text)) return "tools"
  if (COMPLETE_RE.test(text)) {
    if (outcome === "failed") return "error"
    if (outcome === "success") return "complete"
    // Running / unsettled — do not claim success with a green check.
    return "neutral"
  }
  // Failed branch: last row is the outcome marker even without "Finished" wording.
  if (outcome === "failed" && _isLast) return "error"
  return "neutral"
}

/** Rewrite completion copy when the branch/phase failed. */
export function timelineEventDisplayText(
  text: string,
  outcome: TimelinePhaseOutcome,
): string {
  if (outcome !== "failed") return text

  const steps = text.match(STEPS_FINISHED_RE)
  if (steps) {
    const completed = steps[2]!
    const total = steps[3]!
    return `Finished ${completed}/${total} steps (failed)`
  }

  if (/^Finished\b/i.test(text)) {
    return text.replace(/^Finished/i, "Failed")
  }
  if (/^Completed\b/i.test(text)) {
    return text.replace(/^Completed/i, "Failed")
  }
  if (/^done\b/i.test(text)) {
    return text.replace(/^done/i, "Failed")
  }
  return text
}

/** Relative ms column — parsed from text or interpolated across phase duration. */
export function buildTimelineOffsets(
  events: Array<{ text: string }>,
  phaseDurationMs: number | null,
): number[] {
  if (events.length === 0) return []
  const parsed = events.map((ev) => parseEventMs(ev.text))
  const anchor =
    phaseDurationMs ??
    parsed.reduce<number | null>((max, ms) => (ms != null ? Math.max(max ?? 0, ms) : max), null)

  if (anchor == null || anchor <= 0) {
    return events.map((_, i) => parsed[i] ?? 0)
  }

  return events.map((_, i) => {
    if (parsed[i] != null) return parsed[i]!
    if (events.length === 1) return anchor
    return Math.round((anchor * i) / (events.length - 1))
  })
}

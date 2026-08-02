/**
 * Phase timeline display — relative offsets and row kind from event text.
 */

export type TimelineEventKind = "neutral" | "warn" | "error" | "tools" | "complete"

const MS_RE = /(\d+(?:\.\d+)?)\s*ms\b/i
const TOOLS_RE = /^Tools:/i
const COMPLETE_RE = /^(Finished|Completed|done\b)/i

export function parseEventMs(text: string): number | null {
  const match = text.match(MS_RE)
  if (!match?.[1]) return null
  return Math.round(parseFloat(match[1]))
}

export function timelineEventKind(
  text: string,
  tone: string | undefined,
  isLast: boolean,
  phaseDone: boolean,
): TimelineEventKind {
  if (tone === "error") return "error"
  if (tone === "warn") return "warn"
  if (TOOLS_RE.test(text)) return "tools"
  if (isLast && phaseDone && COMPLETE_RE.test(text)) return "complete"
  if (COMPLETE_RE.test(text)) return "complete"
  return "neutral"
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
    return events.map((_, i) => (parsed[i] ?? 0))
  }

  return events.map((_, i) => {
    if (parsed[i] != null) return parsed[i]!
    if (events.length === 1) return anchor
    return Math.round((anchor * i) / (events.length - 1))
  })
}

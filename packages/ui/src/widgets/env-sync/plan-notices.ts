/**
 * Split plan notice strings into quiet notes vs real alerts.
 * Notes stay visible; they must not share conflict-level chrome.
 */

/** Informational — expected/ops context, not blockers. */
export function isQuietPlanNote(message: string): boolean {
  const text = message.trim()
  if (text.startsWith("FK-only tables excluded")) return true
  if (text.startsWith("[scd2-schema]")) return true
  return false
}

export function partitionPlanNotices(messages: readonly string[]): {
  notes: string[]
  alerts: string[]
} {
  const notes: string[] = []
  const alerts: string[] = []
  for (const message of messages) {
    if (isQuietPlanNote(message)) notes.push(message)
    else alerts.push(message)
  }
  return { notes, alerts }
}

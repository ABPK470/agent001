export const DEFAULT_THREAD_TITLE = "New thread"

export function isDefaultThreadTitle(title: string | undefined | null): boolean {
  const trimmed = (title ?? "").trim()
  return !trimmed || trimmed === DEFAULT_THREAD_TITLE
}

export function threadTitleFromGoal(goal: string): string {
  const trimmed = goal.trim().replace(/\s+/g, " ")
  if (!trimmed) return DEFAULT_THREAD_TITLE
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed
}

/**
 * Event Stream time labels — one quiet dialect for rows + chrome.
 *
 * Today → clock only. Past same year → short date + clock (no year spam).
 * Cross-year → include year. Matches histogram bound rules.
 */

function localDateKey(ms: number): string {
  return new Date(ms).toDateString()
}

function formatClock(ms: number, withSeconds: boolean): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  })
}

function formatShortDate(ms: number, withYear: boolean): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
  })
}

/**
 * Row timestamp for the Event Stream scan grid.
 * Full ISO stays on `title` for copy/inspect.
 */
export function formatEventStreamRowTime(
  iso: string | undefined,
  opts?: { nowMs?: number; tiny?: boolean },
): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    const date = iso.slice(0, 10)
    const time = iso.slice(11, 19)
    return date && time ? `${date} ${time}` : iso
  }

  const nowMs = opts?.nowMs ?? Date.now()
  const tiny = opts?.tiny === true
  const withSeconds = !tiny
  const time = formatClock(ms, withSeconds)
  const isToday = localDateKey(ms) === localDateKey(nowMs)
  if (isToday) return time

  const sameYear = new Date(ms).getFullYear() === new Date(nowMs).getFullYear()
  const date = formatShortDate(ms, !sameYear)
  return `${date} ${time}`
}

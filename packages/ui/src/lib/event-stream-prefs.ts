/**
 * Event Stream filter prefs — survive view switches (widget unmount/remount).
 * sessionStorage, keyed by tile id — same dialect as composer drafts.
 */

export type EventStreamRange = "live" | "15m" | "1h" | "6h" | "24h"

export type EventStreamWindow = {
  range: EventStreamRange
  from?: string
  to?: string
}

export const EVENT_TYPES = ["run", "step", "sync", "bridge", "agent", "api", "system"] as const
export type EventStreamEventType = (typeof EVENT_TYPES)[number]

export type EventStreamFilterPrefs = {
  typeFilters: EventStreamEventType[]
  errorsOnly: boolean
  searchText: string
  window: EventStreamWindow
}

const STORAGE_PREFIX = "mia:event-stream-prefs:"
const RANGES = new Set<EventStreamRange>(["live", "15m", "1h", "6h", "24h"])

export const DEFAULT_EVENT_STREAM_PREFS: EventStreamFilterPrefs = {
  typeFilters: [],
  errorsOnly: false,
  searchText: "",
  window: { range: "live" },
}

export function eventStreamPrefsKey(tileId: string | null | undefined): string | null {
  if (!tileId || tileId.trim().length === 0) return null
  return `${STORAGE_PREFIX}${tileId}`
}

function isEventType(value: unknown): value is EventStreamEventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value)
}

function parseWindow(raw: unknown): EventStreamWindow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { range: "live" }
  const o = raw as Record<string, unknown>
  const range = typeof o["range"] === "string" && RANGES.has(o["range"] as EventStreamRange)
    ? (o["range"] as EventStreamRange)
    : "live"
  const from = typeof o["from"] === "string" && o["from"] ? o["from"] : undefined
  const to = typeof o["to"] === "string" && o["to"] ? o["to"] : undefined
  return { range, ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

export function readEventStreamPrefs(
  tileId: string | null | undefined,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): EventStreamFilterPrefs {
  const key = eventStreamPrefsKey(tileId)
  if (!key) return { ...DEFAULT_EVENT_STREAM_PREFS, window: { range: "live" } }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { ...DEFAULT_EVENT_STREAM_PREFS, window: { range: "live" } }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const types = Array.isArray(parsed["typeFilters"])
      ? parsed["typeFilters"].filter(isEventType)
      : []
    return {
      typeFilters: types,
      errorsOnly: parsed["errorsOnly"] === true,
      searchText: typeof parsed["searchText"] === "string" ? parsed["searchText"] : "",
      window: parseWindow(parsed["window"]),
    }
  } catch {
    return { ...DEFAULT_EVENT_STREAM_PREFS, window: { range: "live" } }
  }
}

export function writeEventStreamPrefs(
  tileId: string | null | undefined,
  prefs: EventStreamFilterPrefs,
  storage: Pick<Storage, "setItem" | "removeItem"> = sessionStorage,
): void {
  const key = eventStreamPrefsKey(tileId)
  if (!key) return
  try {
    const empty =
      prefs.typeFilters.length === 0 &&
      !prefs.errorsOnly &&
      !prefs.searchText.trim() &&
      prefs.window.range === "live" &&
      !prefs.window.from &&
      !prefs.window.to
    if (empty) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify(prefs))
  } catch (err: unknown) {
    console.error("[mia]", err)
  }
}

export function clearEventStreamPrefs(
  tileId: string | null | undefined,
  storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
  const key = eventStreamPrefsKey(tileId)
  if (!key) return
  try {
    storage.removeItem(key)
  } catch (err: unknown) {
    console.error("[mia]", err)
  }
}

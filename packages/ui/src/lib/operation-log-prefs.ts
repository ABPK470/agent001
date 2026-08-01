/**
 * Pipelines filter prefs — survive view switches (widget unmount/remount).
 * sessionStorage, keyed by tile id — same dialect as Event Stream prefs.
 */

import type { EventStreamRange, EventStreamWindow } from "./event-stream-prefs"
import type { OperationStatus } from "../client/index"

export type PipelineKindFilter = "agent" | "sync" | "bridge"

export type { EventStreamRange as OperationsTimeRange, EventStreamWindow as OperationsTimeWindow }

export type OperationLogFilterPrefs = {
  kinds: PipelineKindFilter[]
  statuses: OperationStatus[]
  searchText: string
  window: EventStreamWindow
}

const STORAGE_PREFIX = "mia:operation-log-prefs:"
const RANGES = new Set<EventStreamRange>(["live", "15m", "1h", "6h", "24h"])
const KINDS = new Set<PipelineKindFilter>(["agent", "sync", "bridge"])
const STATUSES = new Set<OperationStatus>([
  "running",
  "success",
  "failed",
  "cancelled",
  "skipped",
  "unknown",
])

export const DEFAULT_OPERATION_LOG_PREFS: OperationLogFilterPrefs = {
  kinds: [],
  statuses: [],
  searchText: "",
  window: { range: "live" },
}

export function operationLogPrefsKey(tileId: string | null | undefined): string | null {
  if (!tileId || tileId.trim().length === 0) return null
  return `${STORAGE_PREFIX}${tileId}`
}

function parseWindow(raw: unknown): EventStreamWindow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { range: "live" }
  const o = raw as Record<string, unknown>
  const range =
    typeof o["range"] === "string" && RANGES.has(o["range"] as EventStreamRange)
      ? (o["range"] as EventStreamRange)
      : "live"
  const from = typeof o["from"] === "string" && o["from"] ? o["from"] : undefined
  const to = typeof o["to"] === "string" && o["to"] ? o["to"] : undefined
  return { range, ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

export function readOperationLogPrefs(
  tileId: string | null | undefined,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): OperationLogFilterPrefs {
  const key = operationLogPrefsKey(tileId)
  if (!key) return { ...DEFAULT_OPERATION_LOG_PREFS, window: { range: "live" } }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { ...DEFAULT_OPERATION_LOG_PREFS, window: { range: "live" } }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const kinds = Array.isArray(parsed["kinds"])
      ? parsed["kinds"].filter((k): k is PipelineKindFilter => KINDS.has(k as PipelineKindFilter))
      : []
    const statuses = Array.isArray(parsed["statuses"])
      ? parsed["statuses"].filter((s): s is OperationStatus => STATUSES.has(s as OperationStatus))
      : []
    return {
      kinds,
      statuses,
      searchText: typeof parsed["searchText"] === "string" ? parsed["searchText"] : "",
      window: parseWindow(parsed["window"]),
    }
  } catch {
    return { ...DEFAULT_OPERATION_LOG_PREFS, window: { range: "live" } }
  }
}

export function writeOperationLogPrefs(
  tileId: string | null | undefined,
  prefs: OperationLogFilterPrefs,
  storage: Pick<Storage, "setItem" | "removeItem"> = sessionStorage,
): void {
  const key = operationLogPrefsKey(tileId)
  if (!key) return
  const empty =
    prefs.kinds.length === 0 &&
    prefs.statuses.length === 0 &&
    prefs.searchText.trim() === "" &&
    prefs.window.range === "live" &&
    !prefs.window.from &&
    !prefs.window.to
  if (empty) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, JSON.stringify(prefs))
}

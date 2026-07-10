import type { FreezeWindow } from "../../../types"

export const FREEZE_WINDOW_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

export type FreezeWindowEditState = {
  isNew: boolean
  id: string
  idTouched: boolean
  displayName: string
  description: string
  startsLocal: string
  endsLocal: string
  busy: boolean
}

export type FreezeWindowStatus = "active" | "scheduled" | "past"

export function deriveFreezeWindowSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 64)
}

export function uniquifyFreezeWindowId(base: string, existing: readonly string[]): string {
  if (!base || !existing.includes(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`.slice(0, 64)
    if (!existing.includes(candidate)) return candidate
  }
  return base
}

export function formatFreezeWindowDate(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function blankFreezeWindowEditState(): FreezeWindowEditState {
  const now = new Date()
  const soon = new Date(now.getTime() + 60 * 60 * 1000)
  return {
    isNew: true,
    id: "",
    idTouched: false,
    displayName: "",
    description: "",
    startsLocal: toLocalDateTimeInput(now.toISOString()),
    endsLocal: toLocalDateTimeInput(soon.toISOString()),
    busy: false,
  }
}

export function freezeWindowToEditState(window: FreezeWindow): FreezeWindowEditState {
  return {
    isNew: false,
    id: window.id,
    idTouched: false,
    displayName: window.displayName,
    description: window.description ?? "",
    startsLocal: toLocalDateTimeInput(window.startsAt),
    endsLocal: toLocalDateTimeInput(window.endsAt),
    busy: false,
  }
}

export function freezeWindowStatus(window: FreezeWindow, now = Date.now()): FreezeWindowStatus {
  const starts = Date.parse(window.startsAt)
  const ends = Date.parse(window.endsAt)
  if (now < starts) return "scheduled"
  if (now > ends) return "past"
  return "active"
}

export function validateFreezeWindowEditState(state: FreezeWindowEditState): string | null {
  if (!state.displayName.trim()) return "Add a name"
  if (!state.startsLocal || !state.endsLocal) return "Pick start and end"
  if (!FREEZE_WINDOW_ID_RE.test(state.id)) return "Invalid id"
  if (Date.parse(state.endsLocal) <= Date.parse(state.startsLocal)) return "End after start"
  return null
}

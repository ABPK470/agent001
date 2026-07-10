/**
 * FreezeWindowsSelect — checkbox list of available freeze windows.
 *
 * Pulls from `GET /api/sync/freeze-windows`. An entity may reference
 * zero or more windows; the gate blocks a sync when *any* matched
 * window's [startsAt, endsAt) brackets `now`.
 *
 * Empty registry — use the manage icon in the entity editor to create windows.
 */

import { CalendarClock, Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../api"
import type { FreezeWindow } from "../../types"

export interface FreezeWindowsSelectProps {
  selected:   readonly string[]
  onSelected: (next: string[]) => void
}

export function FreezeWindowsSelect({ selected, onSelected }: FreezeWindowsSelectProps): JSX.Element {
  const [items,   setItems]   = useState<FreezeWindow[]>([])
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api.listFreezeWindows()
      .then((r) => { if (!cancelled) setItems(r.items) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  function toggle(id: string): void {
    onSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" /> loading freeze windows…
      </div>
    )
  }
  if (err) return <div className="text-rose-300">failed to load freeze windows: {err}</div>

  // Always render any *selected* id even if the registry doesn't know
  // about it — so the operator can see (and uncheck) a stale reference.
  const known = new Set(items.map((w) => w.id))
  const orphans = selected.filter((id) => !known.has(id))

  return (
    <div className="flex flex-col gap-1.5">
      {items.length === 0 && orphans.length === 0 && (
        <p className="text-text-faint">
          No freeze windows defined. Use the calendar icon in the entity editor to create one.
        </p>
      )}
      {items.map((w) => {
        const checked = selected.includes(w.id)
        return (
          <label key={w.id} className="flex items-start gap-2 rounded border border-border-subtle bg-panel px-2 py-1.5 hover:bg-overlay-2">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(w.id)}
              className="mt-0.5 accent-accent"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <CalendarClock className="h-3 w-3 text-text-faint" />
                <span className="font-mono text-sm text-text">{w.id}</span>
                <span className="text-text-muted">— {w.displayName}</span>
              </div>
              <div className="text-xs text-text-faint">
                {fmt(w.startsAt)} → {fmt(w.endsAt)}
              </div>
              {w.description && (
                <div className="text-xs text-text-muted">{w.description}</div>
              )}
            </div>
          </label>
        )
      })}
      {orphans.map((id) => (
        <label key={id} className="flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5">
          <input
            type="checkbox"
            checked
            onChange={() => toggle(id)}
            className="mt-0.5 accent-rose-500"
          />
          <div className="flex-1">
            <span className="font-mono text-sm text-rose-300">{id}</span>
            <span className="ml-2 text-xs text-rose-300">
              unknown id — save will fail until removed or defined
            </span>
          </div>
        </label>
      ))}
    </div>
  )
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z"
  } catch {
    return iso
  }
}

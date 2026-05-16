/**
 * StrategySelect — dropdown of SCD2 strategies + version picker.
 *
 * Pulls from `GET /api/entity-registry/strategies` (bundled ⊕ tenant
 * custom). Each option shows the displayName and is grouped by
 * provenance: bundled vs tenant-custom.
 *
 * Version dropdown is a separate `<select>` whose options are
 * `"latest"` plus every concrete version we've seen for the chosen
 * strategy id. Pinning to a number freezes against historical schema
 * evolution; `"latest"` tracks the current pointer.
 */

import { Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import type { EntityRegistryStrategy } from "../../types"

export interface StrategySelectProps {
  strategyId:      string
  strategyVersion: number | "latest"
  onStrategyId:      (v: string) => void
  onStrategyVersion: (v: number | "latest") => void
  /** When true, render a compact one-column layout (for narrow modals). */
  compact?: boolean
}

export function StrategySelect(p: StrategySelectProps): JSX.Element {
  const [items,   setItems]   = useState<EntityRegistryStrategy[]>([])
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api.listEntityRegistryStrategies()
      .then((r) => { if (!cancelled) setItems(r.items) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const chosen = useMemo(() => items.find((s) => s.id === p.strategyId), [items, p.strategyId])

  // Group by provenance.kind for the `<optgroup>` layout.
  const groups = useMemo(() => {
    const by: Record<string, EntityRegistryStrategy[]> = {}
    for (const s of items) {
      const k = s.provenance.kind
      ;(by[k] ??= []).push(s)
    }
    return by
  }, [items])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" /> loading strategies…
      </div>
    )
  }
  if (err) return <div className="text-rose-300">failed to load strategies: {err}</div>

  return (
    <div className={p.compact ? "flex flex-col gap-2" : "grid grid-cols-1 gap-2 sm:grid-cols-2"}>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          scd2.strategyId <span className="text-rose-400">*</span>
        </span>
        <select
          value={p.strategyId}
          onChange={(e) => {
            p.onStrategyId(e.target.value)
            // Reset version to "latest" when switching strategy id.
            p.onStrategyVersion("latest")
          }}
          className="input font-mono"
        >
          {!chosen && p.strategyId && (
            <option value={p.strategyId}>{p.strategyId} (unresolved)</option>
          )}
          {Object.entries(groups).map(([kind, list]) => (
            <optgroup key={kind} label={labelFor(kind)}>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName} — {s.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {chosen && (
          <span className="text-[10px] text-text-faint">{chosen.description}</span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          scd2.strategyVersion
        </span>
        <select
          value={String(p.strategyVersion)}
          onChange={(e) => {
            const v = e.target.value
            p.onStrategyVersion(v === "latest" ? "latest" : Number(v))
          }}
          className="input font-mono"
        >
          <option value="latest">latest (current pointer)</option>
          {chosen && (
            <option value={String(chosen.version)}>v{chosen.version} (pinned)</option>
          )}
        </select>
      </label>
    </div>
  )
}

function labelFor(kind: string): string {
  switch (kind) {
    case "bundled":  return "Bundled"
    case "tenant":   return "Tenant custom"
    case "imported": return "Imported"
    case "agent":    return "Agent-authored"
    case "manual":   return "Manual"
    default:         return kind
  }
}

/**
 * StrategySelect — dropdown of SCD2 strategies + version picker.
 *
 * Pulls from `GET /api/entity-registry/strategies` (bundled ⊕ tenant
 * custom). Each option shows the displayName and keeps provenance visible
 * as a hint inside the shared listbox.
 *
 * Version dropdown is a separate picker whose options are
 * `"latest"` plus every concrete version we've seen for the chosen
 * strategy id. Pinning to a number freezes against historical schema
 * evolution; `"latest"` tracks the current pointer.
 */

import { Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
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
      .finally(() => { if (!cancelled) setLoading(false) }).catch((err: unknown) => { console.error("[mia]", err) })
    return () => { cancelled = true }
  }, [])

  const chosen = useMemo(() => items.find((s) => s.id === p.strategyId), [items, p.strategyId])

  const groups = useMemo(() => {
    const by: Record<string, EntityRegistryStrategy[]> = {}
    for (const s of items) {
      const kind = s.provenance.kind
      ;(by[kind] ??= []).push(s)
    }
    return by
  }, [items])

  const strategyOptions = useMemo<ListboxOption<string>[]>(() => {
    const options: ListboxOption<string>[] = []
    if (!chosen && p.strategyId) {
      options.push({ value: p.strategyId, label: `${p.strategyId} (unresolved)`, hint: "Current" })
    }
    for (const [kind, list] of Object.entries(groups)) {
      for (const strategy of list) {
        options.push({
          value: strategy.id,
          label: `${strategy.displayName} — ${strategy.id}`,
          hint: labelFor(kind),
        })
      }
    }
    return options
  }, [chosen, groups, p.strategyId])

  const versionOptions = useMemo<ListboxOption<string>[]>(() => {
    const options: ListboxOption<string>[] = [
      { value: "latest", label: "latest (current pointer)" },
    ]
    if (chosen) {
      options.push({ value: String(chosen.version), label: `v${chosen.version} (pinned)` })
    }
    return options
  }, [chosen])

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
        <span className="text-xs uppercase tracking-wider text-text-muted">
          scd2.strategyId <span className="text-rose-400">*</span>
        </span>
        <Listbox
          value={p.strategyId}
          options={strategyOptions}
          onChange={(value) => {
            p.onStrategyId(value)
            p.onStrategyVersion("latest")
          }}
          className="w-full font-mono"
          ariaLabel="SCD2 strategy"
        />
        {chosen && (
          <span className="text-xs text-text-faint">{chosen.description}</span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-text-muted">
          scd2.strategyVersion
        </span>
        <Listbox
          value={String(p.strategyVersion)}
          options={versionOptions}
          onChange={(value) => {
            p.onStrategyVersion(value === "latest" ? "latest" : Number(value))
          }}
          className="w-full font-mono"
          ariaLabel="SCD2 strategy version"
        />
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
    default:          return kind
  }
}

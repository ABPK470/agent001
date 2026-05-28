/**
 * SchedulesPanel — cron-driven proposer runs per (source → target) pair.
 *
 * Extracted from the legacy SyncAdmin into the Operations Console
 * shell. Same backend endpoints (`/api/sync/admin/schedules`); the
 * layout is rewritten on top of the shared `PanelChrome` so it
 * matches every other panel in the console.
 */

import { Plus, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { api } from "../../api"
import { useContainerSize } from "../../hooks/useContainerSize"
import { useMe } from "../../hooks/useMe"
import { timeAgo } from "../../util"
import { HelpBanner, PanelChrome } from "./shared"

interface Schedule {
  tenant_id:   string
  source:      string
  target:      string
  cron:        string
  enabled:     number
  next_run_at: string | null
  last_run_at: string | null
}

const DEFAULT_DRAFT = { source: "", target: "", cron: "0 */6 * * *", enabled: true }

export function SchedulesPanel(): JSX.Element {
  const layoutRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(layoutRef)
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Schedule[]>([])
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState<string | null>(null)
  const [ok,    setOk]    = useState<string | null>(null)
  const [draft, setDraft] = useState(DEFAULT_DRAFT)
  const compactForm = width > 0 && width < 860

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try { setItems((await api.listProposerSchedules()) as unknown as Schedule[]) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save(): Promise<void> {
    if (!draft.source.trim() || !draft.target.trim()) { setErr("source and target are required"); return }
    try {
      await api.upsertProposerSchedule(draft)
      setOk("schedule saved"); setTimeout(() => setOk(null), 1500)
      setDraft(DEFAULT_DRAFT)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function remove(s: Schedule): Promise<void> {
    if (!confirm(`Delete schedule ${s.source} → ${s.target}?`)) return
    try { await api.deleteProposerSchedule(s.tenant_id, s.source, s.target); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <PanelChrome
      title="Schedules"
      subtitle="Recurring proposer runs that build reconciliation proposals for review."
      busy={busy} onRefresh={refresh} err={err} ok={ok} onClearErr={() => setErr(null)}
    >
      <div ref={layoutRef} className="min-w-0">
        <HelpBanner>
          A schedule fires on its <code className="font-mono">cron</code> (5-field, UTC) and runs the proposer for a
          specific <em>source → target</em> pair. The output is a reviewable proposal — nothing is promoted automatically.
        </HelpBanner>

        {isAdmin && (
          <div className="mx-5 mt-4 rounded-lg border border-border-subtle bg-panel p-3">
            <div className={compactForm ? "grid grid-cols-1 gap-2 text-xs sm:grid-cols-2" : "grid grid-cols-[1fr_1fr_1.6fr_auto_auto] items-center gap-2 text-xs"}>
              <input className="input min-w-0" placeholder="source env" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
              <input className="input min-w-0" placeholder="target env" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
              <input className={`input min-w-0 font-mono ${compactForm ? "sm:col-span-2" : ""}`} placeholder="0 */6 * * *  (every 6h)" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} />
              <label className="flex min-h-10 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[11px] text-text-muted">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                enabled
              </label>
              <button onClick={() => void save()} className={`flex min-h-10 items-center justify-center gap-1 rounded bg-accent px-3 py-1.5 text-[11px] text-text-on-accent hover:bg-accent-hover ${compactForm ? "sm:justify-self-start" : ""}`}>
                <Plus className="h-3 w-3" /> add / update
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto px-5 py-4">
          <table className="min-w-[700px] w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted">
                <th className="px-2 py-1.5">source</th><th>target</th><th>cron</th><th>enabled</th><th>next run</th><th>last run</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-6 text-center text-text-faint">No schedules configured.</td></tr>
              )}
              {items.map((s) => (
                <tr key={`${s.tenant_id}|${s.source}|${s.target}`} className="border-t border-border-subtle">
                  <td className="px-2 py-1.5 font-mono">{s.source}</td>
                  <td className="font-mono">{s.target}</td>
                  <td className="font-mono text-[11px]">{s.cron}</td>
                  <td>{s.enabled ? "✓" : "—"}</td>
                  <td className="text-text-muted" title={s.next_run_at ?? ""}>{s.next_run_at ? timeAgo(s.next_run_at) : "—"}</td>
                  <td className="text-text-muted" title={s.last_run_at ?? ""}>{s.last_run_at ? timeAgo(s.last_run_at) : "—"}</td>
                  <td>{isAdmin && (
                    <button onClick={() => void remove(s)} className="text-rose-300 hover:text-rose-200">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </PanelChrome>
  )
}

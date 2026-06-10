/**
 * RoutesPanel — notification routes per event type and channel.
 *
 * Drives where sync events (approvals, run completions, failures) get
 * delivered: email, Teams, or Slack. Filters scope which events match.
 */

import { Hash, Mail, MessageSquare, Plus, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { useContainerSize } from "../../hooks/useContainerSize"
import { useMe } from "../../hooks/useMe"
import { timeAgo } from "../../util"
import { HelpBanner, PanelChrome } from "./shared"

type Channel = "email" | "teams" | "slack"

interface Route {
  id:          string
  tenant_id:   string
  event_type:  string
  filter_json: string
  channel:     Channel
  target:      string
  enabled:     boolean
  updated_at:  string
  updated_by:  string
}

function normalizeRoute(row: Record<string, unknown>): Route {
  const filter = row["filter"]
  const filterJson = typeof row["filter_json"] === "string"
    ? row["filter_json"]
    : JSON.stringify(filter && typeof filter === "object" ? filter : {})
  return {
    id: String(row["id"] ?? ""),
    tenant_id: String(row["tenant_id"] ?? row["tenantId"] ?? ""),
    event_type: String(row["event_type"] ?? row["eventType"] ?? ""),
    filter_json: filterJson,
    channel: String(row["channel"] ?? "email") as Channel,
    target: String(row["target"] ?? ""),
    enabled: row["enabled"] === true || row["enabled"] === 1,
    updated_at: String(row["updated_at"] ?? row["updatedAt"] ?? ""),
    updated_by: String(row["updated_by"] ?? row["updatedBy"] ?? ""),
  }
}

interface Draft { eventType: string; channel: Channel; target: string; filter: string; enabled: boolean }

const DEFAULT_DRAFT: Draft = {
  eventType: "sync.approval.requested",
  channel:   "email",
  target:    "",
  filter:    "{}",
  enabled:   true,
}

const CHANNEL_OPTIONS: ListboxOption<Channel>[] = [
  { value: "email", label: "email" },
  { value: "teams", label: "teams" },
  { value: "slack", label: "slack" },
]

export function RoutesPanel(): JSX.Element {
  const layoutRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(layoutRef)
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Route[]>([])
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState<string | null>(null)
  const [ok,    setOk]    = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)
  const compactForm = width > 0 && width < 980

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const rows = await api.listNotificationRoutes()
      setItems((rows as Array<Record<string, unknown>>).map(normalizeRoute))
    }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save(): Promise<void> {
    if (!draft.target.trim()) { setErr("target is required"); return }
    try {
      const filter = JSON.parse(draft.filter) as Record<string, unknown>
      await api.upsertNotificationRoute({
        eventType: draft.eventType, channel: draft.channel,
        target:    draft.target,    filter,
        enabled:   draft.enabled,
      })
      setOk("route saved"); setTimeout(() => setOk(null), 1500)
      setDraft({ ...DEFAULT_DRAFT })
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function remove(r: Route): Promise<void> {
    if (!confirm(`Delete route for ${r.event_type} → ${r.channel}?`)) return
    try { await api.deleteNotificationRoute(r.id); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <PanelChrome
      title="Notification routes"
      subtitle="Where sync events get delivered — by event type and channel."
      busy={busy} onRefresh={refresh} err={err} ok={ok} onClearErr={() => setErr(null)}
    >
      <div ref={layoutRef} className="min-w-0">
        <HelpBanner>
          Each route says: <em>"when this event happens and matches this filter, post to this target via this channel."</em>{" "}
          Use filters to scope to a single risk tier, environment, or entity.
        </HelpBanner>

        {isAdmin && (
          <div className="mx-5 mt-4 rounded-lg border border-border-subtle bg-panel p-3">
            <div className={compactForm ? "grid grid-cols-1 gap-2 text-xs sm:grid-cols-2" : "grid grid-cols-[1.4fr_110px_1.6fr_1.4fr_auto_auto] items-center gap-2 text-xs"}>
              <input className="input min-w-0 font-mono" placeholder="event type (e.g. sync.approval.requested)" value={draft.eventType} onChange={(e) => setDraft({ ...draft, eventType: e.target.value })} />
              <Listbox value={draft.channel} options={CHANNEL_OPTIONS} onChange={(channel) => setDraft({ ...draft, channel })} className="min-w-0 w-full" ariaLabel="Route channel" />
              <input className={`input min-w-0 ${compactForm ? "sm:col-span-2" : ""}`} placeholder="email address or webhook URL" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
              <input className={`input min-w-0 font-mono ${compactForm ? "sm:col-span-2" : ""}`} placeholder='{"riskTier":["high"]}' value={draft.filter} onChange={(e) => setDraft({ ...draft, filter: e.target.value })} />
              <label className="flex min-h-10 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[11px] text-text-muted">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                enabled
              </label>
              <button onClick={() => void save()} className={`flex min-h-10 items-center justify-center gap-1 rounded bg-accent px-3 py-1.5 text-[11px] text-text-on-accent hover:bg-accent-hover ${compactForm ? "sm:justify-self-start" : ""}`}>
                <Plus className="h-3 w-3" /> add route
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto px-5 py-4">
          <table className="min-w-[860px] w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted">
                <th className="px-2 py-1.5">event</th><th>channel</th><th>target</th><th>filter</th><th>enabled</th><th>updated</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-6 text-center text-text-faint">No routes configured.</td></tr>
              )}
              {items.map((r) => (
                <tr key={r.id} className="border-t border-border-subtle">
                  <td className="px-2 py-1.5 font-mono">{r.event_type}</td>
                  <td><ChannelBadge channel={r.channel} /></td>
                  <td className="max-w-[220px] truncate" title={r.target}>{r.target}</td>
                  <td className="max-w-[200px] truncate font-mono text-[11px]" title={r.filter_json}>{r.filter_json}</td>
                  <td>{r.enabled ? "✓" : "—"}</td>
                  <td className="text-text-muted" title={r.updated_at}>{timeAgo(r.updated_at)}</td>
                  <td>{isAdmin && (
                    <button onClick={() => void remove(r)} className="text-error hover:opacity-75">
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

function ChannelBadge({ channel }: { channel: Channel }): JSX.Element {
  const Icon = channel === "email" ? Mail : channel === "teams" ? MessageSquare : Hash
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border-subtle bg-overlay-2 px-1.5 py-0.5 text-[10px]">
      <Icon className="h-3 w-3" /> {channel}
    </span>
  )
}

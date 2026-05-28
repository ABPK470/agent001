/**
 * OverviewPanel — at-a-glance dashboard for the Sync Operations Console.
 *
 * Pulls counts from every registry the console manages and renders a
 * recent activity feed sourced from the in-process SSE event log.
 * Cards double as quick-jump links into the matching detail panel.
 */

import { EventType } from "@mia/shared-enums"
import {
    Activity, Calendar, ChevronRight, Clock, Database, GitBranch, Mail, Shield, ShieldCheck,
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { api } from "../../api"
import { useStore } from "../../store"
import type { SseEvent } from "../../types"
import { timeAgo } from "../../util"
import type { Section } from "./SyncAdminShell"
import { Empty, HelpBanner, PanelChrome } from "./shared"

interface Counts {
  envs:      number
  runs:      number
  strategies:number
  freezes:   { active: number; scheduled: number; past: number }
  schedules: { enabled: number; disabled: number }
  policies:  number
  routes:    { enabled: number; disabled: number }
}

const EMPTY: Counts = { envs: 0, runs: 0, strategies: 0, freezes: { active: 0, scheduled: 0, past: 0 }, schedules: { enabled: 0, disabled: 0 }, policies: 0, routes: { enabled: 0, disabled: 0 } }

export function OverviewPanel({ onJump }: { onJump: (s: Section) => void }): JSX.Element {
  const [counts, setCounts] = useState<Counts>(EMPTY)
  const [busy,   setBusy]   = useState(true)
  const [err,    setErr]    = useState<string | null>(null)

  const loadingRef = useRef(false)
  const queuedRef = useRef(false)
  const lastLiveTickRef = useRef<number | null>(null)

  const log = useStore((s) => s.sseEventLog)
  const liveRefreshTick = useStore((s) =>
    s.sseEventLog.filter((e) => isOverviewRefreshEvent(e.type)).length,
  )

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (lastLiveTickRef.current === null) {
      lastLiveTickRef.current = liveRefreshTick
      return
    }
    if (liveRefreshTick === lastLiveTickRef.current) return
    lastLiveTickRef.current = liveRefreshTick
    void load()
  }, [liveRefreshTick])

  async function load(): Promise<void> {
    if (loadingRef.current) {
      queuedRef.current = true
      return
    }
    loadingRef.current = true
    setBusy(true); setErr(null)
    try {
      const [envs, runs, strats, frz, sched, pols, rts] = await Promise.all([
        api.syncEnvironments(),
        api.syncRuns(100),
        api.listEntityRegistryStrategies(),
        api.listFreezeWindows(),
        api.listProposerSchedules(),
        api.listApprovalPolicies(),
        api.listNotificationRoutes(),
      ])
      const now = Date.now()
      const freezes = { active: 0, scheduled: 0, past: 0 }
      for (const w of frz.items) {
        const s = Date.parse(w.startsAt), e = Date.parse(w.endsAt)
        if      (now < s) freezes.scheduled++
        else if (now > e) freezes.past++
        else              freezes.active++
      }
      const schedules = { enabled: 0, disabled: 0 }
      for (const s of sched as unknown as Array<{ enabled: number }>) (s.enabled ? schedules.enabled++ : schedules.disabled++)
      const routes = { enabled: 0, disabled: 0 }
      for (const r of rts as unknown as Array<{ enabled: number }>) (r.enabled ? routes.enabled++ : routes.disabled++)
      setCounts({
        envs:       envs.length,
        runs:       runs.length,
        strategies: strats.items.length,
        freezes, schedules, routes,
        policies:   (pols as unknown[]).length,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally {
      setBusy(false)
      loadingRef.current = false
      if (queuedRef.current) {
        queuedRef.current = false
        void load()
      }
    }
  }

  const activity = log
    .filter((e) => typeof e.type === "string" && (e.type.startsWith("entity_registry.") || e.type.startsWith("sync.") || e.type.startsWith("sync_env.") || e.type.startsWith("freeze_window.")))
    .slice(-20).reverse()

  return (
    <PanelChrome title="Sync Operations Console"
      subtitle="One place to see every piece of the sync platform — environments, schedules, approvals, freeze windows and routing — and what's happening right now."
      busy={busy} err={err} onClearErr={() => setErr(null)}
    >
      <HelpBanner>
        Click any card to jump straight into the matching panel. The activity feed below shows live events
        from the sync event bus.
      </HelpBanner>

      <div className="grid grid-cols-2 gap-3 px-5 py-4 md:grid-cols-3">
        <Card icon={Database}    title="Environments"        primary={counts.envs}                      secondary="DEV · UAT · PROD + custom" onClick={() => onJump("environments")} />
        <Card icon={Clock}       title="Runs"                primary={counts.runs}                      secondary="latest compiled plans" onClick={() => onJump("runs")} />
        <Card icon={Clock}       title="Schedules"           primary={counts.schedules.enabled}          secondary={`${counts.schedules.disabled} disabled`} onClick={() => onJump("schedules")} />
        <Card icon={ShieldCheck} title="Approval policies"   primary={counts.policies}                   secondary="per risk tier" onClick={() => onJump("policies")} />
        <Card icon={Mail}        title="Notification routes" primary={counts.routes.enabled}             secondary={`${counts.routes.disabled} disabled`} onClick={() => onJump("routes")} />
        <Card icon={GitBranch}   title="SCD2 strategies"     primary={counts.strategies}                 secondary="bundled + custom" onClick={() => onJump("strategies")} />
        <Card icon={Calendar}    title="Freeze windows"      primary={counts.freezes.active + counts.freezes.scheduled}
              secondary={`${counts.freezes.active} active · ${counts.freezes.scheduled} upcoming · ${counts.freezes.past} past`}
              accent={counts.freezes.active > 0 ? "rose" : undefined}
              onClick={() => onJump("freezes")} />
      </div>

      <section className="px-5 pb-6">
        <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <Activity className="h-3 w-3" /> recent activity
        </h3>
        {activity.length === 0 ? (
          <Empty title="No recent sync activity">Events will appear here as they happen.</Empty>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-panel">
            {activity.map((e, i) => <EventRow key={i} e={e} />)}
          </ul>
        )}
      </section>
    </PanelChrome>
  )
}

function isOverviewRefreshEvent(type: string): boolean {
  return type === EventType.RunQueued
    || type === EventType.RunStarted
    || type === EventType.RunCompleted
    || type === EventType.RunFailed
    || type === EventType.RunCancelled
    || type === EventType.SyncEnvUpdate
    || type === EventType.SyncEnvReset
    || type === EventType.EntityRegistryStrategySaved
    || type === EventType.FreezeWindowUpserted
    || type === EventType.FreezeWindowDeleted
    || type === EventType.SyncProposerScheduleSaved
    || type === EventType.SyncProposerScheduleDeleted
    || type === EventType.SyncPolicySaved
    || type === EventType.SyncPolicyDeleted
    || type === EventType.SyncNotificationRouteSaved
    || type === EventType.SyncNotificationRouteDeleted
}

function Card({ icon: Icon, title, primary, secondary, onClick, accent }: {
  icon: typeof Database; title: string; primary: number; secondary: string; onClick: () => void
  accent?: "rose"
}): JSX.Element {
  const accentCls = accent === "rose" ? "border-rose-500/40" : "border-border-subtle hover:border-accent"
  return (
    <button onClick={onClick}
      className={`group flex flex-col items-start gap-1 rounded-xl border bg-panel p-4 text-left transition hover:bg-overlay-2 ${accentCls}`}>
      <div className="flex w-full items-center justify-between text-text-muted">
        <Icon className="h-4 w-4" />
        <ChevronRight className="h-3 w-3 opacity-0 transition group-hover:opacity-100" />
      </div>
      <div className="text-2xl font-semibold text-text">{primary}</div>
      <div className="text-xs font-medium text-text">{title}</div>
      <div className="text-[11px] text-text-faint">{secondary}</div>
    </button>
  )
}

function EventRow({ e }: { e: SseEvent }): JSX.Element {
  const Icon = e.type.startsWith("freeze_window.")    ? Calendar
            : e.type.startsWith("sync_env.")          ? Database
            : e.type.startsWith("entity_registry.")   ? GitBranch
            : e.type.startsWith("sync.approval.")     ? Shield
            :                                            Activity
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-xs">
      <Icon className="h-3 w-3 shrink-0 text-text-muted" />
      <span className="flex-1 truncate font-mono">{e.type}</span>
      <span className="shrink-0 text-text-faint" title={e.timestamp}>{timeAgo(e.timestamp)}</span>
    </li>
  )
}

/**
 * Overview — status cards + live activity feed.
 */

import { EventType } from "@mia/shared-enums"
import {
  Activity, ChevronRight, Clock, Database, GitCompareArrows, Mail, Shield,
} from "lucide-react"
import type { ComponentType, JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { useStore } from "../../state/store"
import type { SseEvent } from "../../types"
import { timeAgo } from "../../lib/util"
import type { Section } from "./SyncAdminShell"
import { PANEL, TOOLBAR_ROW } from "./design"
import { ConsolePanel, PanelBody, PanelToolbar } from "./shared"

interface Snapshot {
  connectionNames: string[]
  openProposals: number
  pendingApprovals: number
  recentRuns: number
  lastRunLabel: string | null
  schedules: { enabled: number; disabled: number }
  routes: { enabled: number; disabled: number }
}

const EMPTY: Snapshot = {
  connectionNames: [],
  openProposals: 0,
  pendingApprovals: 0,
  recentRuns: 0,
  lastRunLabel: null,
  schedules: { enabled: 0, disabled: 0 },
  routes: { enabled: 0, disabled: 0 },
}

export function OverviewPanel({ onJump }: { onJump: (s: Section) => void }): JSX.Element {
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const loadingRef = useRef(false)
  const queuedRef = useRef(false)
  const lastLiveTickRef = useRef<number | null>(null)

  const log = useStore((s) => s.sseEventLog)
  const liveTick = useStore((s) =>
    s.sseEventLog.filter((e) => isOverviewRefreshEvent(String(e.type))).length,
  )

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (lastLiveTickRef.current === null) {
      lastLiveTickRef.current = liveTick
      return
    }
    if (liveTick === lastLiveTickRef.current) return
    lastLiveTickRef.current = liveTick
    void load()
  }, [liveTick])

  async function load(): Promise<void> {
    if (loadingRef.current) {
      queuedRef.current = true
      return
    }
    loadingRef.current = true
    setBusy(true)
    setErr(null)
    try {
      const results = await Promise.allSettled([
        api.listSyncEnvironments(),
        api.listProposals({ status: "open,awaiting_approval,previewed,snoozed" }),
        api.listApprovals({ state: "pending" }),
        api.listApprovals({ state: "partially_granted" }),
        api.syncRuns(20),
        api.listProposerSchedules(),
        api.listNotificationRoutes(),
      ])

      const envs = results[0].status === "fulfilled" ? results[0].value : []
      const proposals = results[1].status === "fulfilled" ? (results[1].value as unknown[]) : []
      const pending1 = results[2].status === "fulfilled" ? (results[2].value as unknown[]) : []
      const pending2 = results[3].status === "fulfilled" ? (results[3].value as unknown[]) : []
      const runs = results[4].status === "fulfilled" ? (results[4].value as Array<{ entityDisplayName?: string | null; entityType?: string; entityId?: string; finishedAt?: string | null; startedAt?: string }>) : []
      const sched = results[5].status === "fulfilled" ? results[5].value : []
      const rts = results[6].status === "fulfilled" ? results[6].value : []

      const schedules = { enabled: 0, disabled: 0 }
      for (const s of sched as Array<{ enabled?: boolean | number }>) {
        const on = s.enabled === true || s.enabled === 1
        if (on) schedules.enabled++
        else schedules.disabled++
      }

      const routes = { enabled: 0, disabled: 0 }
      for (const r of rts as Array<{ enabled?: boolean | number }>) {
        const on = r.enabled === true || r.enabled === 1
        if (on) routes.enabled++
        else routes.disabled++
      }

      const lastRun = runs[0]
      const lastRunLabel = lastRun
        ? `${lastRun.entityDisplayName ?? `${lastRun.entityType ?? "?"}#${lastRun.entityId ?? "?"}`} · ${timeAgo(lastRun.finishedAt ?? lastRun.startedAt ?? "")}`
        : null

      setSnap({
        connectionNames: envs.map((e) => e.name).sort(),
        openProposals: proposals.length,
        pendingApprovals: pending1.length + pending2.length,
        recentRuns: runs.length,
        lastRunLabel,
        schedules,
        routes,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      loadingRef.current = false
      if (queuedRef.current) {
        queuedRef.current = false
        void load()
      }
    }
  }

  const activity = log
    .filter((e) => typeof e.type === "string" && (
      e.type.startsWith("sync.") || e.type.startsWith("sync_env.") || e.type.startsWith("freeze_window.")
    ))
    .slice(-16)
    .reverse()

  const connSubtitle = snap.connectionNames.length > 0
    ? snap.connectionNames.join(" · ")
    : "None configured"

  return (
    <ConsolePanel err={err} onClearErr={() => setErr(null)}>
      <PanelToolbar busy={busy}>
        <span className="text-sm font-medium text-text">Overview</span>
      </PanelToolbar>
      <PanelBody>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <StatusCard
            icon={Database}
            title="Connections"
            value={snap.connectionNames.length}
            subtitle={connSubtitle}
          />
          <StatusCard
            icon={GitCompareArrows}
            title="Open proposals"
            value={snap.openProposals}
            subtitle={snap.openProposals > 0 ? "Awaiting triage" : "Queue clear"}
            accent={snap.openProposals > 0 ? "info" : undefined}
            onClick={() => onJump("proposals")}
          />
          <StatusCard
            icon={Shield}
            title="Pending approvals"
            value={snap.pendingApprovals}
            subtitle={snap.pendingApprovals > 0 ? "Needs grant or reject" : "None open"}
            accent={snap.pendingApprovals > 0 ? "warning" : undefined}
            onClick={() => onJump("approvals")}
          />
          <StatusCard
            icon={Clock}
            title="Recent runs"
            value={snap.recentRuns}
            subtitle={snap.lastRunLabel ?? "No persisted runs"}
            onClick={() => onJump("runs")}
          />
          <StatusCard
            icon={Clock}
            title="Proposer schedules"
            value={snap.schedules.enabled}
            subtitle={`${snap.schedules.disabled} disabled`}
            onClick={() => onJump("schedules")}
          />
          <StatusCard
            icon={Mail}
            title="Notification routes"
            value={snap.routes.enabled}
            subtitle={`${snap.routes.disabled} disabled`}
            onClick={() => onJump("routes")}
          />
        </div>

        <div className={`${PANEL} mt-4 overflow-hidden`}>
          <div className={`${TOOLBAR_ROW} border-b border-border-subtle`}>
            <span className="text-sm font-medium text-text">Recent activity</span>
          </div>
          {activity.length === 0 ? (
            <EmptyState icon={Activity} message="No sync events yet" className="min-h-[10rem] py-8" />
          ) : (
            <ul>
              {activity.map((e, i) => (
                <EventRow key={`${e.type}-${e.timestamp}-${i}`} e={e} />
              ))}
            </ul>
          )}
        </div>
      </PanelBody>
    </ConsolePanel>
  )
}

function StatusCard({
  icon: Icon,
  title,
  value,
  subtitle,
  onClick,
  accent,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  value: number
  subtitle: string
  onClick?: () => void
  accent?: "info" | "warning" | "danger"
}): JSX.Element {
  const border =
    accent === "danger" ? "border-error/30 hover:border-error/50"
    : accent === "warning" ? "border-warning/30 hover:border-warning/50"
    : accent === "info" ? "border-info/30 hover:border-info/50"
    : "border-border-subtle hover:border-accent/40"

  const className = `group flex flex-col items-start gap-1 rounded-lg border bg-elevated/20 p-4 text-left transition hover:bg-elevated/50 ${border}`

  if (!onClick) {
    return (
      <div className={className}>
        <div className="flex w-full items-center justify-between text-text-muted">
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-2xl font-semibold tabular-nums text-text">{value}</div>
        <div className="text-xs font-medium text-text">{title}</div>
        <div className="line-clamp-2 text-sm text-text-muted">{subtitle}</div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
    >
      <div className="flex w-full items-center justify-between text-text-muted">
        <Icon className="h-4 w-4" />
        <ChevronRight className="h-3.5 w-3.5 opacity-0 transition group-hover:opacity-100" />
      </div>
      <div className="text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="text-xs font-medium text-text">{title}</div>
      <div className="line-clamp-2 text-sm text-text-muted">{subtitle}</div>
    </button>
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
    || type.startsWith("sync.proposal")
    || type.startsWith("sync.approval")
    || type.startsWith("entity_registry.")
    || type === EventType.FreezeWindowUpserted
    || type === EventType.FreezeWindowDeleted
    || type === EventType.SyncProposerScheduleSaved
    || type === EventType.SyncProposerScheduleDeleted
    || type === EventType.SyncNotificationRouteSaved
    || type === EventType.SyncNotificationRouteDeleted
}

function EventRow({ e }: { e: SseEvent }): JSX.Element {
  const Icon =
    e.type.startsWith("sync_env.") ? Database
    : e.type.startsWith("sync.proposal") ? GitCompareArrows
    : e.type.startsWith("sync.approval") ? Shield
    : Activity

  return (
    <li className="flex items-center gap-2 border-t border-border-subtle px-3 py-2 text-sm first:border-t-0">
      <Icon size={12} className="shrink-0 text-text-faint" />
      <span className="min-w-0 flex-1 truncate font-mono">{e.type}</span>
      <span className="shrink-0 text-text-faint">{timeAgo(e.timestamp)}</span>
    </li>
  )
}

import { EventType } from "@mia/shared-enums"
import { RefreshCw } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { api } from "../../client/index"
import type { SyncPlan } from "../../types"
import { timeAgo } from "../../lib/util"
import { EvidencePanel } from "./EvidencePanel"
import { useConsole } from "./console-context"
import { TAB_PILL, TAB_PILL_ACTIVE, TAB_PILL_IDLE, PANEL } from "./design"
import { readExecutionContractSteps } from "./plan-contract"
import { DecisionLogModal, GovernanceDetailModal, PlanDetailModal } from "./RunDetailModals"
import {
  ConsolePanel, DetailBody, DetailToolbar, Empty, ItemShell, PanelToolbar, RailEmpty,
  TOOLBAR_ICON, ToolbarIconBtn, RailList, RailListItem, SectionRow,
} from "./shared"
import { DetailField, DetailGrid } from "../entity-registry/DetailField"
import { useLiveReload } from "./useLiveReload"

type RunsTab = "runs" | "evidence"

interface SyncRunRow {
  planId: string
  entityType: string
  entityId: string
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  status: "started" | "preview" | "success" | "failed" | "skipped" | "cancelled"
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

const TABS: { label: string; value: RunsTab }[] = [
  { label: "Runs", value: "runs" },
  { label: "Evidence", value: "evidence" },
]

export function RunsPanel({ initialTab = "runs" }: { initialTab?: RunsTab }): JSX.Element {
  const { notifyError } = useConsole()
  const [tab, setTab] = useState<RunsTab>(initialTab)
  const [items, setItems] = useState<SyncRunRow[]>([])
  const [busy, setBusy] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planErr, setPlanErr] = useState<string | null>(null)

  const loadRuns = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.syncRuns(100)
      const rows = Array.isArray(next) ? next : []
      setItems(rows)
      setSelected((current) => current && rows.some((row) => row.planId === current) ? current : (rows[0]?.planId ?? null))
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [notifyError])

  useLiveReload(loadRuns, (type) =>
    type === EventType.RunQueued
    || type === EventType.RunStarted
    || type === EventType.RunCompleted
    || type === EventType.RunFailed
    || type === EventType.RunCancelled,
  )

  useEffect(() => { void loadRuns() }, [loadRuns])

  useEffect(() => {
    if (!selected) {
      setPlan(null)
      setPlanErr(null)
      return
    }
    let cancelled = false
    setPlanBusy(true)
    setPlanErr(null)
    api.syncPlan(selected)
      .then((next) => {
        if (cancelled) return
        if (next.error) {
          setPlan(null)
          setPlanErr(next.error)
          return
        }
        setPlan(next)
      })
      .catch((error) => {
        if (cancelled) return
        setPlan(null)
        setPlanErr(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setPlanBusy(false)
      })
    return () => { cancelled = true }
  }, [selected])

  const chosen = useMemo(() => items.find((item) => item.planId === selected) ?? null, [items, selected])

  const tabsToolbar = (
    <RunsTabsToolbar tab={tab} busy={busy} onTab={setTab} />
  )

  if (tab === "evidence") {
    return (
      <ConsolePanel>
        <EvidencePanel tabsToolbar={tabsToolbar} />
      </ConsolePanel>
    )
  }

  return (
    <ConsolePanel>
      <ItemShell
        busy={busy}
        listActions={(
          <ToolbarIconBtn label="Refresh runs" onClick={() => void loadRuns()}>
            <RefreshCw {...TOOLBAR_ICON} />
          </ToolbarIconBtn>
        )}
        detailToolbar={(
          <>
            {tabsToolbar}
            {chosen ? (
              <DetailToolbar
                title={chosen.entityDisplayName ?? `${chosen.entityType}#${chosen.entityId}`}
                subtitle={chosen.planId}
              />
            ) : null}
          </>
        )}
        empty={items.length === 0 ? <RailEmpty title="No runs yet" /> : undefined}
        list={(
          <RailList label="Runs">
            {items.map((item) => (
              <RailListItem
                key={item.planId}
                active={item.planId === selected}
                onClick={() => setSelected(item.planId)}
                title={item.entityDisplayName ?? `${item.entityType}#${item.entityId}`}
                meta={`${item.source} → ${item.target} · ${item.status}`}
                meta2={`${timeAgo(item.finishedAt ?? item.startedAt)} · ${item.actorUpn ?? "system"}`}
              />
            ))}
          </RailList>
        )}
        detail={chosen ? <RunDetail run={chosen} plan={plan} busy={planBusy} err={planErr} /> : (
          <Empty title={items.length === 0 ? "No runs yet" : "Select a run"} />
        )}
      />
    </ConsolePanel>
  )
}

function RunsTabsToolbar({
  tab,
  busy,
  onTab,
}: {
  tab: RunsTab
  busy?: boolean
  onTab: (tab: RunsTab) => void
}): JSX.Element {
  return (
    <PanelToolbar busy={busy}>
      <nav className="flex min-w-0 items-center gap-1" aria-label="Runs views">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => onTab(t.value)}
            className={[TAB_PILL, tab === t.value ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </PanelToolbar>
  )
}

function RunDetail({ run, plan, busy, err }: { run: SyncRunRow; plan: SyncPlan | null; busy: boolean; err: string | null }): JSX.Element {
  const [modal, setModal] = useState<"plan" | "governance" | "decisions" | null>(null)
  const decisionCount = plan?.decisionLog?.length ?? 0
  const stepCount = plan?.executionContract ? readExecutionContractSteps(plan.executionContract).length : 0

  return (
    <DetailBody>
      <DetailGrid>
        <DetailField label="Route" value={`${run.source} → ${run.target}`} mono />
        <DetailField label="Status" value={run.status} />
        <DetailField label="Actor" value={run.actorUpn ?? "system"} />
        <DetailField label="Started" value={formatDateTime(run.startedAt)} />
        <DetailField label="Finished" value={run.finishedAt ? formatDateTime(run.finishedAt) : "running"} />
        <DetailField label="Duration" value={run.durationMs == null ? "—" : `${Math.round(run.durationMs / 1000)}s`} />
        {run.error && <DetailField label="Error" value={run.error} span={2} />}
      </DetailGrid>

      {busy && <p className="mt-3 text-sm text-text-muted">Loading plan…</p>}
      {err && <p className="mt-3 text-sm text-warning">Plan unavailable: {err}</p>}

      {plan && (
        <ol className={`${PANEL} mt-4 overflow-hidden`}>
          {plan.executionContract && (
            <SectionRow
              title="Compiled plan"
              subtitle={plan.executionContract.definitionId}
              badge={String(stepCount)}
              onClick={() => setModal("plan")}
            />
          )}
          {plan.governanceDecision && (
            <SectionRow
              title="Governance"
              subtitle={plan.governanceDecision.targetEnvironment.role}
              onClick={() => setModal("governance")}
            />
          )}
          <SectionRow
            title="Decision log"
            badge={String(decisionCount)}
            onClick={() => setModal("decisions")}
          />
        </ol>
      )}

      {modal === "plan" && plan?.executionContract && (
        <PlanDetailModal plan={plan} onClose={() => setModal(null)} />
      )}
      {modal === "governance" && plan?.governanceDecision && (
        <GovernanceDetailModal plan={plan} onClose={() => setModal(null)} />
      )}
      {modal === "decisions" && plan && (
        <DecisionLogModal plan={plan} onClose={() => setModal(null)} />
      )}
    </DetailBody>
  )
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

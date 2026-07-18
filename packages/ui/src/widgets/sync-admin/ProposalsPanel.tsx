/**
 * ProposalsPanel — drift findings queue.
 */

import { EventType } from "@mia/shared-enums"
import { Clock, Loader2, Play, ShieldCheck, X } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../client/index"
import { LlmInteractionBanner } from "../../components/LlmInteractionBanner"
import { useLlmInteraction } from "../../hooks/useLlmInteraction"
import { useMe } from "../../hooks/useMe"
import type { SyncEnvironmentAdmin } from "../../types"
import { timeAgo } from "../../lib/util"
import { DetailField, DetailGrid } from "../entity-registry/DetailField"
import { DetailActionBtn, PromptModal } from "./chrome"
import { useConsole } from "./console-context"
import { approvalRequired, normalizeApprovalPolicyRow, resolveApprovalPolicy, type ApprovalPolicyRow } from "./approval-policy"
import { TAB_PILL, TAB_PILL_ACTIVE, TAB_PILL_IDLE } from "./design"
import { RunProposerModal } from "./RunProposerModal"
import {
  ActiveOperationBanner,
  ConsolePanel, DetailBody, DetailToolbar, Empty, ItemShell, PanelToolbar, RailEmpty,
  TOOLBAR_ICON, ToolbarIconBtn, RailList, RailListGroup, RailListItem,
} from "./shared"
import { useLiveReload } from "./useLiveReload"
import { useProposerScanState } from "./useProposerScanState"

const STATUS_TABS = [
  { label: "Active", value: "open,awaiting_approval,previewed,snoozed" },
  { label: "Closed", value: "dismissed,superseded,failed" },
] as const

interface Proposal {
  id: string
  source: string
  target: string
  entity_type: string
  entity_id: string | null
  status: string
  risk_tier: string | null
  rank_score: number | null
  finding_kind: string
  created_at: string
  counts: { insert: number; update: number; delete: number }
  annotation: { rationale?: string } | null
}

export function ProposalsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { notify, notifyError } = useConsole()

  const [items, setItems] = useState<Proposal[]>([])
  const [connections, setConnections] = useState<SyncEnvironmentAdmin[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]["value"]>(STATUS_TABS[0].value)
  const [listBusy, setListBusy] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [prompt, setPrompt] = useState<{ kind: "dismiss" | "snooze"; proposal: Proposal } | null>(null)
  const [promptBusy, setPromptBusy] = useState(false)
  const [approvalPolicies, setApprovalPolicies] = useState<ApprovalPolicyRow[]>([])

  const chosen = useMemo(() => items.find((p) => p.id === selected) ?? null, [items, selected])

  const directionGroups = useMemo(() => groupProposalsByDirection(items), [items])

  const refresh = useCallback(async (): Promise<void> => {
    setListBusy(true)
    try {
      const rows = await api.listProposals({ status: statusFilter })
      const typed = rows as unknown as Proposal[]
      setItems(typed)
      setSelected((c) => (c && typed.some((p) => p.id === c) ? c : (typed[0]?.id ?? null)))
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setListBusy(false)
    }
  }, [statusFilter, notifyError])

  const dismissLlmRef = useRef<() => void>(() => {})

  const {
    scanning,
    noteScanStarted,
    cancelScan,
    cancelBusy,
  } = useProposerScanState({
    onCompleted: (inserted) => {
      notify(inserted > 0 ? `Scan complete · ${inserted} new proposal${inserted === 1 ? "" : "s"}` : "Scan complete · no new drift")
      void refresh()
    },
    onFailed: (message) => notifyError(message),
    onCancelled: () => {
      dismissLlmRef.current()
    },
  })

  const llmInteractionFilter = useMemo(
    () => (scanning?.runId ? { operationKind: "proposer.run", operationId: scanning.runId } : undefined),
    [scanning?.runId],
  )
  const { interaction: llmInteraction, dismiss: dismissLlmInteraction } = useLlmInteraction(llmInteractionFilter)
  dismissLlmRef.current = dismissLlmInteraction

  const handleCancelScan = useCallback(async (): Promise<void> => {
    dismissLlmInteraction()
    const cancelled = await cancelScan()
    if (cancelled) notify("Scan cancelled")
  }, [cancelScan, dismissLlmInteraction, notify])

  useLiveReload(
    refresh,
    (t) =>
      t === EventType.SyncProposerRunCompleted
      || t === EventType.SyncProposerRunFailed
      || t === EventType.SyncProposerRunCancelled
      || t.startsWith("sync.proposal")
      || t.startsWith("sync.proposer"),
  )

  useEffect(() => {
    void api.listSyncEnvironments().then(setConnections).catch(() => setConnections([]))
  }, [])

  const refreshPolicies = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.listApprovalPolicies()
      setApprovalPolicies((rows as Array<Record<string, unknown>>).map(normalizeApprovalPolicyRow))
    } catch {
      setApprovalPolicies([])
    }
  }, [])

  useEffect(() => { void refreshPolicies() }, [refreshPolicies])

  useLiveReload(refreshPolicies, (t) =>
    t === EventType.SyncPolicySaved || t === EventType.SyncPolicyDeleted,
  )

  async function transition(p: Proposal, to: string, reason?: string): Promise<void> {
    try {
      await api.updateProposalStatus(p.id, { to, reason })
      notify(`→ ${to}`)
      await refresh()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }

  const scanBtn = isAdmin ? (
    <ToolbarIconBtn
      label={connections.length > 0 ? "Run scan" : "Run scan — add connections first"}
      onClick={() => setScanOpen(true)}
      disabled={connections.length === 0 || scanning != null}
    >
      {scanning ? <Loader2 {...TOOLBAR_ICON} className="animate-spin" /> : <Play {...TOOLBAR_ICON} />}
    </ToolbarIconBtn>
  ) : undefined

  return (
    <>
      <ConsolePanel>
        {scanning && (
          <ActiveOperationBanner
            label="Scanning "
            detail={<span className="font-mono"> {scanning.source} → {scanning.target}</span>}
            onCancel={isAdmin ? () => void handleCancelScan() : undefined}
            cancelBusy={cancelBusy}
          >
            {llmInteraction && (
              <LlmInteractionBanner interaction={llmInteraction} onDismiss={dismissLlmInteraction} />
            )}
          </ActiveOperationBanner>
        )}

        <ItemShell
          busy={listBusy}
          listActions={scanBtn}
          detailToolbar={(
            <>
              <PanelToolbar busy={listBusy}>
                <nav className="flex min-w-0 items-center gap-1" aria-label="Proposal status">
                  {STATUS_TABS.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setStatusFilter(t.value)}
                      className={[TAB_PILL, statusFilter === t.value ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
                    >
                      {t.label}
                    </button>
                  ))}
                </nav>
              </PanelToolbar>
              {chosen ? (
                <DetailToolbar
                  title={`${chosen.entity_type}${chosen.entity_id ? ` / ${chosen.entity_id}` : ""}`}
                  subtitle={`${chosen.source} → ${chosen.target}`}
                />
              ) : null}
            </>
          )}
          empty={items.length === 0 ? (
            <RailEmpty title="No proposals">
              {isAdmin ? "Run a scan to find drift." : "Nothing in this queue yet."}
            </RailEmpty>
          ) : undefined}
          list={(
            <RailList label="Proposals">
              {directionGroups.map((group) => (
                <RailListGroup
                  key={group.key}
                  label={`${group.source} → ${group.target}`}
                  count={group.items.length}
                >
                  {group.items.map((p) => (
                    <RailListItem
                      key={p.id}
                      active={p.id === selected}
                      onClick={() => setSelected(p.id)}
                      title={`${p.entity_type}${p.entity_id ? ` / ${p.entity_id}` : ""}`}
                      meta={`${p.risk_tier ?? "—"} · ${timeAgo(p.created_at)}`}
                    />
                  ))}
                </RailListGroup>
              ))}
            </RailList>
          )}
          detail={
            chosen ? (
              <ProposalDetail
                proposal={chosen}
                isAdmin={isAdmin}
                approvalPolicies={approvalPolicies}
                onTransition={transition}
                onRequestApproval={async (p) => {
                  try {
                    await api.createApproval({ proposalId: p.id })
                    notify("Sent to Approvals")
                    await refresh()
                  } catch (e) {
                    notifyError(e instanceof Error ? e.message : String(e))
                  }
                }}
                onDismiss={() => setPrompt({ kind: "dismiss", proposal: chosen })}
                onSnooze={() => setPrompt({ kind: "snooze", proposal: chosen })}
              />
            ) : (
              <Empty title={items.length === 0 ? "No proposals" : "Select a proposal"}>
                {items.length === 0 && isAdmin ? "Use Run scan (▶) to compare source and target connections." : undefined}
              </Empty>
            )
          }
        />
      </ConsolePanel>

      {scanOpen && (
        <RunProposerModal
          connections={connections}
          onClose={() => setScanOpen(false)}
          onStarted={noteScanStarted}
        />
      )}

      {prompt && (
        <PromptModal
          title={prompt.kind === "dismiss" ? "Dismiss" : "Snooze"}
          label="Reason"
          submitLabel={prompt.kind === "dismiss" ? "Dismiss" : "Snooze"}
          busy={promptBusy}
          onCancel={() => !promptBusy && setPrompt(null)}
          onSubmit={(reason) => {
            const { kind, proposal } = prompt
            setPromptBusy(true)
            void transition(proposal, kind === "dismiss" ? "dismissed" : "snoozed", reason)
              .finally(() => {
                setPromptBusy(false)
                setPrompt(null)
              })
          }}
        />
      )}
    </>
  )
}

function ProposalDetail({ proposal, isAdmin, approvalPolicies, onTransition, onRequestApproval, onDismiss, onSnooze }: {
  proposal: Proposal
  isAdmin: boolean
  approvalPolicies: ApprovalPolicyRow[]
  onTransition: (p: Proposal, to: string, reason?: string) => Promise<void>
  onRequestApproval: (p: Proposal) => Promise<void>
  onDismiss: () => void
  onSnooze: () => void
}): JSX.Element {
  const counts = proposal.counts ?? { insert: 0, update: 0, delete: 0 }
  const isPreviewed = proposal.status === "previewed"
  const isAwaitingApproval = proposal.status === "awaiting_approval"
  const policyKind = resolveApprovalPolicy(approvalPolicies, proposal.target, proposal.risk_tier)
  const needsApproval = approvalRequired(policyKind)

  return (
    <DetailBody>
      <DetailGrid>
        <DetailField label="Status" value={proposal.status.replaceAll("_", " ")} />
        <DetailField label="Risk" value={proposal.risk_tier ?? "—"} />
        <DetailField label="Finding" value={proposal.finding_kind || "—"} />
        <DetailField
          label="Counts"
          value={`+${counts.insert} ~${counts.update} -${counts.delete}`}
          mono
        />
        <DetailField label="Created" value={timeAgo(proposal.created_at)} />
        <DetailField label="Rank" value={proposal.rank_score == null ? "—" : String(proposal.rank_score)} mono />
      </DetailGrid>
      {proposal.annotation?.rationale && (
        <p className="mt-4 rounded-lg border border-border-subtle bg-overlay-1/40 px-3 py-2 text-sm leading-relaxed text-text-muted">
          {proposal.annotation.rationale}
        </p>
      )}
      {isAdmin && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <DetailActionBtn
            disabled={isPreviewed}
            title={isPreviewed ? "Already marked as previewed" : "Mark as reviewed"}
            onClick={() => void onTransition(proposal, "previewed", "previewed")}
          >
            Previewed
          </DetailActionBtn>
          {needsApproval && !isAwaitingApproval && (
            <DetailActionBtn variant="info" onClick={() => void onRequestApproval(proposal)}>
              <ShieldCheck size={14} /> Request approval
            </DetailActionBtn>
          )}
          {isAwaitingApproval && (
            <DetailActionBtn variant="info" disabled title="Approval already requested">
              <ShieldCheck size={14} /> Awaiting approval
            </DetailActionBtn>
          )}
          <DetailActionBtn onClick={onSnooze}>
            <Clock size={14} /> Snooze
          </DetailActionBtn>
          <DetailActionBtn danger onClick={onDismiss}>
            <X size={14} /> Dismiss
          </DetailActionBtn>
        </div>
      )}
    </DetailBody>
  )
}

function groupProposalsByDirection(items: Proposal[]): Array<{
  key: string
  source: string
  target: string
  items: Proposal[]
}> {
  const map = new Map<string, Proposal[]>()
  for (const p of items) {
    const key = `${p.source}\0${p.target}`
    const bucket = map.get(key)
    if (bucket) bucket.push(p)
    else map.set(key, [p])
  }
  return [...map.entries()]
    .map(([key, groupItems]) => {
      const [source, target] = key.split("\0")
      return { key, source, target, items: groupItems }
    })
    .sort((a, b) => {
      const bySource = a.source.localeCompare(b.source)
      return bySource !== 0 ? bySource : a.target.localeCompare(b.target)
    })
}

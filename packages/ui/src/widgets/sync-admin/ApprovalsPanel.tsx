import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../client/index"
import { useMe } from "../../hooks/useMe"
import { timeAgo } from "../../lib/util"
import { ModalBtnSecondary, PromptModal } from "./chrome"
import { useConsole } from "./console-context"
import { TAB_PILL, META_TEXT } from "./design"
import { PolicyRulesModal } from "./PolicyRulesModal"
import { DetailField, DetailGrid } from "../entity-registry/DetailField"
import {
  ConsolePanel, DetailBody, DetailToolbar, Empty, ItemShell, PanelToolbar, RailEmpty,
  TOOLBAR_ICON, ToolbarIconBtn, RailList, RailListItem,
} from "./shared"
import { useLiveReload } from "./useLiveReload"

interface Approval {
  id: string
  proposal_id: string
  tenant_id: string
  requested_by: string
  requested_at: string
  expires_at: string
  policy: "none" | "single" | "dual"
  state: "pending" | "partially_granted" | "granted" | "rejected" | "expired" | "bypassed"
  granted_by_1: string | null
  granted_by_2: string | null
  granted_at_1: string | null
  granted_at_2: string | null
  rejected_by: string | null
  rejected_at: string | null
  reject_reason: string | null
  bypass_by: string | null
  bypass_reason: string | null
}

const FILTERS = [
  { label: "Open", value: "pending,partially_granted" },
  { label: "Done", value: "granted" },
  { label: "Closed", value: "rejected,bypassed,expired" },
] as const

export function ApprovalsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { notify, notifyError } = useConsole()

  const [items, setItems] = useState<Approval[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>("pending,partially_granted")
  const [busy, setBusy] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [prompt, setPrompt] = useState<{ kind: "reject" | "bypass"; approval: Approval } | null>(null)

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const rows: Approval[] = []
      for (const state of filter.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        rows.push(...(await api.listApprovals({ state })) as unknown as Approval[])
      }
      const seen = new Set<string>()
      const deduped = rows.filter((row) => seen.has(row.id) ? false : (seen.add(row.id), true))
      setItems(deduped)
      setSelectedId((current) =>
        current && deduped.some((row) => row.id === current) ? current : (deduped[0]?.id ?? null),
      )
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [filter, notifyError])

  useLiveReload(refresh, (type) => type.startsWith("sync.approval"))
  useEffect(() => { void refresh() }, [refresh])

  async function grant(approval: Approval): Promise<void> {
    try {
      await api.grantApproval(approval.id)
      notify("Granted")
      await refresh()
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }

  const rulesBtn = isAdmin ? (
    <ToolbarIconBtn label="Approval rules" onClick={() => setRulesOpen(true)}>
      <ShieldAlert {...TOOLBAR_ICON} />
    </ToolbarIconBtn>
  ) : undefined

  return (
    <>
      <ConsolePanel>
        <ItemShell
          busy={busy}
          listActions={rulesBtn}
          detailToolbar={(
            <>
              <PanelToolbar busy={busy}>
                <nav className="flex min-w-0 items-center gap-1" aria-label="Filter">
                  {FILTERS.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      onClick={() => setFilter(entry.value)}
                      className={[
                        TAB_PILL,
                        filter === entry.value ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-elevated hover:text-text",
                      ].join(" ")}
                    >
                      {entry.label}
                    </button>
                  ))}
                </nav>
              </PanelToolbar>
              {selected ? (
                <DetailToolbar title={selected.requested_by} subtitle={selected.proposal_id} />
              ) : null}
            </>
          )}
          empty={items.length === 0 ? (
            <RailEmpty title="No approvals">Nothing matches this filter.</RailEmpty>
          ) : undefined}
          list={(
            <RailList label="Approvals">
              {items.map((approval) => (
                <RailListItem
                  key={approval.id}
                  active={approval.id === selectedId}
                  onClick={() => setSelectedId(approval.id)}
                  title={approval.requested_by}
                  meta={`${approval.state} · ${approval.policy}`}
                  meta2={`${approval.proposal_id.slice(0, 8)}… · ${timeAgo(approval.requested_at)}`}
                />
              ))}
            </RailList>
          )}
          detail={selected ? (
            <ApprovalDetail
              approval={selected}
              isAdmin={isAdmin}
              onGrant={grant}
              onReject={(a) => setPrompt({ kind: "reject", approval: a })}
              onBypass={(a) => setPrompt({ kind: "bypass", approval: a })}
            />
          ) : (
            <Empty title={items.length === 0 ? "No approvals" : "Select an approval"}>
              {items.length === 0 && isAdmin ? "Adjust the filter or wait for a proposal to request approval." : undefined}
            </Empty>
          )}
        />
      </ConsolePanel>

      {rulesOpen && <PolicyRulesModal isAdmin={isAdmin} onClose={() => setRulesOpen(false)} />}

      {prompt && (
        <PromptModal
          title={prompt.kind === "reject" ? "Reject" : "Bypass"}
          label="Reason"
          submitLabel={prompt.kind === "reject" ? "Reject" : "Bypass"}
          onCancel={() => setPrompt(null)}
          onSubmit={(reason) => {
            const { kind, approval } = prompt
            setPrompt(null)
            void (kind === "reject" ? api.rejectApproval(approval.id, reason) : api.bypassApproval(approval.id, reason))
              .then(() => { notify(kind === "reject" ? "Rejected" : "Bypassed"); return refresh() })
              .catch((e) => notifyError(e instanceof Error ? e.message : String(e)))
          }}
        />
      )}
    </>
  )
}

function ApprovalDetail({ approval, isAdmin, onGrant, onReject, onBypass }: {
  approval: Approval | null
  isAdmin: boolean
  onGrant: (a: Approval) => Promise<void>
  onReject: (a: Approval) => void
  onBypass: (a: Approval) => void
}): JSX.Element {
  if (!approval) return <Empty title="Select an approval" />

  const expired = new Date(approval.expires_at).getTime() < Date.now()
  const actionable = !expired && (approval.state === "pending" || approval.state === "partially_granted")

  return (
    <DetailBody>
      <p className="mb-3 text-sm font-medium text-text">{approval.requested_by}</p>
      <p className={`${META_TEXT} -mt-2 mb-3 font-mono`}>{approval.proposal_id}</p>
      <DetailGrid>
        <DetailField label="State" value={approval.state.replaceAll("_", " ")} />
        <DetailField label="Policy" value={approval.policy} />
        <DetailField
          label="Expires"
          value={`${timeAgo(approval.expires_at)}${expired ? " · expired" : ""}`}
        />
        <DetailField label="Requested" value={timeAgo(approval.requested_at)} />
      </DetailGrid>
      {actionable && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
          <ModalBtnSecondary className="border-success/30 text-success" onClick={() => void onGrant(approval)}>
            <ShieldCheck size={14} /> Grant
          </ModalBtnSecondary>
          <ModalBtnSecondary danger onClick={() => onReject(approval)}>
            <ShieldX size={14} /> Reject
          </ModalBtnSecondary>
          {isAdmin && (
            <ModalBtnSecondary className="border-warning/30 text-warning" onClick={() => onBypass(approval)}>
              Bypass
            </ModalBtnSecondary>
          )}
        </div>
      )}
    </DetailBody>
  )
}

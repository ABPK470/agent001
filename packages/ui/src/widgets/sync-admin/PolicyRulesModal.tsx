/**
 * Approval policy rules — split-pane modal editor (Configuration-style layout).
 */

import { EventType } from "@mia/shared-enums"
import { Plus, Save } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import {
  ConfirmModal,
  ModalBtnPrimary,
  ModalBtnSecondary,
  ModalShell,
} from "./chrome"
import { useConsole } from "./console-context"
import { ICON_BTN, ICON_BTN_PRIMARY, PANEL, TAB_PILL } from "./design"
import {
  AdminModalEditor,
  AdminModalEditorBody,
  AdminModalEditorHeader,
  AdminModalEmpty,
  AdminModalIntro,
  AdminModalRail,
  AdminModalRoot,
  AdminModalSplit,
  AdminRailList,
  AdminRailSection,
  FormFieldGroup,
  FormSectionCard,
} from "./modal-layout"
import { useLiveReload } from "./useLiveReload"

export interface Policy {
  tenantId: string
  targetEnv: string
  riskTier: string
  policy: "none" | "single" | "dual"
  approvers: string[]
  bypassRole: string | null
}

type Kind = Policy["policy"]

interface Draft {
  targetEnv: string
  riskTier: string
  kind: Kind
  approvers: string
  bypassRole: string
}

const DEFAULT_DRAFT: Draft = {
  targetEnv: "*",
  riskTier: "medium",
  kind: "single",
  approvers: "",
  bypassRole: "admin",
}

const KIND_OPTIONS: ListboxOption<Kind>[] = [
  { value: "none", label: "none" },
  { value: "single", label: "single" },
  { value: "dual", label: "dual" },
]

const RISK_OPTIONS: ListboxOption<string>[] = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "critical", label: "critical" },
]

const BYPASS_OPTIONS: ListboxOption<string>[] = [{ value: "admin", label: "admin" }]

const PLATFORM_DEFAULTS: readonly { riskTier: string; policy: Kind }[] = [
  { riskTier: "low", policy: "none" },
  { riskTier: "medium", policy: "single" },
  { riskTier: "high", policy: "dual" },
  { riskTier: "critical", policy: "dual" },
]

function policyKey(p: Pick<Policy, "targetEnv" | "riskTier">): string {
  return `${p.targetEnv}:${p.riskTier}`
}

function normalizePolicy(row: Record<string, unknown>): Policy {
  return {
    tenantId: String(row.tenantId ?? row.tenant_id ?? "_default"),
    targetEnv: String(row.targetEnv ?? row.target_env ?? "*"),
    riskTier: String(row.riskTier ?? row.risk_tier ?? ""),
    policy: String(row.policy ?? row.kind ?? "single") as Kind,
    approvers: Array.isArray(row.approvers) ? row.approvers.map(String) : [],
    bypassRole: row.bypassRole != null ? String(row.bypassRole) : row.bypass_role != null ? String(row.bypass_role) : null,
  }
}

export function PolicyRulesModal({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }): JSX.Element {
  const { notify, notifyError } = useConsole()
  const [items, setItems] = useState<Policy[]>([])
  const [connections, setConnections] = useState<import("../../types").SyncEnvironmentAdmin[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Policy | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [listQuery, setListQuery] = useState("")

  const targetOptions = useMemo<ListboxOption<string>[]>(() => [
    { value: "*", label: "* all environments" },
    ...connections.map((c) => ({ value: c.name, label: c.name })),
  ], [connections])

  const railItems = useMemo(
    () => items.map((p) => ({
      id: policyKey(p),
      label: `${p.targetEnv} · ${p.riskTier}`,
      hint: p.policy,
    })),
    [items],
  )

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const [rows, envs] = await Promise.all([
        api.listApprovalPolicies(),
        api.listSyncEnvironments(),
      ])
      setItems((rows as Array<Record<string, unknown>>).map(normalizePolicy))
      setConnections([...envs].sort((a, b) => a.ringOrder - b.ringOrder || a.name.localeCompare(b.name)))
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [notifyError])

  useLiveReload(refresh, (type) =>
    type === EventType.SyncPolicySaved || type === EventType.SyncPolicyDeleted,
  )

  useEffect(() => { void refresh().catch((err: unknown) => { console.error("[mia]", err) }) }, [refresh])

  function openNew(): void {
    setDraft(DEFAULT_DRAFT)
    setEditingKey(null)
    setFormOpen(true)
  }

  function openEdit(p: Policy): void {
    setDraft({
      targetEnv: p.targetEnv,
      riskTier: p.riskTier,
      kind: p.policy,
      approvers: p.approvers.join(", "),
      bypassRole: p.bypassRole ?? "admin",
    })
    setEditingKey(policyKey(p))
    setFormOpen(true)
  }

  function closeForm(): void {
    setFormOpen(false)
    setEditingKey(null)
    setDraft(DEFAULT_DRAFT)
  }

  async function save(): Promise<void> {
    setBusy(true)
    try {
      await api.upsertApprovalPolicy({
        targetEnv: draft.targetEnv,
        riskTier: draft.riskTier,
        kind: draft.kind,
        approvers: draft.approvers.split(",").map((s) => s.trim()).filter(Boolean),
        bypassRole: draft.bypassRole,
      })
      notify(editingKey ? "Rule updated" : "Rule saved")
      closeForm()
      await refresh()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(p: Policy): Promise<void> {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await api.deleteApprovalPolicy(p.targetEnv, p.riskTier)
      notify("Rule removed")
      setDeleting(null)
      if (editingKey === policyKey(p)) closeForm()
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setDeleteError(msg)
      notifyError(msg)
    } finally {
      setDeleteBusy(false)
    }
  }

  const formTitle = editingKey ? "Edit rule" : "New rule"
  const formHint = editingKey ?? undefined

  return (
    <>
      <ModalShell
        title="Approval rules"
        subtitle="Reconciliation proposals"
        size="focus"
        onClose={onClose}
        footer={
          formOpen ? (
            <>
              <ModalBtnSecondary onClick={closeForm} disabled={busy}>Back</ModalBtnSecondary>
              <div className="ml-auto">
                <ModalBtnPrimary onClick={() => void save().catch((err: unknown) => { console.error("[mia]", err) })} disabled={busy}>
                  <Save size={14} /> Save
                </ModalBtnPrimary>
              </div>
            </>
          ) : isAdmin ? (
            <div className="ml-auto">
              <ModalBtnPrimary onClick={openNew}>
                <Plus size={14} /> Add rule
              </ModalBtnPrimary>
            </div>
          ) : undefined
        }
      >
        <AdminModalRoot>
          <AdminModalIntro description="Built-in defaults apply everywhere unless you add an override for a target and risk tier.">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex items-center gap-1">
                <span className={`${TAB_PILL} bg-accent/15 text-accent`}>Overrides</span>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={openNew} className={ICON_BTN} title="New rule" aria-label="New rule">
                    <Plus size={16} />
                  </button>
                  {formOpen ? (
                    <button
                      type="button"
                      onClick={() => void save().catch((err: unknown) => { console.error("[mia]", err) })}
                      disabled={busy}
                      className={ICON_BTN_PRIMARY}
                      title="Save"
                      aria-label="Save"
                    >
                      <Save size={16} />
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </AdminModalIntro>

          <AdminModalSplit>
            <AdminModalRail>
              <AdminRailSection title="Built-in defaults">
                <ul className={PANEL}>
                  {PLATFORM_DEFAULTS.map((d, index) => (
                    <li
                      key={d.riskTier}
                      className={[
                        "flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-muted",
                        index < PLATFORM_DEFAULTS.length - 1 ? "border-b border-border/20" : "",
                      ].join(" ")}
                    >
                      <span className="font-mono">* · {d.riskTier}</span>
                      <KindBadge kind={d.policy} muted />
                    </li>
                  ))}
                </ul>
              </AdminRailSection>

              <AdminRailSection title="Overrides" grow>
                <AdminRailList
                  items={railItems}
                  selectedId={formOpen ? editingKey : null}
                  onSelect={(id) => {
                    const p = items.find((row) => policyKey(row) === id)
                    if (p) openEdit(p)
                  }}
                  onDelete={isAdmin ? (id) => {
                    const p = items.find((row) => policyKey(row) === id)
                    if (p) { setDeleteError(null); setDeleting(p) }
                  } : undefined}
                  query={listQuery}
                  onQueryChange={setListQuery}
                  searchPlaceholder="Search overrides…"
                  emptyLabel="None — defaults apply."
                />
              </AdminRailSection>
            </AdminModalRail>

            <AdminModalEditor>
              {formOpen ? (
                <>
                  <AdminModalEditorHeader
                    eyebrow="Approval rules · Override"
                    title={formTitle}
                    hint={formHint}
                  />
                  <AdminModalEditorBody>
                      <FormSectionCard
                        title="Match"
                        description="Target environment and risk tier this override applies to."
                        emphasized
                      >
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-2">
                          <FormFieldGroup label="Target">
                            <Listbox value={draft.targetEnv} options={targetOptions} onChange={(v) => setDraft({ ...draft, targetEnv: v })} size="sm" className="w-full" ariaLabel="Target" disabled={!!editingKey} />
                          </FormFieldGroup>
                          <FormFieldGroup label="Risk">
                            <Listbox value={draft.riskTier} options={RISK_OPTIONS} onChange={(v) => setDraft({ ...draft, riskTier: v })} size="sm" className="w-full" ariaLabel="Risk" disabled={!!editingKey} />
                          </FormFieldGroup>
                        </div>
                      </FormSectionCard>

                      <FormSectionCard title="Policy" description="How many approvers are required before a proposal can run.">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          <FormFieldGroup label="Kind">
                            <Listbox value={draft.kind} options={KIND_OPTIONS} onChange={(v) => setDraft({ ...draft, kind: v })} size="sm" className="w-full" ariaLabel="Kind" />
                          </FormFieldGroup>
                          <FormFieldGroup label="Bypass role">
                            <Listbox value={draft.bypassRole} options={BYPASS_OPTIONS} onChange={(v) => setDraft({ ...draft, bypassRole: v })} size="sm" className="w-full" ariaLabel="Bypass" />
                          </FormFieldGroup>
                        </div>
                        <FormFieldGroup label="Approvers" hint="Comma-separated UPNs. Empty = any non-requester.">
                          <input className="input w-full font-mono text-sm" value={draft.approvers} onChange={(e) => setDraft({ ...draft, approvers: e.target.value })} placeholder="alice@corp" />
                        </FormFieldGroup>
                      </FormSectionCard>
                  </AdminModalEditorBody>
                </>
              ) : (
                <AdminModalEmpty>
                  Select an override from the list or add a new rule.
                </AdminModalEmpty>
              )}
            </AdminModalEditor>
          </AdminModalSplit>
        </AdminModalRoot>
      </ModalShell>

      {deleting && (
        <ConfirmModal
          title="Delete rule"
          message={`Remove ${deleting.targetEnv} / ${deleting.riskTier}?`}
          confirmLabel="Delete"
          danger
          busy={deleteBusy}
          error={deleteError}
          stackLevel={1}
          onCancel={() => { if (!deleteBusy) { setDeleting(null); setDeleteError(null) } }}
          onConfirm={() => void remove(deleting).catch((err: unknown) => { console.error("[mia]", err) })}
        />
      )}
    </>
  )
}

function KindBadge({ kind, muted = false }: { kind: Kind; muted?: boolean }): JSX.Element {
  const cls = muted
    ? "bg-overlay-2 text-text-muted border-border-subtle"
    : kind === "none" ? "bg-overlay-2 text-text-muted border-border-subtle"
    : kind === "single" ? "bg-info-soft text-info border-info/30"
    : "bg-warning-soft text-warning border-warning/30"
  return <span className={`rounded border px-1.5 py-0.5 text-xs uppercase ${cls}`}>{kind}</span>
}

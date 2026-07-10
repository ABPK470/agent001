/**
 * StrategiesModal — manage SCD2 strategies from entity registry.
 */

import { GitBranch, GitFork, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../../api"
import { useLiveReload } from "../../../hooks/useLiveReload"
import { useMe } from "../../../hooks/useMe"
import type { EntityRegistryDefinition, EntityRegistryStrategy, EntityRegistryStrategyHistoryEntry } from "../../../types"
import { PANEL, ICON_BTN_PRIMARY } from "../chrome"
import {
  AdminModalEditor,
  AdminModalEditorBody,
  AdminModalEditorHeader,
  AdminModalEmpty,
  AdminModalRail,
  AdminModalSplit,
  AdminRailList,
  AdminRailSection,
} from "../governance/modal-layout"
import { ModalShell } from "../ModalShell"
import { ModalToastStack, useModalToasts } from "../ModalToastStack"
import { ConfirmModal, GovernanceIconAction } from "../governance/modal-chrome"
import { SectionRow } from "../../sync-admin/shared"
import { StrategyEditorModal } from "./StrategyEditorModal"
import { StrategyEntitiesModal, StrategyHistoryModal, StrategyPolicyModal } from "./StrategyDetailModals"
import {
  blankCustomStrategy,
  describeStrategyEffects,
  isTenantCustomStrategy,
  provenanceLabel,
} from "./strategy-helpers"

type EditorState =
  | { mode: "create"; seed: EntityRegistryStrategy }
  | { mode: "fork"; seed: EntityRegistryStrategy }
  | { mode: "edit"; seed: EntityRegistryStrategy }
  | null

const KIND_ORDER = ["bundled", "manual", "imported", "agent"] as const

export interface StrategiesModalProps {
  onClose: () => void
  onChanged?: () => void
  stackLevel?: number
  initialStrategyId?: string | null
}

export function StrategiesModal({
  onClose,
  onChanged,
  stackLevel = 0,
  initialStrategyId = null,
}: StrategiesModalProps): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { toasts, pushToast, dismissToast, clearToasts } = useModalToasts()

  const [items, setItems] = useState<EntityRegistryStrategy[]>([])
  const [busy, setBusy] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(initialStrategyId)
  const [editor, setEditor] = useState<EditorState>(null)
  const [retireTarget, setRetireTarget] = useState<EntityRegistryStrategy | null>(null)
  const [retireBusy, setRetireBusy] = useState(false)
  const [retireErr, setRetireErr] = useState<string | null>(null)
  const [listQuery, setListQuery] = useState("")

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    clearToasts()
    try {
      const response = await api.listEntityRegistryStrategies()
      setItems(response.items)
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [clearToasts, pushToast])

  useLiveReload(load, (type) => type.startsWith("entity_registry."))

  useEffect(() => {
    if (items.length === 0) return
    setSelectedId((current) => (
      current && items.some((strategy) => strategy.id === current) ? current : items[0]!.id
    ))
  }, [items])

  useEffect(() => {
    if (!initialStrategyId || items.length === 0) return
    if (items.some((strategy) => strategy.id === initialStrategyId)) {
      setSelectedId(initialStrategyId)
    }
  }, [initialStrategyId, items])

  const chosen = useMemo(
    () => items.find((strategy) => strategy.id === selectedId) ?? null,
    [items, selectedId],
  )
  const chosenIsCustom = chosen ? isTenantCustomStrategy(chosen) : false

  const railItems = useMemo(() => {
    const byKind = new Map<string, EntityRegistryStrategy[]>()
    for (const strategy of items) {
      const kind = strategy.provenance.kind
      const list = byKind.get(kind) ?? []
      list.push(strategy)
      byKind.set(kind, list)
    }
    const ordered: EntityRegistryStrategy[] = []
    for (const kind of KIND_ORDER) {
      const list = byKind.get(kind)
      if (list?.length) ordered.push(...list)
    }
    for (const [kind, list] of byKind) {
      if (!KIND_ORDER.includes(kind as (typeof KIND_ORDER)[number])) ordered.push(...list)
    }
    return ordered.map((strategy) => ({
      id: strategy.id,
      label: strategy.displayName,
      hint: `${provenanceLabel(strategy.provenance.kind)} · v${strategy.version}`,
      builtIn: !isTenantCustomStrategy(strategy),
    }))
  }, [items])

  async function confirmRetire(): Promise<void> {
    if (!retireTarget) return
    setRetireBusy(true)
    setRetireErr(null)
    try {
      await api.retireEntityRegistryStrategy(retireTarget.id)
      setRetireTarget(null)
      setSelectedId((current) => (current === retireTarget.id ? null : current))
      onChanged?.()
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRetireErr(message)
      pushToast(message)
    } finally {
      setRetireBusy(false)
    }
  }

  return (
    <>
      <ModalShell
        title="SCD2 strategies"
        subtitle="Bundled defaults plus tenant customs. Entities pin a strategy id and version."
        icon={<GitBranch size={20} className="text-text-muted" />}
        stackLevel={stackLevel}
        size="focus"
        onClose={onClose}
      >
        <div className="entity-registry relative flex min-h-0 flex-1 flex-col">
          <ModalToastStack toasts={toasts} onDismiss={dismissToast} />
          <AdminModalSplit>
            <AdminModalRail>
              {isAdmin ? (
                <div className="flex shrink-0 justify-end">
                  <button
                    type="button"
                    onClick={() => setEditor({ mode: "create", seed: blankCustomStrategy() })}
                    className={ICON_BTN_PRIMARY}
                    title="New custom strategy"
                    aria-label="New custom strategy"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              ) : null}
              <AdminRailSection title="Strategies" grow>
                {busy && items.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : (
                  <AdminRailList
                    items={railItems}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    query={listQuery}
                    onQueryChange={setListQuery}
                    searchPlaceholder="Search strategies…"
                    emptyLabel="No strategies available."
                  />
                )}
              </AdminRailSection>
            </AdminModalRail>

            <AdminModalEditor>
              {chosen ? (
                <StrategyDetailPane
                  strategy={chosen}
                  isAdmin={isAdmin}
                  chosenIsCustom={chosenIsCustom}
                  stackLevel={stackLevel + 1}
                  onEdit={() => setEditor({ mode: "edit", seed: chosen })}
                  onFork={() => setEditor({ mode: "fork", seed: chosen })}
                  onRetire={() => {
                    setRetireErr(null)
                    setRetireTarget(chosen)
                  }}
                />
              ) : (
                <AdminModalEmpty>
                  {items.length === 0
                    ? "No strategies are available yet."
                    : "Select a strategy to inspect policy details."}
                </AdminModalEmpty>
              )}
            </AdminModalEditor>
          </AdminModalSplit>
        </div>
      </ModalShell>

      {editor && (
        <StrategyEditorModal
          seed={editor.seed}
          mode={editor.mode}
          stackLevel={stackLevel + 1}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            onChanged?.()
            void load()
          }}
        />
      )}

      {retireTarget && (
        <ConfirmModal
          title="Retire strategy"
          message={`Retire "${retireTarget.displayName}" (${retireTarget.id})? Version history is kept for pinned entity references, but the strategy disappears from the catalogue and cannot be picked for new entities.`}
          confirmLabel="Retire"
          danger
          busy={retireBusy}
          error={retireErr}
          stackLevel={editor ? stackLevel + 2 : stackLevel + 1}
          onCancel={() => !retireBusy && setRetireTarget(null)}
          onConfirm={() => void confirmRetire()}
        />
      )}
    </>
  )
}

function StrategyDetailPane({
  strategy,
  isAdmin,
  chosenIsCustom,
  stackLevel,
  onEdit,
  onFork,
  onRetire,
}: {
  strategy: EntityRegistryStrategy
  isAdmin: boolean
  chosenIsCustom: boolean
  stackLevel: number
  onEdit: () => void
  onFork: () => void
  onRetire: () => void
}): JSX.Element {
  const effects = useMemo(() => describeStrategyEffects(strategy), [strategy])
  const [history, setHistory] = useState<EntityRegistryStrategyHistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(true)
  const [entities, setEntities] = useState<EntityRegistryDefinition[]>([])
  const [entitiesBusy, setEntitiesBusy] = useState(true)
  const [modal, setModal] = useState<"columns" | "history" | "entities" | null>(null)

  useEffect(() => {
    let cancelled = false
    setHistoryBusy(true)
    void api.listEntityRegistryStrategyHistory(strategy.id)
      .then((response) => { if (!cancelled) setHistory(response.items) })
      .catch(() => { if (!cancelled) setHistory([]) })
      .finally(() => { if (!cancelled) setHistoryBusy(false) })
    return () => { cancelled = true }
  }, [strategy.id])

  useEffect(() => {
    let cancelled = false
    setEntitiesBusy(true)
    void api.listEntityRegistry()
      .then((response) => {
        if (cancelled) return
        setEntities(response.items.filter((definition) => definition.scd2.strategyId === strategy.id))
      })
      .catch(() => { if (!cancelled) setEntities([]) })
      .finally(() => { if (!cancelled) setEntitiesBusy(false) })
    return () => { cancelled = true }
  }, [strategy.id])

  return (
    <>
      <AdminModalEditorHeader
        eyebrow="SCD2 strategy"
        title={strategy.displayName}
        hint={`${strategy.id} · v${strategy.version}${strategy.versionLabel ? ` (${strategy.versionLabel})` : ""}`}
        actions={isAdmin ? (
          chosenIsCustom ? (
            <>
              <GovernanceIconAction label="Edit" onClick={onEdit}>
                <Pencil size={15} />
              </GovernanceIconAction>
              <GovernanceIconAction label="Fork" onClick={onFork}>
                <GitFork size={15} />
              </GovernanceIconAction>
              <GovernanceIconAction label="Retire" onClick={onRetire}>
                <Trash2 size={15} />
              </GovernanceIconAction>
            </>
          ) : (
            <GovernanceIconAction label="Fork to edit" onClick={onFork}>
              <GitFork size={15} />
            </GovernanceIconAction>
          )
        ) : undefined}
      />
      <AdminModalEditorBody>
        {!isTenantCustomStrategy(strategy) && (
          <p className="rounded-lg border border-border-subtle bg-overlay-1/40 px-3 py-2 text-sm leading-relaxed text-text-muted">
            Shipped defaults are read-only. Use <span className="text-text">Fork to edit</span> to create a tenant copy you can edit, version, or retire.
          </p>
        )}

        {strategy.description ? (
          <p className="text-sm leading-relaxed text-text-muted">{strategy.description}</p>
        ) : null}

        <ul className={`${PANEL} space-y-1 px-3 py-2`}>
          {effects.map((bullet, index) => (
            <li key={index} className="flex items-start gap-2 text-sm">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${bullet.active ? "bg-success" : "bg-text-faint/40"}`} />
              <span className={bullet.active ? "text-text" : "text-text-muted"}>{bullet.text}</span>
            </li>
          ))}
        </ul>

        <ol className={`${PANEL} overflow-hidden`}>
          <SectionRow title="Policy document" subtitle="excludeFromDiff + stamp maps" onClick={() => setModal("columns")} />
          <SectionRow
            title="Version history"
            badge={historyBusy ? "…" : String(history.length)}
            onClick={() => setModal("history")}
          />
          <SectionRow
            title="Entities"
            badge={entitiesBusy ? "…" : String(entities.length)}
            onClick={() => setModal("entities")}
          />
        </ol>
      </AdminModalEditorBody>

      {modal === "columns" && (
        <StrategyPolicyModal strategy={strategy} stackLevel={stackLevel} onClose={() => setModal(null)} />
      )}
      {modal === "history" && !historyBusy && (
        <StrategyHistoryModal strategy={strategy} history={history} stackLevel={stackLevel} onClose={() => setModal(null)} />
      )}
      {modal === "entities" && !entitiesBusy && (
        <StrategyEntitiesModal strategyId={strategy.id} entities={entities} stackLevel={stackLevel} onClose={() => setModal(null)} />
      )}
    </>
  )
}

/**
 * StrategiesPanel — SCD2 strategy catalogue (bundled defaults + tenant customs).
 *
 * Where strategies live:
 *   - Shipped defaults are defined in @mia/sync (`bundled-strategies.ts`) and
 *     seeded into SQLite (`scd2_strategy_versions`) on first boot.
 *   - Tenant customs are append-only version rows in the same tables.
 *   - Entity definitions only store `{ strategyId, strategyVersion }` refs.
 *
 * Bundled defaults are read-only here — fork to create a tenant copy, then
 * edit versions of the custom id. Version history is immutable.
 */

import { GitFork, Pencil, Plus } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import type {
  EntityRegistryDefinition,
  EntityRegistryStrategy,
  EntityRegistryStrategyHistoryEntry,
} from "../../types"
import { PANEL } from "./design"
import {
  ConsolePanel, DetailBody, DetailToolbar, Empty, IconAction, ItemShell, RailEmpty,
  TOOLBAR_ICON, ToolbarIconBtn, RailList, RailListItem, SectionRow,
} from "./shared"
import { StrategyEditorModal } from "./StrategyEditorModal"
import { StrategyColumnsModal, StrategyEntitiesModal, StrategyHistoryModal } from "./StrategyDetailModals"
import { blankCustomStrategy, describeStrategyEffects, provenanceLabel } from "./strategy-helpers"
import { useLiveReload } from "./useLiveReload"

type EditorState =
  | { mode: "create"; seed: EntityRegistryStrategy }
  | { mode: "fork"; seed: EntityRegistryStrategy }
  | { mode: "edit"; seed: EntityRegistryStrategy }
  | null

const KIND_ORDER = ["bundled", "manual", "imported", "agent"] as const

export function StrategiesPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items, setItems] = useState<EntityRegistryStrategy[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.listEntityRegistryStrategies()
      setItems(r.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useLiveReload(load, (type) => type.startsWith("entity_registry."))

  const chosen = useMemo(() => items.find((s) => s.id === selected) ?? null, [items, selected])

  useEffect(() => {
    if (items.length === 0) return
    setSelected((current) => (current && items.some((s) => s.id === current) ? current : items[0]!.id))
  }, [items])

  const groups = useMemo(() => {
    const by = new Map<string, EntityRegistryStrategy[]>()
    for (const s of items) {
      const kind = s.provenance.kind
      const list = by.get(kind) ?? []
      list.push(s)
      by.set(kind, list)
    }
    const ordered: [string, EntityRegistryStrategy[]][] = []
    for (const kind of KIND_ORDER) {
      const list = by.get(kind)
      if (list?.length) ordered.push([kind, list])
    }
    for (const [kind, list] of by) {
      if (!KIND_ORDER.includes(kind as (typeof KIND_ORDER)[number])) ordered.push([kind, list])
    }
    return ordered
  }, [items])

  return (
    <ConsolePanel err={err} onClearErr={() => setErr(null)}>
      <ItemShell
        busy={busy}
        listActions={isAdmin ? (
          <ToolbarIconBtn label="New custom" onClick={() => setEditor({ mode: "create", seed: blankCustomStrategy() })}>
            <Plus {...TOOLBAR_ICON} />
          </ToolbarIconBtn>
        ) : undefined}
        detailToolbar={chosen ? (
          <DetailToolbar
            title={chosen.displayName}
            subtitle={`${chosen.id} · v${chosen.version}${chosen.versionLabel ? ` (${chosen.versionLabel})` : ""}`}
            actions={isAdmin ? (
              chosen.provenance.kind === "bundled" ? (
                <IconAction label="Fork" onClick={() => setEditor({ mode: "fork", seed: chosen })}>
                  <GitFork {...TOOLBAR_ICON} />
                </IconAction>
              ) : (
                <>
                  <IconAction label="Edit" onClick={() => setEditor({ mode: "edit", seed: chosen })}>
                    <Pencil {...TOOLBAR_ICON} />
                  </IconAction>
                  <IconAction label="Fork" onClick={() => setEditor({ mode: "fork", seed: chosen })}>
                    <GitFork {...TOOLBAR_ICON} />
                  </IconAction>
                </>
              )
            ) : undefined}
          />
        ) : undefined}
        empty={items.length === 0 ? <RailEmpty title="No strategies" /> : undefined}
        list={(
          <RailList label="Strategies">
            {groups.flatMap(([kind, list]) => list.map((s) => (
              <RailListItem
                key={s.id}
                active={s.id === selected}
                onClick={() => setSelected(s.id)}
                title={s.id}
                meta={s.displayName}
                meta2={`${provenanceLabel(kind as EntityRegistryStrategy["provenance"]["kind"])} · v${s.version}`}
              />
            )))}
          </RailList>
        )}
        detail={
          chosen ? (
            <StrategyDetail s={chosen} />
          ) : (
            <Empty title="Select a strategy" />
          )
        }
      />

      {editor && (
        <StrategyEditorModal
          seed={editor.seed}
          mode={editor.mode}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            void load()
          }}
        />
      )}
    </ConsolePanel>
  )
}

// ── Detail ────────────────────────────────────────────────────────

function StrategyDetail({ s }: {
  s: EntityRegistryStrategy
}): JSX.Element {
  const effects = useMemo(() => describeStrategyEffects(s), [s])

  const [history, setHistory] = useState<EntityRegistryStrategyHistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(true)
  const [entities, setEntities] = useState<EntityRegistryDefinition[]>([])
  const [entitiesBusy, setEntitiesBusy] = useState(true)
  const [modal, setModal] = useState<"columns" | "history" | "entities" | null>(null)

  useEffect(() => {
    let cancelled = false
    setHistoryBusy(true)
    void api.listEntityRegistryStrategyHistory(s.id)
      .then((r) => { if (!cancelled) setHistory(r.items) })
      .catch(() => { if (!cancelled) setHistory([]) })
      .finally(() => { if (!cancelled) setHistoryBusy(false) })
    return () => { cancelled = true }
  }, [s.id])

  useEffect(() => {
    let cancelled = false
    setEntitiesBusy(true)
    void api.listEntityRegistry()
      .then((r) => {
        if (cancelled) return
        setEntities(r.items.filter((d) => d.scd2.strategyId === s.id))
      })
      .catch(() => { if (!cancelled) setEntities([]) })
      .finally(() => { if (!cancelled) setEntitiesBusy(false) })
    return () => { cancelled = true }
  }, [s.id])

  return (
    <DetailBody>
      {s.description && <p className="mb-3 text-sm text-text-muted leading-relaxed">{s.description}</p>}

      <ul className={`${PANEL} mb-3 space-y-1 px-3 py-2`}>
        {effects.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${b.active ? "bg-success" : "bg-text-faint/40"}`} />
            <span className={b.active ? "text-text" : "text-text-muted"}>{b.text}</span>
          </li>
        ))}
      </ul>

      <ol className={`${PANEL} overflow-hidden`}>
        <SectionRow title="Column map" subtitle="SCD2 column bindings" onClick={() => setModal("columns")} />
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

      {modal === "columns" && <StrategyColumnsModal strategy={s} onClose={() => setModal(null)} />}
      {modal === "history" && !historyBusy && (
        <StrategyHistoryModal strategy={s} history={history} onClose={() => setModal(null)} />
      )}
      {modal === "entities" && !entitiesBusy && (
        <StrategyEntitiesModal strategyId={s.id} entities={entities} onClose={() => setModal(null)} />
      )}
    </DetailBody>
  )
}

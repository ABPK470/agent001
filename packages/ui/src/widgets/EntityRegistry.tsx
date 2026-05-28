/**
 * EntityRegistry — runtime entity-registry admin surface.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Toolbar: refresh · count · [admin: import · new]               │
 *   ├──────────────┬─────────────────────────────────────────────────┤
 *   │ Entity list  │ Tabs: Overview / Tables / History / YAML /      │
 *   │              │       Authoring                                 │
 *   │ (panel)      │ [admin: edit · retire on header row]            │
 *   │              │                                                  │
 *   └──────────────┴─────────────────────────────────────────────────┘
 *
 * Composition: this file is the shell — state, layout, SSE wiring,
 * toolbar, and tab routing only. Each tab and modal lives in its own
 * file under `./entity-registry/` so individual files stay tight and
 * focused. All admin writes require a reason captured in-form.
 */

import {
    AlertTriangle,
    CheckCircle2,
    FilePlus2,
    Loader2,
    Pencil,
    RefreshCcw,
    Trash2,
    Upload,
    X,
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type {
    EntityRegistryDefinition,
    EntityRegistryHistoryEntry,
    EntityRegistrySyncDefinitionStatusResponse,
} from "../types"
import { EntityAuthoring } from "./entity-registry/EntityAuthoring"
import { EntityEditModal } from "./entity-registry/EntityEditModal"
import { EntityHistory } from "./entity-registry/EntityHistory"
import { EntityImportModal } from "./entity-registry/EntityImportModal"
import { EntityList } from "./entity-registry/EntityList"
import { EntityOverview } from "./entity-registry/EntityOverview"
import { EntityTables } from "./entity-registry/EntityTables"
import { EntityYaml } from "./entity-registry/EntityYaml"

const TABS = ["overview", "tables", "history", "document", "authoring"] as const
type Tab = typeof TABS[number]

interface Banner { kind: "error" | "success"; text: string }

export function EntityRegistry(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items, setItems]           = useState<EntityRegistryDefinition[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab]               = useState<Tab>("overview")
  const [history, setHistory]       = useState<EntityRegistryHistoryEntry[]>([])
  const [yamlText, setYamlText]     = useState<string>("")
  const [authoringStatus, setAuthoringStatus] = useState<EntityRegistrySyncDefinitionStatusResponse | null>(null)
  const [busy, setBusy]             = useState(false)
  const [banner, setBanner]         = useState<Banner | null>(null)
  const [modal, setModal]           = useState<null | { kind: "import" } | { kind: "new" } | { kind: "edit"; def: EntityRegistryDefinition }>(null)

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  )

  // ── Data loading ───────────────────────────────────────────────
  async function refreshList(opts: { keepSelection?: boolean } = {}) {
    setBusy(true)
    try {
      const res = await api.listEntityRegistry({ includeRetired: true })
      const status = await api.getEntityRegistrySyncDefinitionStatus()
      setItems(res.items)
      setAuthoringStatus(status)
      if (!opts.keepSelection && !selectedId && res.items.length > 0) {
        setSelectedId(res.items[0]!.id)
      }
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refreshList() }, [])

  // SSE-driven refresh — re-run on any entity_registry.* event.
  const entityEventCount = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("entity_registry.")).length,
  )
  useEffect(() => {
    if (entityEventCount === 0) return
    void refreshList({ keepSelection: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityEventCount])

  // Tab-driven secondary loads.
  useEffect(() => {
    if (!selectedId) return
    if (tab === "history") {
      void api.getEntityRegistryHistory(selectedId).then(setHistory).catch((e) =>
        setBanner({ kind: "error", text: String(e) }))
    } else if (tab === "document") {
      void api.getEntityRegistryYaml(selectedId).then(setYamlText).catch((e) =>
        setBanner({ kind: "error", text: String(e) }))
    }
  }, [tab, selectedId])

  // ── Actions ─────────────────────────────────────────────────────
  async function doRetire() {
    if (!selected || !isAdmin) return
    if (!confirm(`Retire entity "${selected.id}"?\n\nHistorical pinned references will keep resolving via prior versions.`)) return
    setBusy(true)
    try {
      await api.retireEntityRegistry(selected.id)
      setBanner({ kind: "success", text: `Retired ${selected.id}` })
      await refreshList({ keepSelection: true })
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col bg-canvas text-text">
      <Toolbar
        busy={busy}
        count={items.length}
        isAdmin={isAdmin}
        onRefresh={() => void refreshList({ keepSelection: true })}
        onImport={() => setModal({ kind: "import" })}
        onNew={() => setModal({ kind: "new" })}
      />

      {banner && (
        <div
          className={[
            "flex items-center gap-2 border-b px-4 py-2 text-xs",
            banner.kind === "error"
              ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
          ].join(" ")}
        >
          {banner.kind === "error"
            ? <AlertTriangle className="h-3 w-3" />
            : <CheckCircle2 className="h-3 w-3" />}
          <span>{banner.text}</span>
          <button type="button" className="ml-auto" onClick={() => setBanner(null)} aria-label="Dismiss">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-panel">
          <EntityList items={items} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setTab("overview") }} />
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          {!selected && (
            <div className="m-auto text-sm text-text-muted">
              {items.length === 0 ? "No entities loaded yet." : "Select an entity to view its details."}
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center border-b border-border-subtle bg-panel">
                <nav className="flex items-center gap-0.5 px-4">
                  {TABS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className={[
                        "border-b-2 px-3 py-2.5 text-xs font-medium transition-colors",
                        tab === t
                          ? "border-accent text-text"
                          : "border-transparent text-text-muted hover:text-text",
                      ].join(" ")}
                    >
                      {t === "tables" ? `Tables (${(selected.tables ?? []).length})` : t === "document" ? "Document" : t[0]!.toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </nav>
                <div className="ml-auto flex items-center gap-1.5 pr-4">
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setModal({ kind: "edit", def: selected })}
                      disabled={busy}
                      className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                  )}
                  {isAdmin && !selected.retiredAt && (
                    <button
                      type="button"
                      onClick={() => void doRetire()}
                      disabled={busy}
                      className="flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-3 w-3" /> Retire
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4">
                {tab === "overview" && <EntityOverview def={selected} />}
                {tab === "tables"   && <EntityTables  def={selected} />}
                {tab === "history"  && <EntityHistory entries={history} />}
                {tab === "document" && <EntityYaml yaml={yamlText} def={selected} entityId={selected.id} />}
                {tab === "authoring" && (
                  <EntityAuthoring
                    def={selected}
                    status={authoringStatus}
                    onMessage={setBanner}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {modal?.kind === "import" && (
        <EntityImportModal
          onClose={() => setModal(null)}
          onImported={() => { setBanner({ kind: "success", text: "Import committed" }); void refreshList({ keepSelection: true }) }}
        />
      )}
      {modal?.kind === "new" && (
        <EntityEditModal
          mode="new"
          initial={null}
          onClose={() => setModal(null)}
          onSaved={(id, v) => { setBanner({ kind: "success", text: `Created ${id} · v${v}` }); setSelectedId(id); void refreshList({ keepSelection: true }) }}
        />
      )}
      {modal?.kind === "edit" && (
        <EntityEditModal
          mode="edit"
          initial={modal.def}
          onClose={() => setModal(null)}
          onSaved={(id, v) => { setBanner({ kind: "success", text: `Saved ${id} · v${v}` }); void refreshList({ keepSelection: true }) }}
        />
      )}
    </div>
  )
}

// ── Toolbar (kept local — tightly coupled to the shell) ─────────

interface ToolbarProps {
  busy: boolean
  count: number
  isAdmin: boolean
  onRefresh: () => void
  onImport: () => void
  onNew: () => void
}

function Toolbar({ busy, count, isAdmin, onRefresh, onImport, onNew }: ToolbarProps): JSX.Element {
  const baseBtn = "flex items-center gap-1.5 rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle bg-panel px-4 py-2">
      <h1 className="text-sm font-semibold text-text">Entity Registry</h1>
      <span className="text-xs text-text-muted">
        {count} entit{count === 1 ? "y" : "ies"}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" onClick={onRefresh} disabled={busy} className={baseBtn}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
          Refresh
        </button>
        {isAdmin && (
          <>
            <button type="button" onClick={onImport} disabled={busy} className={baseBtn}>
              <Upload className="h-3 w-3" /> Import YAML / JSON
            </button>
            <button
              type="button"
              onClick={onNew}
              disabled={busy}
              className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              <FilePlus2 className="h-3 w-3" /> New entity
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * EntityRegistry — runtime entity-registry admin surface.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Toolbar: refresh · count · [admin: import · new]               │
 *   ├──────────────┬─────────────────────────────────────────────────┤
 *   │ Entity list  │ Tabs: Overview / Tables / History / Registry    │
 *   │              │       Doc                                        │
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
  Archive,
  CheckCircle2,
  FilePlus2,
  Loader2,
  Package2,
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
} from "../types"
import { EntityEditModal } from "./entity-registry/EntityEditModal"
import { EntityHistory } from "./entity-registry/EntityHistory"
import { EntityImportModal } from "./entity-registry/EntityImportModal"
import { EntityList } from "./entity-registry/EntityList"
import { EntityOverview } from "./entity-registry/EntityOverview"
import { EntityTables } from "./entity-registry/EntityTables"
import { EntityYaml } from "./entity-registry/EntityYaml"

const TABS = ["overview", "tables", "history", "document"] as const
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
      setItems(res.items)
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
        onRefresh={() => void refreshList({ keepSelection: true })}
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
        <aside className="flex w-80 shrink-0 flex-col border-r border-border-subtle bg-panel">
          <div className="border-b border-border-subtle px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              {/* <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Entities</div>
                <div className="mt-1 text-sm text-text">{items.length} entit{items.length === 1 ? "y" : "ies"}</div>
              </div> */}
              {isAdmin && (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <button type="button" onClick={() => setModal({ kind: "import" })} disabled={busy} className="flex items-center gap-1.5 rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50">
                    <Upload className="h-3 w-3" /> Import
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: "new" })}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
                  >
                    <FilePlus2 className="h-3 w-3" /> New
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EntityList items={items} selectedId={selectedId} onSelect={(id) => { setSelectedId(id) }} />
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          {!selected && (
            <div className="m-auto text-sm text-text-muted">
              {items.length === 0 ? "No entities loaded yet." : "Select an entity to view its details."}
            </div>
          )}
          {selected && (
            <>
              <div className="border-b border-border-subtle bg-panel px-4 py-3">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <nav className="flex flex-wrap items-center gap-2">
                    {TABS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTab(t)}
                        className={[
                          "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                          tab === t
                            ? "border-accent bg-accent/10 text-accent"
                            : "border-border-subtle text-text-muted hover:bg-overlay-2 hover:text-text",
                        ].join(" ")}
                      >
                        {t === "tables"
                          ? `Tables (${(selected.tables ?? []).length})`
                          : t === "document"
                            ? "Registry Doc"
                            : t[0]!.toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </nav>

                  <div className="flex flex-wrap items-center gap-1.5 xl:justify-end">
                    {isAdmin && !selected.retiredAt && (
                      <button
                        type="button"
                        onClick={() => setModal({ kind: "edit", def: selected })}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded border border-border-subtle px-3 py-2 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                    )}
                    {isAdmin && !selected.retiredAt && (
                      <button
                        type="button"
                        onClick={() => void doRetire()}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded border border-rose-500/40 px-3 py-2 text-xs text-rose-300 hover:bg-rose-500/10"
                      >
                        <Trash2 className="h-3 w-3" /> Retire
                      </button>
                    )}
                    {selected.retiredAt && (
                      <div className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-overlay-2 px-2.5 py-1 text-[11px] text-text-muted">
                        <span className="inline-flex items-center gap-1">
                          <Archive className="h-3 w-3" /> retired
                        </span>
                        <span className="hidden sm:inline">read-only: kept for history and reference</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-auto bg-canvas p-4">
                {tab === "overview" && <EntityOverview def={selected} />}
                {tab === "tables"   && <EntityTables  def={selected} />}
                {tab === "history"  && <EntityHistory entries={history} />}
                {tab === "document" && <EntityYaml yaml={yamlText} def={selected} entityId={selected.id} isAdmin={isAdmin} />}
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
  onRefresh: () => void
}

function Toolbar({ busy, count, onRefresh }: ToolbarProps): JSX.Element {
  const baseBtn = "flex items-center gap-1.5 rounded border border-border-subtle px-2.5 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle bg-panel px-4 py-3">
      <div>
        <h1 className="text-sm font-semibold text-text">Entity Registry</h1>
        <p className="text-xs text-text-muted">Saved registry records and version history.</p>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" onClick={onRefresh} disabled={busy} className={baseBtn}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
          Refresh
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-canvas px-2.5 py-1 text-xs text-text-muted">
          <Package2 className="h-3 w-3" /> {count} entit{count === 1 ? "y" : "ies"}
        </span>
      </div>
    </div>
  )
}

/**
 * EntityRegistry — Phase 0 UI surface for the runtime entity registry.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Toolbar: refresh • import YAML • [admin: new entity]         │
 *   ├──────────────┬───────────────────────────────────────────────┤
 *   │ Entity list  │ Detail tabs: Overview / Tables / History / YAML│
 *   │              │                                                │
 *   │  contract    │  (selected entity rendered here)               │
 *   │  dataset     │                                                │
 *   │  rule        │                                                │
 *   │  ...         │                                                │
 *   └──────────────┴───────────────────────────────────────────────┘
 *
 * Subscribes to entity_registry.* SSE events so saves/retires/imports
 * trigger an automatic refresh. Admin-only writes are gated; non-admins
 * see the surface read-only.
 */

import {
    AlertTriangle,
    CheckCircle2,
    Clock,
    Download,
    History,
    Loader2,
    RefreshCw,
    Save,
    Trash2,
    Upload,
    X,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type {
    EntityRegistryDefinition,
    EntityRegistryHistoryEntry,
    EntityRegistryYamlImportResponse,
} from "../types"
import { timeAgo } from "../util"

type Tab = "overview" | "tables" | "history" | "yaml"

export function EntityRegistry(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items, setItems]               = useState<EntityRegistryDefinition[]>([])
  const [selectedId, setSelectedId]     = useState<string | null>(null)
  const [tab, setTab]                   = useState<Tab>("overview")
  const [history, setHistory]           = useState<EntityRegistryHistoryEntry[]>([])
  const [yamlText, setYamlText]         = useState<string>("")
  const [busy, setBusy]                 = useState(false)
  const [errMsg, setErrMsg]             = useState<string | null>(null)
  const [okMsg, setOkMsg]               = useState<string | null>(null)
  const [importOpen, setImportOpen]     = useState(false)
  const [importYaml, setImportYaml]     = useState("")
  const [importReason, setImportReason] = useState("")
  const [importResult, setImportResult] = useState<EntityRegistryYamlImportResponse | null>(null)

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId])

  async function refreshList() {
    setBusy(true); setErrMsg(null)
    try {
      const res = await api.listEntityRegistry({ includeRetired: true })
      setItems(res.items)
      if (!selectedId && res.items.length > 0) setSelectedId(res.items[0]!.id)
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refreshList() }, [])

  // SSE-driven refresh — subscribe to the store's sseEventLog and refresh
  // when any entity_registry.* event arrives. The selector returns just the
  // count of relevant events so re-renders are bounded.
  const entityRegistryEventCount = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("entity_registry.")).length,
  )
  useEffect(() => {
    // Skip the initial mount — refreshList already ran above.
    if (entityRegistryEventCount === 0) return
    void refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityRegistryEventCount])

  useEffect(() => {
    if (!selectedId) return
    if (tab === "history") {
      void api.getEntityRegistryHistory(selectedId).then(setHistory).catch((e) => setErrMsg(String(e)))
    } else if (tab === "yaml") {
      void api.getEntityRegistryYaml(selectedId).then(setYamlText).catch((e) => setErrMsg(String(e)))
    }
  }, [tab, selectedId])

  async function doRetire() {
    if (!selected || !isAdmin) return
    if (!confirm(`Retire entity "${selected.id}"? Historical references remain resolvable.`)) return
    setBusy(true); setErrMsg(null)
    try {
      await api.retireEntityRegistry(selected.id)
      setOkMsg(`Retired ${selected.id}`)
      await refreshList()
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doImport(dryRun: boolean) {
    if (!importYaml.trim() || !importReason.trim()) {
      setErrMsg("YAML body and reason are both required.")
      return
    }
    setBusy(true); setErrMsg(null); setImportResult(null)
    try {
      const r = await api.importEntityRegistryYaml(importYaml, importReason, { dryRun })
      setImportResult(r)
      if (!dryRun && r.ok) {
        setOkMsg(`Imported ${r.saved.length} entit${r.saved.length === 1 ? "y" : "ies"}`)
        await refreshList()
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg-canvas text-fg-default">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border-default px-4 py-2">
        <h1 className="text-base font-semibold">Entity Registry</h1>
        <span className="text-xs text-fg-muted">{items.length} entit{items.length === 1 ? "y" : "ies"}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshList()}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs hover:bg-bg-subtle"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs hover:bg-bg-subtle"
            >
              <Upload className="h-3 w-3" />
              Import YAML
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      {errMsg && (
        <div className="flex items-center gap-2 border-b border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
          <AlertTriangle className="h-3 w-3" /> {errMsg}
          <button type="button" onClick={() => setErrMsg(null)} className="ml-auto"><X className="h-3 w-3" /></button>
        </div>
      )}
      {okMsg && (
        <div className="flex items-center gap-2 border-b border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="h-3 w-3" /> {okMsg}
          <button type="button" onClick={() => setOkMsg(null)} className="ml-auto"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* Main split */}
      <div className="flex flex-1 overflow-hidden">
        {/* List */}
        <aside className="flex w-64 flex-col overflow-y-auto border-r border-border-default">
          {items.length === 0 && !busy && (
            <div className="p-4 text-xs text-fg-muted">No entities yet. Import via YAML or seed via <code>deploy/mssql/entities/</code>.</div>
          )}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => { setSelectedId(it.id); setTab("overview") }}
              className={`flex flex-col items-start gap-0.5 border-b border-border-default px-3 py-2 text-left text-xs hover:bg-bg-subtle ${
                selectedId === it.id ? "bg-accent/10" : ""
              }`}
            >
              <span className="font-medium text-fg-default">{it.displayName}</span>
              <span className="text-fg-muted">
                {it.id} · v{it.version}{it.retiredAt ? " · retired" : ""}
              </span>
              <span className="text-[10px] text-fg-muted">{it.rootTable}</span>
            </button>
          ))}
        </aside>

        {/* Detail */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {!selected && (
            <div className="m-auto text-sm text-fg-muted">Select an entity to view details.</div>
          )}
          {selected && (
            <>
              <div className="flex items-center border-b border-border-default px-4">
                {(["overview", "tables", "history", "yaml"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`px-3 py-2 text-xs ${
                      tab === t ? "border-b-2 border-accent text-fg-default" : "text-fg-muted hover:text-fg-default"
                    }`}
                  >
                    {t === "overview" && "Overview"}
                    {t === "tables" && `Tables (${selected.tables.length})`}
                    {t === "history" && "History"}
                    {t === "yaml" && "YAML"}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-2">
                  {isAdmin && !selected.retiredAt && (
                    <button
                      type="button"
                      onClick={() => void doRetire()}
                      className="flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-3 w-3" /> Retire
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4 text-xs">
                {tab === "overview" && <EntityOverview def={selected} />}
                {tab === "tables" && <EntityTables def={selected} />}
                {tab === "history" && <EntityHistory entries={history} />}
                {tab === "yaml" && <EntityYaml yaml={yamlText} entityId={selected.id} />}
              </div>
            </>
          )}
        </main>
      </div>

      {/* Import modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex max-h-[90vh] w-[800px] flex-col rounded-lg border border-border-default bg-bg-canvas">
            <header className="flex items-center border-b border-border-default px-4 py-2">
              <h2 className="text-sm font-semibold">Import entities from YAML</h2>
              <button
                type="button"
                onClick={() => { setImportOpen(false); setImportResult(null) }}
                className="ml-auto"
              ><X className="h-4 w-4" /></button>
            </header>
            <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 text-xs">
              <label className="flex flex-col gap-1">
                <span className="text-fg-muted">Reason (required)</span>
                <input
                  type="text"
                  value={importReason}
                  onChange={(e) => setImportReason(e.target.value)}
                  className="rounded border border-border-default bg-bg-subtle px-2 py-1"
                  placeholder="e.g. add Q3 risk-tier entity"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-fg-muted">YAML (single or multi-doc)</span>
                <textarea
                  value={importYaml}
                  onChange={(e) => setImportYaml(e.target.value)}
                  className="min-h-[300px] flex-1 rounded border border-border-default bg-bg-subtle p-2 font-mono"
                  placeholder="id: my-entity&#10;tenantId: _default&#10;..."
                />
              </label>
              {importResult && (
                <div className="rounded border border-border-default bg-bg-subtle p-2">
                  <div className="flex items-center gap-2">
                    {importResult.ok
                      ? <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                      : <AlertTriangle className="h-3 w-3 text-rose-400" />}
                    <span>{importResult.dryRun ? "Dry-run" : "Result"}: {importResult.saved.length} saved, {importResult.errors.length} error(s)</span>
                  </div>
                  {importResult.errors.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {importResult.errors.map((e, i) => (
                        <li key={i} className="text-rose-300">
                          <span className="font-mono">{e.id ?? "<parse>"}</span>:{" "}
                          {typeof e.error === "string" ? e.error : JSON.stringify(e.error.errors)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <footer className="flex items-center gap-2 border-t border-border-default px-4 py-2">
              <button
                type="button"
                onClick={() => void doImport(true)}
                disabled={busy}
                className="rounded border border-border-default px-3 py-1 text-xs hover:bg-bg-subtle"
              >Dry-run</button>
              <button
                type="button"
                onClick={() => void doImport(false)}
                disabled={busy}
                className="ml-auto flex items-center gap-1 rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/80"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Import
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

function EntityOverview({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-fg-muted">ID</dt><dd className="font-mono">{def.id}</dd>
      <dt className="text-fg-muted">Tenant</dt><dd>{def.tenantId}</dd>
      <dt className="text-fg-muted">Display name</dt><dd>{def.displayName}</dd>
      <dt className="text-fg-muted">Description</dt><dd>{def.description || "—"}</dd>
      <dt className="text-fg-muted">Root table</dt><dd className="font-mono">{def.rootTable}</dd>
      <dt className="text-fg-muted">ID column</dt><dd className="font-mono">{def.idColumn}</dd>
      {def.labelColumn && <><dt className="text-fg-muted">Label column</dt><dd className="font-mono">{def.labelColumn}</dd></>}
      {def.selfJoinColumn && <><dt className="text-fg-muted">Self-join</dt><dd className="font-mono">{def.selfJoinColumn}</dd></>}
      <dt className="text-fg-muted">SCD2 strategy</dt><dd className="font-mono">{def.scd2.strategyId} v{String(def.scd2.strategyVersion)}</dd>
      <dt className="text-fg-muted">Approval policy</dt><dd>{def.policies.approvalPolicyId ?? "—"}</dd>
      <dt className="text-fg-muted">Freeze windows</dt><dd>{def.policies.freezeWindowIds.join(", ") || "—"}</dd>
      <dt className="text-fg-muted">Risk multiplier</dt><dd>{def.policies.riskMultiplier}×</dd>
      <dt className="text-fg-muted">Version</dt><dd>v{def.version} {def.versionLabel ? `(${def.versionLabel})` : ""}</dd>
      <dt className="text-fg-muted">Created</dt><dd>{def.createdBy} · {timeAgo(def.createdAt)}</dd>
      <dt className="text-fg-muted">Reason</dt><dd>{def.reason || "—"}</dd>
      {def.retiredAt && <><dt className="text-fg-muted">Retired at</dt><dd>{def.retiredAt}</dd></>}
    </dl>
  )
}

function EntityTables({ def }: { def: EntityRegistryDefinition }): JSX.Element {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-border-default text-fg-muted">
          <th className="px-2 py-1 text-left">#</th>
          <th className="px-2 py-1 text-left">Table</th>
          <th className="px-2 py-1 text-left">Scope</th>
          <th className="px-2 py-1 text-left">Verified</th>
          <th className="px-2 py-1 text-left">Archive</th>
        </tr>
      </thead>
      <tbody>
        {def.tables.map((t, i) => (
          <tr key={i} className="border-b border-border-default/50">
            <td className="px-2 py-1 text-fg-muted">{t.executionOrder}</td>
            <td className="px-2 py-1 font-mono">{t.name}</td>
            <td className="px-2 py-1 font-mono text-fg-muted">
              {t.scope.kind === "rootPk" && <>rootPk · {t.scope.column}</>}
              {t.scope.kind === "fkPath" && <>fkPath · {t.scope.through.length} hop(s)</>}
              {t.scope.kind === "sql"    && <span title={t.scope.predicate}>sql · custom</span>}
            </td>
            <td className="px-2 py-1">{t.verified ? "✓" : "—"}</td>
            <td className="px-2 py-1 font-mono text-fg-muted">{t.archiveTable ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function EntityHistory({ entries }: { entries: EntityRegistryHistoryEntry[] }): JSX.Element {
  if (entries.length === 0) return <div className="text-fg-muted">No history yet.</div>
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.version} className="rounded border border-border-default bg-bg-subtle p-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono">v{e.version}</span>
            {e.versionLabel && <span className="rounded bg-accent/20 px-1 text-[10px]">{e.versionLabel}</span>}
            <span className="text-fg-muted">{e.createdBy} · <Clock className="inline h-3 w-3" /> {timeAgo(e.createdAt)}</span>
          </div>
          <div className="mt-1 text-[11px] text-fg-muted">Reason: {e.reason || "—"}</div>
          {e.diff.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px]">
              {e.diff.map((d, i) => (
                <li key={i}>
                  <span className="text-accent">{d.kind}</span>
                  {d.tableName && <span className="text-fg-muted"> · {d.tableName}</span>}
                  <span className="ml-1">{d.description}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

function EntityYaml({ yaml, entityId }: { yaml: string; entityId: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-fg-muted">Server-rendered YAML for <code>{entityId}</code></span>
        <button
          type="button"
          onClick={() => {
            const blob = new Blob([yaml], { type: "application/yaml" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `${entityId}.yaml`
            a.click()
            URL.revokeObjectURL(url)
          }}
          className="ml-auto flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs hover:bg-bg-subtle"
        ><Download className="h-3 w-3" /> Download</button>
      </div>
      <pre className="flex-1 overflow-auto rounded border border-border-default bg-bg-subtle p-3 font-mono text-[11px]">{yaml}</pre>
    </div>
  )
}

// Unused import suppression for tree-shaken icons
void History

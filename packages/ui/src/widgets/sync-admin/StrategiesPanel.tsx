/**
 * StrategiesPanel — SCD2 strategy catalogue (bundled + custom).
 *
 * Lists every strategy returned by `GET /api/entity-registry/strategies`,
 * grouped by provenance. Admins can fork a bundled strategy into a
 * tenant-custom one (or edit an existing custom one) via a side-by-side
 * JSON editor.
 *
 * Why "fork"? Bundled strategies are immutable code; tenant overrides
 * are versioned data rows. Forking copies the bundled body into a new
 * tenant-scoped id so it can be edited and re-versioned without
 * touching the original.
 */

import { GitFork, Loader2, Save, X } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import { useStore } from "../../store"
import type { EntityRegistryStrategy } from "../../types"
import { DetailRow, Empty, ListItem, PanelChrome, SplitView } from "./shared"

export function StrategiesPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items,    setItems]    = useState<EntityRegistryStrategy[]>([])
  const [busy,     setBusy]     = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing,  setEditing]  = useState<EntityRegistryStrategy | null>(null)

  const sseNonce = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("entity_registry.")).length,
  )
  useEffect(() => { void load() }, [sseNonce])

  async function load(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const r = await api.listEntityRegistryStrategies()
      setItems(r.items)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const chosen = useMemo(() => items.find((s) => s.id === selected) ?? null, [items, selected])
  const groups = useMemo(() => {
    const by: Record<string, EntityRegistryStrategy[]> = {}
    for (const s of items) (by[s.provenance.kind] ??= []).push(s)
    return by
  }, [items])

  return (
    <PanelChrome
      title="SCD2 strategies"
      subtitle="Templates that govern how row history is preserved when an entity syncs."
      busy={busy} onRefresh={() => void load()} err={err} onClearErr={() => setErr(null)}
    >
      <SplitView
        list={
          items.length === 0
            ? <Empty title="No strategies loaded" />
            : <>{Object.entries(groups).map(([kind, list]) => (
                <section key={kind}>
                  <h3 className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-faint">{kind}</h3>
                  {list.map((s) => (
                    <ListItem key={s.id + ":" + s.version} active={s.id === selected}
                      onClick={() => { setSelected(s.id); setEditing(null) }}>
                      <span className="font-mono">{s.id}</span>
                      <span className="text-text-muted">{s.displayName}</span>
                      <span className="text-[10px] text-text-faint">v{s.version}</span>
                    </ListItem>
                  ))}
                </section>
              ))}</>
        }
        detail={
          !chosen ? <Empty title="Pick a strategy" />
          : editing  ? <StrategyEditor seed={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />
          :            <StrategyDetail s={chosen} isAdmin={isAdmin}
                          onFork={() => setEditing(forkOf(chosen))}
                          onEdit={() => setEditing(chosen)} />
        }
      />
    </PanelChrome>
  )
}

// ── Detail + editor ───────────────────────────────────────────────

function StrategyDetail({ s, isAdmin, onFork, onEdit }: {
  s: EntityRegistryStrategy; isAdmin: boolean; onFork: () => void; onEdit: () => void
}): JSX.Element {
  const bundled = s.provenance.kind === "bundled"
  return (
    <div className="space-y-5 p-5 text-xs">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{s.displayName}</h3>
          <p className="font-mono text-[11px] text-text-faint">{s.id} · v{s.version}</p>
        </div>
        {isAdmin && (
          bundled
            ? <button onClick={onFork} className="flex items-center gap-1 rounded border border-border-subtle bg-canvas px-2 py-1 text-[11px] hover:bg-overlay-2">
                <GitFork className="h-3 w-3" /> fork to custom
              </button>
            : <button onClick={onEdit} className="rounded bg-accent px-2 py-1 text-[11px] text-text-on-accent hover:bg-accent-hover">
                edit → new version
              </button>
        )}
      </header>
      <p className="text-text-muted">{s.description}</p>
      <section className="rounded-lg border border-border-subtle bg-panel p-4">
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">columns</h4>
        <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-1.5 font-mono">
          <DetailRow label="validFromCol"     value={s.validFromCol} />
          <DetailRow label="validToCol"       value={s.validToCol} />
          <DetailRow label="isLockedCol"      value={s.isLockedCol} />
          <DetailRow label="syncDateCol"      value={s.syncDateCol} />
          <DetailRow label="deployDateCol"    value={s.deployDateCol} />
          <DetailRow label="identityHandling" value={s.identityHandling} />
        </dl>
      </section>
      <details className="rounded-lg border border-border-subtle bg-panel p-3">
        <summary className="cursor-pointer text-text-muted">excludedFromDiffCols ({s.excludedFromDiffCols.length})</summary>
        <ul className="mt-2 list-disc pl-5 font-mono text-[11px]">{s.excludedFromDiffCols.map((c) => <li key={c}>{c}</li>)}</ul>
      </details>
      <details className="rounded-lg border border-border-subtle bg-panel p-3">
        <summary className="cursor-pointer text-text-muted">SQL expressions (onInsert / onUpdate)</summary>
        <pre className="mt-2 overflow-x-auto text-[11px]">{JSON.stringify({ onInsert: s.onInsert, onUpdate: s.onUpdate }, null, 2)}</pre>
      </details>
    </div>
  )
}

function StrategyEditor({ seed, onCancel, onSaved }: {
  seed: EntityRegistryStrategy; onCancel: () => void; onSaved: () => void
}): JSX.Element {
  const [body,   setBody]   = useState(() => JSON.stringify(seed, null, 2))
  const [reason, setReason] = useState("")
  const [busy,   setBusy]   = useState(false)
  const [err,    setErr]    = useState<string | null>(null)

  async function doSave(): Promise<void> {
    setErr(null)
    if (!reason.trim()) return setErr("reason is required")
    let parsed: EntityRegistryStrategy
    try { parsed = JSON.parse(body) as EntityRegistryStrategy }
    catch (e) { return setErr(`JSON parse error: ${(e as Error).message}`) }
    setBusy(true)
    try { await api.saveEntityRegistryStrategy(parsed, reason); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-5 text-xs">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Edit strategy — {seed.id}</h3>
        <button onClick={onCancel} className="text-text-muted hover:text-text"><X className="h-4 w-4" /></button>
      </header>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false}
        className="input min-h-[260px] flex-1 font-mono text-[11px]" />
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">reason <span className="text-rose-400">*</span></span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this change" className="input" />
      </label>
      {err && <p className="text-rose-300">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className="rounded border border-border-subtle px-3 py-1.5 text-xs hover:bg-overlay-2">cancel</button>
        <button onClick={() => void doSave()} disabled={busy}
          className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-text-on-accent hover:bg-accent-hover disabled:opacity-50">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} save new version
        </button>
      </div>
    </div>
  )
}

function forkOf(s: EntityRegistryStrategy): EntityRegistryStrategy {
  return {
    ...s,
    id:           s.id.startsWith("custom-") ? s.id : `custom-${s.id}`,
    displayName:  `${s.displayName} (custom)`,
    provenance:   { kind: "manual" },
    version:      1,
    versionLabel: "fork",
    createdBy:    "",
    createdAt:    new Date().toISOString(),
  }
}

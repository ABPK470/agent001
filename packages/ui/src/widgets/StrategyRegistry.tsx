/**
 * StrategyRegistry — admin widget for SCD2 strategy catalogue.
 *
 * Lists every strategy returned by `GET /api/entity-registry/strategies`
 * (bundled ⊕ tenant custom), groups by provenance, and lets an admin
 * fork a bundled strategy into a tenant-custom one (or edit an
 * existing custom one) via a side-by-side editor.
 *
 * The editor reads/writes the full `EntityRegistryStrategy` body — the
 * same shape the server validates with `validateScd2Strategy`. Bundled
 * strategies are read-only; the "Fork" button copies their body into
 * the editor with a fresh tenant-scoped id so the operator can save it
 * as a new custom version without colliding with the bundled row.
 */

import { GitFork, Loader2, RefreshCw, Save, Shield, X } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type { EntityRegistryStrategy } from "../types"

export function StrategyRegistry(): JSX.Element {
  const [items,    setItems]    = useState<EntityRegistryStrategy[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing,  setEditing]  = useState<EntityRegistryStrategy | null>(null)

  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  // Strategy registry change-counter — bump on every save SSE event.
  const strategyEventNonce = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("entity_registry.")).length,
  )

  useEffect(() => { void load() }, [strategyEventNonce])

  async function load(): Promise<void> {
    setLoading(true)
    setErr(null)
    try {
      const r = await api.listEntityRegistryStrategies()
      setItems(r.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const chosen = useMemo(
    () => items.find((s) => s.id === selected) ?? null,
    [items, selected],
  )

  const groups = useMemo(() => {
    const by: Record<string, EntityRegistryStrategy[]> = {}
    for (const s of items) {
      const k = s.provenance.kind
      ;(by[k] ??= []).push(s)
    }
    return by
  }, [items])

  return (
    <div className="flex h-full flex-col bg-canvas text-text">
      <header className="flex items-center justify-between border-b border-border-subtle bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">SCD2 Strategies</h2>
          <span className="text-xs text-text-muted">{items.length} total</span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text"
        >
          <RefreshCw className="h-3 w-3" /> refresh
        </button>
      </header>

      <div className="grid flex-1 grid-cols-[280px_1fr] overflow-hidden">
        <aside className="overflow-y-auto border-r border-border-subtle bg-panel">
          {loading && (
            <div className="flex items-center gap-2 p-4 text-xs text-text-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> loading…
            </div>
          )}
          {err && <div className="p-4 text-xs text-rose-300">{err}</div>}
          {Object.entries(groups).map(([kind, list]) => (
            <section key={kind}>
              <h3 className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {kind}
              </h3>
              {list.map((s) => (
                <button
                  key={s.id + ":" + s.version}
                  type="button"
                  onClick={() => { setSelected(s.id); setEditing(null) }}
                  className={[
                    "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs border-l-2",
                    s.id === selected ? "border-accent bg-overlay-2" : "border-transparent hover:bg-overlay-2",
                  ].join(" ")}
                >
                  <span className="font-mono">{s.id}</span>
                  <span className="text-text-muted">{s.displayName}</span>
                  <span className="text-[10px] text-text-faint">v{s.version}</span>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <main className="overflow-y-auto p-5 text-xs">
          {!chosen && <p className="text-text-muted">Select a strategy.</p>}
          {chosen && !editing && <StrategyDetail s={chosen} isAdmin={isAdmin} onFork={() => setEditing(forkOf(chosen))} onEdit={() => setEditing(chosen)} />}
          {chosen && editing  && <StrategyEditor seed={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />}
        </main>
      </div>
    </div>
  )
}

// ── Detail / editor ────────────────────────────────────────────────

function StrategyDetail({ s, isAdmin, onFork, onEdit }: { s: EntityRegistryStrategy; isAdmin: boolean; onFork: () => void; onEdit: () => void }): JSX.Element {
  const bundled = s.provenance.kind === "bundled"
  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{s.displayName}</h3>
          <p className="font-mono text-[11px] text-text-faint">{s.id} · v{s.version}</p>
        </div>
        {isAdmin && (
          <div className="flex gap-1.5">
            {bundled ? (
              <button type="button" onClick={onFork} className="flex items-center gap-1 rounded border border-border-subtle bg-canvas px-2 py-1 text-[11px] hover:bg-overlay-2">
                <GitFork className="h-3 w-3" /> fork to custom
              </button>
            ) : (
              <button type="button" onClick={onEdit} className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] text-text-on-accent hover:bg-accent-hover">
                edit → new version
              </button>
            )}
          </div>
        )}
      </header>
      <p className="text-text-muted">{s.description}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px]">
        <Row label="validFromCol"     v={s.validFromCol} />
        <Row label="validToCol"       v={s.validToCol} />
        <Row label="isLockedCol"      v={s.isLockedCol} />
        <Row label="syncDateCol"      v={s.syncDateCol} />
        <Row label="deployDateCol"    v={s.deployDateCol} />
        <Row label="identityHandling" v={s.identityHandling} />
      </dl>
      <details className="rounded border border-border-subtle bg-panel p-2">
        <summary className="cursor-pointer text-text-muted">excludedFromDiffCols ({s.excludedFromDiffCols.length})</summary>
        <ul className="mt-2 list-disc pl-5 font-mono">
          {s.excludedFromDiffCols.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </details>
      <details className="rounded border border-border-subtle bg-panel p-2">
        <summary className="cursor-pointer text-text-muted">onInsert / onUpdate SQL expressions</summary>
        <pre className="mt-2 overflow-x-auto text-[11px]">{JSON.stringify({ onInsert: s.onInsert, onUpdate: s.onUpdate }, null, 2)}</pre>
      </details>
    </div>
  )
}

function StrategyEditor({ seed, onCancel, onSaved }: { seed: EntityRegistryStrategy; onCancel: () => void; onSaved: () => void }): JSX.Element {
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
    try {
      await api.saveEntityRegistryStrategy(parsed, reason)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Edit strategy — {seed.id}</h3>
        <button type="button" onClick={onCancel} className="text-text-muted hover:text-text">
          <X className="h-4 w-4" />
        </button>
      </header>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={22}
        spellCheck={false}
        className="input font-mono text-[11px]"
      />
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          reason <span className="text-rose-400">*</span>
        </span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this change" className="input" />
      </label>
      {err && <p className="text-xs text-rose-300">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded border border-border-subtle px-3 py-1.5 text-xs hover:bg-overlay-2">cancel</button>
        <button
          type="button"
          onClick={() => void doSave()}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          save new version
        </button>
      </div>
    </div>
  )
}

function Row({ label, v }: { label: string; v: unknown }): JSX.Element {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text">{v === null || v === undefined ? "—" : String(v)}</dd>
    </>
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

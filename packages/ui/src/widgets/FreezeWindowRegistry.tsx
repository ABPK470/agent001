/**
 * FreezeWindowRegistry — admin widget for sync freeze windows.
 *
 * A freeze window is a tenant-scoped, time-bounded gate that blocks
 * sync executions whose entity definition opted into the window via
 * `policies.freezeWindowIds[]`. Operators need a way to create,
 * inspect, and retire windows without hand-editing the database.
 *
 * This widget is the management surface for those records. It calls
 * `GET/POST /api/sync/freeze-windows` and `DELETE /api/sync/freeze-
 * windows/:id`, validates the id against the standard registry kebab
 * regex, and converts between the `<input type="datetime-local">`
 * representation and the ISO-8601 strings the server stores.
 */

import { Calendar, Loader2, Plus, RefreshCw, Save, Trash2, X } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import type { FreezeWindow, FreezeWindowSaveRequest } from "../types"

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

export function FreezeWindowRegistry(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items,    setItems]    = useState<FreezeWindow[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing,  setEditing]  = useState<EditState | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setLoading(true); setErr(null)
    try {
      const r = await api.listFreezeWindows()
      setItems(r.items)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally    { setLoading(false) }
  }

  async function doDelete(id: string): Promise<void> {
    if (!confirm(`Delete freeze window "${id}"? This cannot be undone.`)) return
    try {
      await api.deleteFreezeWindow(id)
      if (selected === id) setSelected(null)
      void load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const chosen = useMemo(
    () => items.find((w) => w.id === selected) ?? null,
    [items, selected],
  )

  const now    = Date.now()
  const status = (w: FreezeWindow): "active" | "scheduled" | "past" => {
    const s = Date.parse(w.startsAt), e = Date.parse(w.endsAt)
    if (now < s) return "scheduled"
    if (now > e) return "past"
    return "active"
  }

  return (
    <div className="flex h-full flex-col bg-canvas text-text">
      <header className="flex items-center justify-between border-b border-border-subtle bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">Freeze Windows</h2>
          <span className="text-xs text-text-muted">{items.length}</span>
        </div>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => void load()} className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text">
            <RefreshCw className="h-3 w-3" /> refresh
          </button>
          {isAdmin && (
            <button type="button" onClick={() => { setEditing(blank()); setSelected(null) }} className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] text-text-on-accent hover:bg-accent-hover">
              <Plus className="h-3 w-3" /> new
            </button>
          )}
        </div>
      </header>

      <div className="grid flex-1 grid-cols-[300px_1fr] overflow-hidden">
        <aside className="overflow-y-auto border-r border-border-subtle bg-panel">
          {loading && <div className="flex items-center gap-2 p-4 text-xs text-text-muted"><Loader2 className="h-3 w-3 animate-spin" />loading…</div>}
          {!loading && items.length === 0 && <p className="p-4 text-xs text-text-muted">No freeze windows configured.</p>}
          {items.map((w) => {
            const st = status(w)
            return (
              <button
                key={w.id} type="button"
                onClick={() => { setSelected(w.id); setEditing(null) }}
                className={[
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs border-l-2",
                  w.id === selected ? "border-accent bg-overlay-2" : "border-transparent hover:bg-overlay-2",
                ].join(" ")}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="font-mono">{w.id}</span>
                  <StatusBadge s={st} />
                </div>
                <span className="text-text-muted">{w.displayName}</span>
                <span className="text-[10px] text-text-faint">{fmt(w.startsAt)} → {fmt(w.endsAt)}</span>
              </button>
            )
          })}
        </aside>

        <main className="overflow-y-auto p-5 text-xs">
          {err && <div className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">{err}</div>}
          {!chosen && !editing && <p className="text-text-muted">Select a freeze window or create a new one.</p>}
          {chosen && !editing && (
            <FreezeDetail w={chosen} isAdmin={isAdmin} onEdit={() => setEditing(fromExisting(chosen))} onDelete={() => void doDelete(chosen.id)} />
          )}
          {editing && (
            <FreezeEditor
              state={editing}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onSaved={(saved) => { setEditing(null); setSelected(saved.id); void load() }}
              onError={setErr}
            />
          )}
        </main>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────

function StatusBadge({ s }: { s: "active" | "scheduled" | "past" }): JSX.Element {
  const cls =
    s === "active"    ? "bg-rose-500/20  text-rose-200 border-rose-500/40"
  : s === "scheduled" ? "bg-amber-500/15 text-amber-200 border-amber-500/40"
  :                     "bg-overlay-2    text-text-muted border-border-subtle"
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{s}</span>
}

function FreezeDetail({ w, isAdmin, onEdit, onDelete }: { w: FreezeWindow; isAdmin: boolean; onEdit: () => void; onDelete: () => void }): JSX.Element {
  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{w.displayName}</h3>
          <p className="font-mono text-[11px] text-text-faint">{w.id}</p>
        </div>
        {isAdmin && (
          <div className="flex gap-1.5">
            <button type="button" onClick={onEdit} className="rounded bg-accent px-2 py-1 text-[11px] text-text-on-accent hover:bg-accent-hover">edit</button>
            <button type="button" onClick={onDelete} className="flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10">
              <Trash2 className="h-3 w-3" /> delete
            </button>
          </div>
        )}
      </header>
      {w.description && <p className="text-text-muted">{w.description}</p>}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px]">
        <Row label="startsAt"  v={fmt(w.startsAt)} />
        <Row label="endsAt"    v={fmt(w.endsAt)}   />
        <Row label="createdBy" v={w.createdBy}     />
        <Row label="createdAt" v={fmt(w.createdAt)} />
        <Row label="updatedAt" v={fmt(w.updatedAt)} />
      </dl>
    </div>
  )
}

interface EditState {
  isNew:        boolean
  id:           string
  displayName:  string
  description:  string
  startsLocal:  string  // datetime-local
  endsLocal:    string
  busy:         boolean
}

function FreezeEditor({ state, onChange, onCancel, onSaved, onError }: {
  state: EditState
  onChange: (s: EditState) => void
  onCancel: () => void
  onSaved:  (saved: FreezeWindow) => void
  onError:  (msg: string | null) => void
}): JSX.Element {
  function patch(p: Partial<EditState>): void { onChange({ ...state, ...p }) }

  async function save(): Promise<void> {
    onError(null)
    if (!ID_RE.test(state.id))            return onError(`id must match ${ID_RE} (lowercase kebab)`)
    if (!state.displayName.trim())        return onError("displayName is required")
    if (!state.startsLocal || !state.endsLocal) return onError("starts/ends required")
    const startsAt = new Date(state.startsLocal).toISOString()
    const endsAt   = new Date(state.endsLocal).toISOString()
    if (Date.parse(endsAt) <= Date.parse(startsAt)) return onError("endsAt must be after startsAt")

    const body: FreezeWindowSaveRequest = {
      id:          state.id,
      displayName: state.displayName.trim(),
      description: state.description.trim(),
      startsAt, endsAt,
    }
    patch({ busy: true })
    try {
      const saved = await api.upsertFreezeWindow(body)
      onSaved(saved)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      patch({ busy: false })
    }
  }

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{state.isNew ? "New freeze window" : `Edit ${state.id}`}</h3>
        <button type="button" onClick={onCancel} className="text-text-muted hover:text-text">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="grid grid-cols-2 gap-3">
        <Field label="id" required>
          <input value={state.id} disabled={!state.isNew} onChange={(e) => patch({ id: e.target.value })} placeholder="month-end-close" className="input font-mono" />
        </Field>
        <Field label="displayName" required>
          <input value={state.displayName} onChange={(e) => patch({ displayName: e.target.value })} className="input" />
        </Field>
        <Field label="startsAt" required>
          <input type="datetime-local" value={state.startsLocal} onChange={(e) => patch({ startsLocal: e.target.value })} className="input" />
        </Field>
        <Field label="endsAt" required>
          <input type="datetime-local" value={state.endsLocal} onChange={(e) => patch({ endsLocal: e.target.value })} className="input" />
        </Field>
        <Field label="description" wide>
          <textarea value={state.description} onChange={(e) => patch({ description: e.target.value })} rows={3} className="input" />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={state.busy} className="rounded border border-border-subtle px-3 py-1.5 text-xs hover:bg-overlay-2">cancel</button>
        <button type="button" onClick={() => void save()} disabled={state.busy}
          className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-text-on-accent hover:bg-accent-hover disabled:opacity-50">
          {state.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} save
        </button>
      </div>
    </div>
  )
}

function Field({ label, children, required, wide }: { label: string; children: JSX.Element; required?: boolean; wide?: boolean }): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 text-xs ${wide ? "col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label} {required && <span className="text-rose-400">*</span>}
      </span>
      {children}
    </label>
  )
}

function Row({ label, v }: { label: string; v: unknown }): JSX.Element {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text">{v === null || v === undefined || v === "" ? "—" : String(v)}</dd>
    </>
  )
}

// ── Helpers ────────────────────────────────────────────────────────

function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function toLocal(iso: string): string {
  // Convert ISO → "YYYY-MM-DDTHH:mm" suitable for <input type="datetime-local">
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function blank(): EditState {
  const now  = new Date()
  const soon = new Date(now.getTime() + 60 * 60 * 1000)
  return {
    isNew: true, id: "", displayName: "", description: "",
    startsLocal: toLocal(now.toISOString()),
    endsLocal:   toLocal(soon.toISOString()),
    busy: false,
  }
}

function fromExisting(w: FreezeWindow): EditState {
  return {
    isNew: false, id: w.id, displayName: w.displayName, description: w.description ?? "",
    startsLocal: toLocal(w.startsAt), endsLocal: toLocal(w.endsAt),
    busy: false,
  }
}

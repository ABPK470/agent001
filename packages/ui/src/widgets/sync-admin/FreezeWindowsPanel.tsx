/**
 * FreezeWindowsPanel — tenant freeze windows that gate sync runs.
 *
 * A freeze window is a scheduled time range during which sync runs
 * for any entity that opts into the window's id are blocked. Common
 * use cases: financial close, regulatory cutoffs, deploy freezes.
 *
 * UX notes:
 *  - The editor is a centered modal (not an in-pane card) so it can't
 *    visually compete with the registry list.
 *  - The user never types an id — it's derived from the display name
 *    so we keep the URL/audit-friendly slug while presenting only
 *    human language to the operator.
 *  - Required-ness is communicated by the disabled Save button rather
 *    than asterisks on every label.
 */

import { Calendar, Loader2, Plus, Save, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import type { FreezeWindow, FreezeWindowSaveRequest } from "../../types"
import { ModalShell } from "../entity-registry/ModalShell"
import { DetailRow, Empty, ListItem, PanelChrome, SplitView } from "./shared"

export function FreezeWindowsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items,    setItems]    = useState<FreezeWindow[]>([])
  const [busy,     setBusy]     = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing,  setEditing]  = useState<EditState | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setBusy(true); setErr(null)
    try { const r = await api.listFreezeWindows(); setItems(r.items) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function doDelete(id: string): Promise<void> {
    if (!confirm(`Delete freeze window "${id}"?`)) return
    try { await api.deleteFreezeWindow(id); if (selected === id) setSelected(null); void load() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const chosen = useMemo(() => items.find((w) => w.id === selected) ?? null, [items, selected])
  const now    = Date.now()
  const status = (w: FreezeWindow): Status => {
    const s = Date.parse(w.startsAt), e = Date.parse(w.endsAt)
    if (now < s) return "scheduled"
    if (now > e) return "past"
    return "active"
  }

  return (
    <PanelChrome
      title="Freeze windows"
      subtitle="Time ranges that block sync runs for entities that opt in."
      busy={busy} onRefresh={() => void load()} err={err} onClearErr={() => setErr(null)}
      actions={isAdmin && (
        <button onClick={() => setEditing(blank())}
          className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] text-text-on-accent hover:bg-accent-hover">
          <Plus className="h-3 w-3" /> new window
        </button>
      )}
    >
      {items.length === 0 ? (
        <Empty title="No freeze windows yet">
          {isAdmin
            ? <>A freeze window is a named time range that blocks sync runs for any entity that opts in. Click <em>New window</em> above to create one — for example, your month-end close.</>
            : <>Ask an admin to create one.</>}
        </Empty>
      ) : (
        <SplitView
          list={items.map((w) => (
            <ListItem key={w.id} active={w.id === selected} onClick={() => setSelected(w.id)}>
              <div className="flex w-full items-center justify-between">
                <span className="truncate">{w.displayName}</span>
                <StatusBadge s={status(w)} />
              </div>
              <span className="font-mono text-[10px] text-text-faint">{w.id}</span>
              <span className="text-[10px] text-text-muted">{fmt(w.startsAt)} → {fmt(w.endsAt)}</span>
            </ListItem>
          ))}
          detail={chosen
            ? <FreezeDetail w={chosen} isAdmin={isAdmin}
                onEdit={() => setEditing(fromExisting(chosen))}
                onDelete={() => void doDelete(chosen.id)} />
            : <Empty title="Pick a freeze window" />
          }
        />
      )}

      {editing && (
        <FreezeEditor
          state={editing} onChange={setEditing}
          existingIds={items.map((w) => w.id)}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => { setEditing(null); setSelected(saved.id); void load() }}
          onError={setErr}
        />
      )}
    </PanelChrome>
  )
}

// ── Detail ────────────────────────────────────────────────────────

type Status = "active" | "scheduled" | "past"

function StatusBadge({ s }: { s: Status }): JSX.Element {
  const cls =
    s === "active"    ? "bg-rose-500/20  text-rose-200  border-rose-500/40"
  : s === "scheduled" ? "bg-amber-500/15 text-amber-200 border-amber-500/40"
  :                     "bg-overlay-2    text-text-muted border-border-subtle"
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{s}</span>
}

function FreezeDetail({ w, isAdmin, onEdit, onDelete }: {
  w: FreezeWindow; isAdmin: boolean; onEdit: () => void; onDelete: () => void
}): JSX.Element {
  return (
    <div className="space-y-5 p-5 text-xs">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Calendar className="h-4 w-4 text-accent" />{w.displayName}</h3>
          <p className="font-mono text-[11px] text-text-faint">{w.id}</p>
        </div>
        {isAdmin && (
          <div className="flex gap-1.5">
            <button onClick={onEdit} className="rounded bg-accent px-2 py-1 text-[11px] text-text-on-accent hover:bg-accent-hover">edit</button>
            <button onClick={onDelete} className="flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10">
              <Trash2 className="h-3 w-3" /> delete
            </button>
          </div>
        )}
      </header>
      {w.description && <p className="text-text-muted">{w.description}</p>}
      <section className="rounded-lg border border-border-subtle bg-panel p-4">
        <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 font-mono">
          <DetailRow label="startsAt"  value={fmt(w.startsAt)} />
          <DetailRow label="endsAt"    value={fmt(w.endsAt)}   />
          <DetailRow label="createdBy" value={w.createdBy} />
          <DetailRow label="createdAt" value={fmt(w.createdAt)} />
          <DetailRow label="updatedAt" value={fmt(w.updatedAt)} />
        </dl>
      </section>
    </div>
  )
}

// ── Editor (modal) ────────────────────────────────────────────────

interface EditState {
  isNew:       boolean
  id:          string           // for new: derived from displayName; for edit: locked
  idTouched:   boolean          // user overrode the derived id
  displayName: string
  description: string
  startsLocal: string
  endsLocal:   string
  busy:        boolean
}

function FreezeEditor({ state, onChange, existingIds, onCancel, onSaved, onError }: {
  state:       EditState
  onChange:    (s: EditState) => void
  existingIds: readonly string[]
  onCancel:    () => void
  onSaved:     (saved: FreezeWindow) => void
  onError:     (msg: string | null) => void
}): JSX.Element {
  function patch(p: Partial<EditState>): void { onChange({ ...state, ...p }) }

  // Auto-derive id from displayName for new windows, until the user
  // explicitly edits the id field. Collisions get -2, -3, … suffixes.
  function onName(v: string): void {
    if (state.isNew && !state.idTouched) {
      const derived = uniquify(deriveSlug(v), existingIds)
      patch({ displayName: v, id: derived })
    } else {
      patch({ displayName: v })
    }
  }

  const missing: string | null = (() => {
    if (!state.displayName.trim())              return "Add a name"
    if (!state.startsLocal || !state.endsLocal) return "Pick start and end"
    if (!ID_RE.test(state.id))                  return "Identifier is invalid"
    if (Date.parse(state.endsLocal) <= Date.parse(state.startsLocal)) return "End must be after start"
    return null
  })()

  async function save(): Promise<void> {
    onError(null)
    if (missing) return onError(missing)
    const body: FreezeWindowSaveRequest = {
      id:          state.id,
      displayName: state.displayName.trim(),
      description: state.description.trim(),
      startsAt:    new Date(state.startsLocal).toISOString(),
      endsAt:      new Date(state.endsLocal).toISOString(),
    }
    patch({ busy: true })
    try { const saved = await api.upsertFreezeWindow(body); onSaved(saved) }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); patch({ busy: false }) }
  }

  return (
    <ModalShell
      title={state.isNew ? "New freeze window" : `Edit · ${state.displayName || state.id}`}
      onClose={onCancel}
      widthClass="max-w-xl"
      compact
      footer={
        <>
          {missing && !state.busy && (
            <span className="text-[11px] text-text-faint">{missing}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onCancel} disabled={state.busy}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text">
              Cancel
            </button>
            <button onClick={() => void save()} disabled={state.busy || missing !== null}
              title={missing ?? undefined}
              className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
              {state.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
            </button>
          </div>
        </>
      }
    >
      <div className="space-y-4 p-6 text-xs">
        <Field label="Name">
          <input
            value={state.displayName}
            onChange={(e) => onName(e.target.value)}
            placeholder="e.g. Month-end close"
            className="input py-2.5 text-sm"
            autoFocus
          />
          {state.id ? (
            <span className="mt-1 font-mono text-[10px] text-text-faint">
              identifier: {state.id}
              {state.isNew && (
                <button
                  type="button"
                  onClick={() => patch({ idTouched: !state.idTouched })}
                  className="ml-2 underline hover:text-text-muted"
                >
                  {state.idTouched ? "use auto" : "customize"}
                </button>
              )}
            </span>
          ) : null}
        </Field>

        {state.isNew && state.idTouched ? (
          <Field label="Identifier">
            <input
              value={state.id}
              onChange={(e) => patch({ id: e.target.value })}
              className="input font-mono"
            />
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <input type="datetime-local" value={state.startsLocal} onChange={(e) => patch({ startsLocal: e.target.value })} className="input" />
          </Field>
          <Field label="Ends">
            <input type="datetime-local" value={state.endsLocal} onChange={(e) => patch({ endsLocal: e.target.value })} className="input" />
          </Field>
        </div>

        <Field label="Description">
          <textarea
            value={state.description}
            onChange={(e) => patch({ description: e.target.value })}
            rows={3}
            placeholder="Why this freeze window exists"
            className="input"
          />
        </Field>
      </div>
    </ModalShell>
  )
}

function Field({ label, children }: { label: string; children: JSX.Element | (JSX.Element | false | null)[] }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  )
}

// ── Helpers ────────────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

/** Slugify a display name into a kebab-case identifier. */
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64)
}

/** Append `-2`, `-3`, … if a derived id collides with an existing one. */
function uniquify(base: string, existing: readonly string[]): string {
  if (!base || !existing.includes(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`.slice(0, 64)
    if (!existing.includes(candidate)) return candidate
  }
  return base
}

function fmt(iso: string): string { try { return new Date(iso).toLocaleString() } catch { return iso } }

function toLocal(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function blank(): EditState {
  const now  = new Date()
  const soon = new Date(now.getTime() + 60 * 60 * 1000)
  return {
    isNew: true, id: "", idTouched: false,
    displayName: "", description: "",
    startsLocal: toLocal(now.toISOString()),
    endsLocal:   toLocal(soon.toISOString()),
    busy: false,
  }
}

function fromExisting(w: FreezeWindow): EditState {
  return {
    isNew: false, id: w.id, idTouched: false,
    displayName: w.displayName, description: w.description ?? "",
    startsLocal: toLocal(w.startsAt), endsLocal: toLocal(w.endsAt),
    busy: false,
  }
}

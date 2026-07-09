/**
 * FreezeWindowsPanel — time ranges that block sync for opted-in entities.
 */

import { EventType } from "@mia/shared-enums"
import { Calendar, Loader2, Pencil, Plus, Save, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useMemo, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import type { FreezeWindow, FreezeWindowSaveRequest } from "../../types"
import {
  ConfirmModal,
  ModalBtnPrimary,
  ModalBtnSecondary,
  ModalShell,
} from "./chrome"
import {
  AdminModalCanvas,
  AdminModalRoot,
  FormFieldGroup,
  FormSectionCard,
} from "./modal-layout"
import { useConsole } from "./console-context"
import {
  ConsolePanel, DetailBody, DetailToolbar, Empty, IconAction, ItemShell, RailEmpty,
  TOOLBAR_ICON, ToolbarIconBtn, RailList, RailListItem,
} from "./shared"
import { DetailField, DetailGrid } from "../entity-registry/DetailField"
import { useLiveReload } from "./useLiveReload"

export function FreezeWindowsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { notifyError } = useConsole()

  const [items, setItems] = useState<FreezeWindow[]>([])
  const [busy, setBusy] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.listFreezeWindows()
      setItems(r.items)
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [notifyError])

  useLiveReload(load, (type) =>
    type === EventType.FreezeWindowUpserted || type === EventType.FreezeWindowDeleted,
  )

  async function doDelete(id: string): Promise<void> {
    try {
      await api.deleteFreezeWindow(id)
      if (selected === id) setSelected(null)
      void load()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }

  const chosen = useMemo(() => items.find((w) => w.id === selected) ?? null, [items, selected])
  const now = Date.now()
  const status = (w: FreezeWindow): Status => {
    const s = Date.parse(w.startsAt), e = Date.parse(w.endsAt)
    if (now < s) return "scheduled"
    if (now > e) return "past"
    return "active"
  }

  return (
    <ConsolePanel>
      <ItemShell
        busy={busy}
        listActions={isAdmin ? (
          <ToolbarIconBtn label="New freeze" onClick={() => setEditing(blank())}>
            <Plus {...TOOLBAR_ICON} />
          </ToolbarIconBtn>
        ) : undefined}
        detailToolbar={chosen ? (
          <DetailToolbar
            title={chosen.displayName}
            subtitle={chosen.id}
            actions={isAdmin ? (
              <>
                <IconAction label="Edit" onClick={() => setEditing(fromExisting(chosen))}>
                  <Pencil {...TOOLBAR_ICON} />
                </IconAction>
                <IconAction label="Delete" onClick={() => setDeleting(chosen.id)}>
                  <Trash2 {...TOOLBAR_ICON} />
                </IconAction>
              </>
            ) : undefined}
          />
        ) : undefined}
        empty={items.length === 0 ? (
          <RailEmpty title="No freeze windows">
            {isAdmin ? "Block sync during close or deploy windows." : "Ask an admin to create one."}
          </RailEmpty>
        ) : undefined}
        list={(
          <RailList label="Freeze windows">
            {items.map((w) => (
              <RailListItem
                key={w.id}
                active={w.id === selected}
                onClick={() => setSelected(w.id)}
                title={w.displayName}
                meta={w.id}
                meta2={`${fmt(w.startsAt)} → ${fmt(w.endsAt)} · ${status(w)}`}
              />
            ))}
          </RailList>
        )}
        detail={chosen
          ? <FreezeDetail w={chosen} />
          : <Empty title="Select a freeze window" />}
      />

      {editing && (
        <FreezeEditor
          state={editing} onChange={setEditing}
          existingIds={items.map((w) => w.id)}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => { setEditing(null); setSelected(saved.id); void load() }}
          onError={notifyError}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete freeze"
          message={`Delete "${deleting}"?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void doDelete(deleting).then(() => setDeleting(null))}
        />
      )}
    </ConsolePanel>
  )
}

type Status = "active" | "scheduled" | "past"

function StatusBadge({ s }: { s: Status }): JSX.Element {
  const cls =
    s === "active"    ? "bg-error-soft  text-error  border-error/30"
  : s === "scheduled" ? "bg-warning-soft text-warning border-warning/30"
  :                     "bg-overlay-2    text-text-muted border-border-subtle"
  return <span className={`rounded border px-1.5 py-0.5 text-xs uppercase tracking-wider ${cls}`}>{s}</span>
}

function FreezeDetail({ w }: { w: FreezeWindow }): JSX.Element {
  return (
    <DetailBody>
      {w.description && <p className="mb-3 text-sm text-text-muted">{w.description}</p>}
      <DetailGrid>
        <DetailField label="Starts" value={fmt(w.startsAt)} />
        <DetailField label="Ends" value={fmt(w.endsAt)} />
        <DetailField label="Created by" value={w.createdBy} />
      </DetailGrid>
    </DetailBody>
  )
}

interface EditState {
  isNew:       boolean
  id:          string
  idTouched:   boolean
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
  onError:     (msg: string) => void
}): JSX.Element {
  function patch(p: Partial<EditState>): void { onChange({ ...state, ...p }) }

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
    if (!ID_RE.test(state.id))                  return "Invalid id"
    if (Date.parse(state.endsLocal) <= Date.parse(state.startsLocal)) return "End after start"
    return null
  })()

  async function save(): Promise<void> {
    if (missing) return onError(missing)
    const body: FreezeWindowSaveRequest = {
      id:          state.id,
      displayName: state.displayName.trim(),
      description: state.description.trim(),
      startsAt:    new Date(state.startsLocal).toISOString(),
      endsAt:      new Date(state.endsLocal).toISOString(),
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
    <ModalShell
      title={state.isNew ? "New freeze" : `Edit · ${state.displayName || state.id}`}
      icon={<Calendar size={20} className="text-text-muted" />}
      size="focus"
      onClose={onCancel}
      footer={
        <>
          <ModalBtnSecondary onClick={onCancel} disabled={state.busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary disabled={state.busy || missing !== null} onClick={() => void save()}>
              {state.busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Freeze window" emphasized>
            <FormFieldGroup label="Name">
              <input
                value={state.displayName}
                onChange={(e) => onName(e.target.value)}
                placeholder="Month-end close"
                className="input w-full text-sm"
                autoFocus
              />
              {state.id ? (
                <span className="mt-1 font-mono text-xs text-text-faint">
                  id: {state.id}
                  {state.isNew && (
                    <button type="button" onClick={() => patch({ idTouched: !state.idTouched })} className="ml-2 underline hover:text-text-muted">
                      {state.idTouched ? "auto" : "custom"}
                    </button>
                  )}
                </span>
              ) : null}
            </FormFieldGroup>

            {state.isNew && state.idTouched ? (
              <FormFieldGroup label="Id">
                <input value={state.id} onChange={(e) => patch({ id: e.target.value })} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
            ) : null}
          </FormSectionCard>

          <FormSectionCard title="Active period">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Starts">
                <input type="datetime-local" value={state.startsLocal} onChange={(e) => patch({ startsLocal: e.target.value })} className="input w-full text-sm" />
              </FormFieldGroup>
              <FormFieldGroup label="Ends">
                <input type="datetime-local" value={state.endsLocal} onChange={(e) => patch({ endsLocal: e.target.value })} className="input w-full text-sm" />
              </FormFieldGroup>
            </div>
            <FormFieldGroup label="Description">
              <textarea value={state.description} onChange={(e) => patch({ description: e.target.value })} rows={2} className="input w-full text-sm" />
            </FormFieldGroup>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

function deriveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 64)
}

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

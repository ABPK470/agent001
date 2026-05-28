import { FileJson, Loader2, Pencil, RotateCcw, UploadCloud } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"

import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import type { EntityRegistrySyncFlowPreset, SyncDefinitionAdminItem, SyncDefinitionAdminReviewStatus } from "../../types"
import { Empty, ListItem, PanelChrome, SplitView } from "./shared"

const FLOW_PRESETS: EntityRegistrySyncFlowPreset[] = ["contract", "dataset", "rule", "pipelineActivity", "gateMetadata", "content", "metadata-only"]

export function DefinitionsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [items, setItems] = useState<SyncDefinitionAdminItem[]>([])
  const [busy, setBusy] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<SyncDefinitionAdminItem | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const rows = await api.listSyncDefinitionConfigs()
      setItems(rows)
      setSelected((current) => current && rows.some((item) => item.id === current) ? current : (rows[0]?.id ?? null))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function publish(): Promise<void> {
    setPublishing(true)
    setErr(null)
    setOk(null)
    try {
      const result = await api.publishSyncDefinitions()
      await load()
      setOk(`Published ${result.definitionCount} definition${result.definitionCount === 1 ? "" : "s"} · ${result.publishedVersion}`)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setPublishing(false)
    }
  }

  async function save(entityId: string, fields: Record<string, unknown>): Promise<void> {
    setSaving(entityId)
    setErr(null)
    try {
      await api.updateSyncDefinitionConfig(entityId, fields)
      await load()
      setOk(`Saved ${entityId}`)
      setTimeout(() => setOk(null), 1800)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  async function reset(entityId: string): Promise<void> {
    setSaving(entityId)
    setErr(null)
    try {
      await api.resetSyncDefinitionConfig(entityId)
      await load()
      setOk(`Reset ${entityId}`)
      setTimeout(() => setOk(null), 1800)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selected) ?? null,
    [items, selected],
  )

  return (
    <PanelChrome
      title="Runtime definitions"
      subtitle="Entity structure comes from Entity Registry. Runtime bindings and flow preset live in DB here, and publish compiles the runtime bundle from that DB state."
      busy={busy || publishing}
      onRefresh={() => void load()}
      err={err}
      ok={ok}
      onClearErr={() => setErr(null)}
      actions={isAdmin ? (
        <button
          type="button"
          onClick={() => void publish()}
          disabled={publishing}
          className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
        >
          <UploadCloud className="h-3 w-3" /> publish runtime bundle
        </button>
      ) : undefined}
    >
      {items.length === 0 ? (
        <Empty title="No sync definitions yet">
          Create entity definitions in Entity Registry first. This panel manages the runtime flow preset and binding refs that publish uses.
        </Empty>
      ) : (
        <SplitView
          list={items.map((item) => (
            <ListItem key={item.id} active={item.id === selected} onClick={() => setSelected(item.id)}>
              <span className="font-mono text-text">{item.id}</span>
              <span className="text-text-muted">{item.displayName}</span>
              <span className="text-[10px] text-text-faint">v{item.entityVersion} · {item.tableCount} tbl · {item.flowPreset}</span>
            </ListItem>
          ))}
          detail={selectedItem ? (
            <DefinitionDetail item={selectedItem} busy={saving === selectedItem.id} onEdit={() => setEditing(selectedItem)} onReset={reset} />
          ) : <Empty title="Pick a definition" />}
        />
      )}

      {editing && (
        <DefinitionEditModal
          item={editing}
          busy={saving === editing.id}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            await save(editing.id, fields)
            setEditing(null)
          }}
        />
      )}
    </PanelChrome>
  )
}

function DefinitionDetail({
  item,
  busy,
  onEdit,
  onReset,
}: {
  item: SyncDefinitionAdminItem
  busy: boolean
  onEdit: () => void
  onReset: (entityId: string) => Promise<void>
}): JSX.Element {
  return (
    <div className="space-y-4 p-5 text-xs">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <FileJson className="h-4 w-4 text-text-muted" />
          <h3 className="text-sm font-semibold text-text">{item.displayName}</h3>
        </div>
        <div className="font-mono text-[11px] text-text-faint">{item.id}</div>
      </header>

      <section className="rounded-lg border border-border-subtle bg-panel px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Detail label="Entity Registry version" value={String(item.entityVersion)} />
          <Detail label="Runtime flow preset" value={item.flowPreset} />
          <Detail label="Service profile" value={item.serviceProfileRef} />
          <Detail label="Environment policy" value={item.environmentPolicyRef} />
          <Detail label="Ownership team" value={item.ownershipTeam} />
          <Detail label="Review" value={item.reviewStatus} />
          <Detail label="Published version" value={item.publishedVersion ?? "not published yet"} />
          <Detail label="Config updated" value={`${new Date(item.updatedAt).toLocaleString()}${item.updatedBy ? ` · ${item.updatedBy}` : ""}`} />
        </div>
      </section>

      <section className="rounded-lg border border-border-subtle bg-panel px-4 py-3 text-sm leading-6 text-text-muted">
        <div>Publish compiles runtime definitions from DB only.</div>
        <div>Entity Registry owns table structure. This panel owns flow preset, binding refs, and review metadata.</div>
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} className="flex items-center gap-1 rounded border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text">
          <Pencil className="h-3.5 w-3.5" /> edit config
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onReset(item.id)}
          className="flex items-center gap-1 rounded border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" /> reset seeded defaults
        </button>
      </div>
    </div>
  )
}

function DefinitionEditModal({
  item,
  busy,
  onClose,
  onSave,
}: {
  item: SyncDefinitionAdminItem
  busy: boolean
  onClose: () => void
  onSave: (fields: Record<string, unknown>) => Promise<void>
}): JSX.Element {
  const [flowPreset, setFlowPreset] = useState<EntityRegistrySyncFlowPreset>(item.flowPreset)
  const [serviceProfileRef, setServiceProfileRef] = useState(item.serviceProfileRef)
  const [environmentPolicyRef, setEnvironmentPolicyRef] = useState(item.environmentPolicyRef)
  const [ownershipTeam, setOwnershipTeam] = useState(item.ownershipTeam)
  const [ownershipOwner, setOwnershipOwner] = useState(item.ownershipOwner ?? "")
  const [reviewStatus, setReviewStatus] = useState<SyncDefinitionAdminReviewStatus>(item.reviewStatus)
  const [ownershipNotesText, setOwnershipNotesText] = useState(item.ownershipNotes.join("\n"))

  const ownershipNotes = ownershipNotesText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const dirty =
    flowPreset !== item.flowPreset ||
    serviceProfileRef !== item.serviceProfileRef ||
    environmentPolicyRef !== item.environmentPolicyRef ||
    ownershipTeam !== item.ownershipTeam ||
    ownershipOwner !== (item.ownershipOwner ?? "") ||
    reviewStatus !== item.reviewStatus ||
    JSON.stringify(ownershipNotes) !== JSON.stringify(item.ownershipNotes)

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-text">Edit runtime definition config</h3>
            <p className="text-[11px] text-text-muted">{item.displayName} · {item.id}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-2 hover:text-text">close</button>
        </div>

        <div className="space-y-4 overflow-auto px-5 py-5 text-xs">
          <Field label="Flow preset" hint="Controls the runtime execution step sequence used when publish composes the bundle.">
            <select value={flowPreset} onChange={(event) => setFlowPreset(event.target.value as EntityRegistrySyncFlowPreset)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text">
              {FLOW_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Service profile ref" hint="Stored in DB and copied into the published runtime bundle.">
              <input value={serviceProfileRef} onChange={(event) => setServiceProfileRef(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
            <Field label="Environment policy ref" hint="Stored in DB and copied into the published runtime bundle.">
              <input value={environmentPolicyRef} onChange={(event) => setEnvironmentPolicyRef(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Ownership team" hint="Who owns this runtime definition contract.">
              <input value={ownershipTeam} onChange={(event) => setOwnershipTeam(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
            <Field label="Ownership owner" hint="Optional named owner.">
              <input value={ownershipOwner} onChange={(event) => setOwnershipOwner(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
          </div>
          <Field label="Review status" hint="Publish does not block this today, but the runtime bundle records it.">
            <div className="inline-flex rounded-lg border border-border-subtle bg-canvas p-0.5">
              {(["legacy-review-required", "reviewed"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setReviewStatus(status)}
                  className={`rounded-md px-3 py-1.5 text-[12px] transition-colors ${reviewStatus === status ? "bg-accent/15 text-accent font-medium" : "text-text-muted hover:text-text"}`}
                >
                  {status}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Ownership notes" hint="One note per line.">
            <textarea value={ownershipNotesText} onChange={(event) => setOwnershipNotesText(event.target.value)} rows={5} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
          </Field>
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-4">
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() => void onSave({
              flowPreset,
              serviceProfileRef,
              environmentPolicyRef,
              ownershipTeam,
              ownershipOwner: ownershipOwner.trim() || null,
              reviewStatus,
              ownershipNotes,
            })}
            className="flex items-center gap-1.5 rounded-lg bg-accent/20 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? "Saving…" : "Save config"}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: JSX.Element }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      {children}
      <div className="mt-1.5 text-[11px] leading-5 text-text-muted">{hint}</div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</div>
      <div className="mt-1 break-all text-text">{value}</div>
    </div>
  )
}
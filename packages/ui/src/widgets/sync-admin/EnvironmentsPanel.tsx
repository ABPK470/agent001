import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"

import { api } from "../../api"
import type { EnvOperation, SyncEnvironmentAdmin } from "../../types"
import { Empty, ListItem, PanelChrome, SplitView } from "./shared"

const ALL_OPS: EnvOperation[] = ["query_read", "schema_introspect", "sync_preview", "sync_execute", "ddl", "dml"]

export function EnvironmentsPanel(): JSX.Element {
  const [items, setItems] = useState<SyncEnvironmentAdmin[]>([])
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<SyncEnvironmentAdmin | null>(null)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const rows = await api.listSyncEnvironments()
      const sorted = [...rows].sort((a, b) => a.ringOrder - b.ringOrder || a.name.localeCompare(b.name))
      setItems(sorted)
      setSelected((current) => current && sorted.some((item) => item.name === current) ? current : (sorted[0]?.name ?? null))
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function create(fields: Record<string, unknown>): Promise<void> {
    const name = String(fields.name ?? "")
    setSaving(name || "__new__")
    setErr(null)
    try {
      await api.createSyncEnvironment(fields)
      await load()
      if (name) setSelected(name)
      setOk(`Created ${name}`)
      setTimeout(() => setOk(null), 1800)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  async function save(name: string, fields: Record<string, unknown>): Promise<void> {
    setSaving(name)
    setErr(null)
    try {
      await api.updateSyncEnvironment(name, fields)
      await load()
      setOk(`Saved ${name}`)
      setTimeout(() => setOk(null), 1800)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  async function remove(name: string): Promise<void> {
    setSaving(name)
    setErr(null)
    try {
      await api.deleteSyncEnvironment(name)
      await load()
      setOk(`Deleted ${name}`)
      setTimeout(() => setOk(null), 1800)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  const selectedItem = useMemo(() => items.find((item) => item.name === selected) ?? null, [items, selected])

  return (
    <PanelChrome
      title="Environments"
      subtitle="Persisted sync environments managed in DB. JSON is now only a one-time seed, not the live source of truth."
      busy={busy}
      onRefresh={() => void load()}
      err={err}
      ok={ok}
      onClearErr={() => setErr(null)}
      actions={(
        <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text">
          <Plus className="h-3 w-3" /> add environment
        </button>
      )}
    >
      {items.length === 0 ? (
        <Empty title="No environments configured">
          Add an environment here. The name must match a configured MSSQL connection.
        </Empty>
      ) : (
        <SplitView
          list={items.map((item) => (
            <ListItem key={item.name} active={item.name === selected} onClick={() => setSelected(item.name)}>
              <span className="font-mono text-text">{item.name}</span>
              <span className="text-text-muted">{item.displayName}</span>
              <span className="text-[10px] text-text-faint">{item.role} · {item.defaultAccessMode === "read_only" ? "read only" : "read / write"} · ring {item.ringOrder}</span>
            </ListItem>
          ))}
          detail={selectedItem ? <EnvironmentDetail item={selectedItem} busy={saving === selectedItem.name} onEdit={() => setEditing(selectedItem)} onDelete={remove} /> : <Empty title="Pick an environment" />}
        />
      )}

      {creating && (
        <EnvironmentModal
          title="Add environment"
          submitLabel="Create environment"
          busy={saving === "__new__"}
          onClose={() => setCreating(false)}
          onSave={async (fields) => {
            await create(fields)
            setCreating(false)
          }}
        />
      )}

      {editing && (
        <EnvironmentModal
          title="Edit environment"
          submitLabel="Save changes"
          env={editing}
          busy={saving === editing.name}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            await save(editing.name, fields)
            setEditing(null)
          }}
        />
      )}
    </PanelChrome>
  )
}

function EnvironmentDetail({ item, busy, onEdit, onDelete }: {
  item: SyncEnvironmentAdmin
  busy: boolean
  onEdit: () => void
  onDelete: (name: string) => Promise<void>
}): JSX.Element {
  return (
    <div className="space-y-4 p-5 text-xs">
      <section className="rounded-lg border border-border-subtle bg-panel px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Detail label="Display name" value={item.displayName} />
          <Detail label="Connection name" value={item.name} />
          <Detail label="Role" value={item.role} />
          <Detail label="Access mode" value={item.defaultAccessMode} />
          <Detail label="Ring order" value={String(item.ringOrder)} />
          <Detail label="Color token" value={item.color} />
          <Detail label="Allowed sync targets" value={item.allowedSyncTargets?.join(", ") || "none"} />
          <Detail label="Allowlist" value={item.syncAllowlist.join(", ") || "none"} />
          <Detail label="Agent service URL" value={item.agentServiceBaseUrl ?? "not set"} />
          <Detail label="ETL service URL" value={item.etlServiceBaseUrl ?? "not set"} />
          <Detail label="Gate service URL" value={item.gateServiceBaseUrl ?? "not set"} />
          <Detail label="Last updated" value={`${new Date(item.updatedAt).toLocaleString()}${item.updatedBy ? ` · ${item.updatedBy}` : ""}`} />
        </div>
      </section>

      <section className="rounded-lg border border-border-subtle bg-panel px-4 py-3 text-sm leading-6 text-text-muted">
        <div>These rows are the live sync environment records.</div>
        <div>Editing here changes persisted DB state directly; the old JSON file is no longer the runtime authority.</div>
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} className="flex items-center gap-1 rounded border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text">
          <Pencil className="h-3.5 w-3.5" /> edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDelete(item.name)}
          className="flex items-center gap-1 rounded border border-rose-500/30 px-3 py-1.5 text-[12px] text-rose-200 hover:bg-rose-500/10 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" /> delete
        </button>
      </div>
    </div>
  )
}

function EnvironmentModal({
  title,
  submitLabel,
  env,
  busy,
  onClose,
  onSave,
}: {
  title: string
  submitLabel: string
  env?: SyncEnvironmentAdmin
  busy: boolean
  onClose: () => void
  onSave: (fields: Record<string, unknown>) => Promise<void>
}): JSX.Element {
  const [name, setName] = useState(env?.name ?? "")
  const [displayName, setDisplayName] = useState(env?.displayName ?? "")
  const [color, setColor] = useState(env?.color ?? "slate")
  const [role, setRole] = useState<SyncEnvironmentAdmin["role"]>(env?.role ?? "both")
  const [ringOrder, setRingOrder] = useState(String(env?.ringOrder ?? 0))
  const [defaultAccessMode, setDefaultAccessMode] = useState<SyncEnvironmentAdmin["defaultAccessMode"]>(env?.defaultAccessMode ?? "read_write")
  const [agentServiceBaseUrl, setAgentServiceBaseUrl] = useState(env?.agentServiceBaseUrl ?? "")
  const [etlServiceBaseUrl, setEtlServiceBaseUrl] = useState(env?.etlServiceBaseUrl ?? "")
  const [gateServiceBaseUrl, setGateServiceBaseUrl] = useState(env?.gateServiceBaseUrl ?? "")
  const [denyDml, setDenyDml] = useState(env?.denyDml ?? false)
  const [denyDdl, setDenyDdl] = useState(env?.denyDdl ?? false)
  const [allowedOperations, setAllowedOperations] = useState<EnvOperation[]>(env?.allowedOperations ?? [])
  const [allowedTargetsText, setAllowedTargetsText] = useState((env?.allowedSyncTargets ?? []).join(", "))
  const [syncAllowlistText, setSyncAllowlistText] = useState((env?.syncAllowlist ?? []).join(", "))

  const allowedSyncTargets = parseCsv(allowedTargetsText)
  const syncAllowlist = parseCsv(syncAllowlistText)

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-text">{title}</h3>
            <p className="text-[11px] text-text-muted">Environment names must match configured MSSQL connection names.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-2 hover:text-text">close</button>
        </div>

        <div className="space-y-4 overflow-auto px-5 py-5 text-xs">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Connection name" hint="Required. Must match a configured MSSQL connection.">
              <input value={name} disabled={Boolean(env)} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text disabled:opacity-50" />
            </Field>
            <Field label="Display name" hint="Human-friendly label shown in UI.">
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Field label="Color token" hint="Free-form accent token for UI rendering.">
              <input value={color} onChange={(event) => setColor(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
            <Field label="Role" hint="Whether this environment can be source, target, or both.">
              <select value={role} onChange={(event) => setRole(event.target.value as SyncEnvironmentAdmin["role"])} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text">
                <option value="source">source</option>
                <option value="target">target</option>
                <option value="both">both</option>
              </select>
            </Field>
            <Field label="Ring order" hint="Lower numbers are earlier in the promotion path.">
              <input value={ringOrder} onChange={(event) => setRingOrder(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Default access mode" hint="Read-only blocks write tools unless explicitly allowed.">
              <select value={defaultAccessMode} onChange={(event) => setDefaultAccessMode(event.target.value as SyncEnvironmentAdmin["defaultAccessMode"])} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text">
                <option value="read_only">read_only</option>
                <option value="read_write">read_write</option>
              </select>
            </Field>
            <Field label="Allowed operations" hint="Operations permitted after access mode and deny flags are applied.">
              <div className="flex flex-wrap gap-2 rounded-lg border border-border-subtle bg-canvas px-3 py-2">
                {ALL_OPS.map((op) => {
                  const selected = allowedOperations.includes(op)
                  return (
                    <button
                      key={op}
                      type="button"
                      onClick={() => setAllowedOperations((current) => selected ? current.filter((item) => item !== op) : [...current, op])}
                      className={`rounded-full border px-2 py-1 text-[11px] ${selected ? "border-accent bg-accent/10 text-accent" : "border-border-subtle text-text-muted hover:text-text"}`}
                    >
                      {op}
                    </button>
                  )
                })}
              </div>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Toggle label="Block DML" checked={denyDml} onChange={setDenyDml} />
            <Toggle label="Block DDL" checked={denyDdl} onChange={setDenyDdl} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Field label="Agent service URL" hint="Optional direct base URL used for post-sync callbacks.">
              <input value={agentServiceBaseUrl} onChange={(event) => setAgentServiceBaseUrl(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
            <Field label="ETL service URL" hint="Optional direct base URL used for dataset/rule deployment callbacks.">
              <input value={etlServiceBaseUrl} onChange={(event) => setEtlServiceBaseUrl(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
            <Field label="Gate service URL" hint="Optional direct base URL used for gate refresh callbacks.">
              <input value={gateServiceBaseUrl} onChange={(event) => setGateServiceBaseUrl(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field label="Allowed sync targets" hint="Comma-separated environment names.">
              <textarea value={allowedTargetsText} onChange={(event) => setAllowedTargetsText(event.target.value)} rows={3} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
            <Field label="Sync allowlist" hint="Comma-separated entity ids allowed in this environment.">
              <textarea value={syncAllowlistText} onChange={(event) => setSyncAllowlistText(event.target.value)} rows={3} className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[12.5px] text-text" />
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-4">
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void onSave({
              name: name.trim(),
              displayName: displayName.trim() || name.trim(),
              color: color.trim() || "slate",
              role,
              ringOrder: Number(ringOrder || 0),
              defaultAccessMode,
              agentServiceBaseUrl: agentServiceBaseUrl.trim() || null,
              etlServiceBaseUrl: etlServiceBaseUrl.trim() || null,
              gateServiceBaseUrl: gateServiceBaseUrl.trim() || null,
              denyDml,
              denyDdl,
              allowedOperations,
              approvalRequiredOperations: [],
              allowedSyncTargets,
              syncAllowlist,
            })}
            className="flex items-center gap-1.5 rounded-lg bg-accent/20 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? "Saving…" : submitLabel}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-border-subtle px-3 py-1.5 text-[12px] text-text-muted hover:bg-overlay-2 hover:text-text">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      {children}
      <div className="mt-1.5 text-[11px] leading-5 text-text-muted">{hint}</div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <button type="button" onClick={() => onChange(!checked)} className={`rounded-full border px-3 py-1.5 text-[11px] ${checked ? "border-accent bg-accent/10 text-accent" : "border-border-subtle text-text-muted hover:text-text"}`}>
      {label}
    </button>
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

function parseCsv(text: string): string[] {
  return text.split(",").map((entry) => entry.trim()).filter(Boolean)
}

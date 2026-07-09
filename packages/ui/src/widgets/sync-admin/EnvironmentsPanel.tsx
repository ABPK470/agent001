import { EventType } from "@mia/shared-enums"
import {
  Database, Pencil, Plus, Trash2,
} from "lucide-react"
import { Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { SyncEnvironmentAdmin } from "../../types"
import {
  ConfirmModal,
  ModalBtnPrimary,
  ModalBtnSecondary,
  ModalShell,
} from "./chrome"
import { useConsole } from "./console-context"
import {
  AdminModalCanvas,
  AdminModalRoot,
  FormFieldGroup,
  FormSectionCard,
} from "./modal-layout"
import {
  ConsolePanel, DetailBody, DetailToolbar, Empty, FormCheck, IconAction,
  ItemShell, TOOLBAR_ICON, ToolbarIconBtn, RailEmpty, RailList, RailListItem,
} from "./shared"
import { DetailField, DetailGrid } from "../entity-registry/DetailField"
import { useLiveReload } from "./useLiveReload"

import {
  deriveAllowedOperations,
  denyFlagsForAccessMode,
  OP_LABELS,
  suggestAccessForName,
} from "./env-access"
const ROLE_OPTIONS: ListboxOption<SyncEnvironmentAdmin["role"]>[] = [
  { value: "source", label: "source" },
  { value: "target", label: "target" },
  { value: "both", label: "both" },
]
const ACCESS_MODE_OPTIONS: ListboxOption<SyncEnvironmentAdmin["defaultAccessMode"]>[] = [
  { value: "read_only", label: "read_only" },
  { value: "read_write", label: "read_write" },
]

function envSseMatch(type: string): boolean {
  return type === EventType.SyncEnvUpdate || type === EventType.SyncEnvReset
}

export function EnvironmentsPanel(): JSX.Element {
  const { notify, notifyError } = useConsole()
  const [items, setItems] = useState<SyncEnvironmentAdmin[]>([])
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<SyncEnvironmentAdmin | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const loadingRef = useRef(false)
  const queuedRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (loadingRef.current) {
      queuedRef.current = true
      return
    }
    loadingRef.current = true
    setBusy(true)
    try {
      const rows = await api.listSyncEnvironments()
      const sorted = [...rows].sort((a, b) => a.ringOrder - b.ringOrder || a.name.localeCompare(b.name))
      setItems(sorted)
      setSelected((current) => current && sorted.some((item) => item.name === current) ? current : (sorted[0]?.name ?? null))
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      loadingRef.current = false
      if (queuedRef.current) {
        queuedRef.current = false
        void load()
      }
    }
  }, [notifyError])

  useLiveReload(load, envSseMatch)

  async function create(fields: Record<string, unknown>): Promise<void> {
    const name = String(fields.name ?? "")
    setSaving(name || "__new__")
    try {
      await api.createSyncEnvironment(fields)
      await load()
      if (name) setSelected(name)
      notify(`Created ${name}`)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  async function save(name: string, fields: Record<string, unknown>): Promise<void> {
    setSaving(name)
    try {
      await api.updateSyncEnvironment(name, fields)
      await load()
      notify(`Saved ${name}`)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  async function remove(name: string): Promise<void> {
    setSaving(name)
    try {
      await api.deleteSyncEnvironment(name)
      await load()
      notify(`Deleted ${name}`)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(null)
    }
  }

  const selectedItem = useMemo(() => items.find((item) => item.name === selected) ?? null, [items, selected])

  return (
    <ConsolePanel>
      <ItemShell
        busy={busy}
        listActions={(
          <ToolbarIconBtn label="Add connection" onClick={() => setCreating(true)}>
            <Plus {...TOOLBAR_ICON} />
          </ToolbarIconBtn>
        )}
        detailToolbar={selectedItem ? (
          <DetailToolbar
            title={selectedItem.name}
            subtitle={selectedItem.displayName}
            actions={(
              <>
                <IconAction label="Edit" onClick={() => setEditing(selectedItem)}><Pencil {...TOOLBAR_ICON} /></IconAction>
                <IconAction label="Delete" disabled={saving === selectedItem.name} onClick={() => setDeleting(selectedItem.name)}>
                  <Trash2 {...TOOLBAR_ICON} />
                </IconAction>
              </>
            )}
          />
        ) : undefined}
        empty={items.length === 0 ? (
          <RailEmpty title="No connections">Add a target matching MSSQL in .env</RailEmpty>
        ) : undefined}
        list={(
          <RailList label="Connections">
            {items.map((item) => (
              <RailListItem
                key={item.name}
                active={item.name === selected}
                onClick={() => setSelected(item.name)}
                title={item.name}
                meta={item.displayName}
                meta2={`ring ${item.ringOrder} · ${item.role}`}
              />
            ))}
          </RailList>
        )}
        detail={selectedItem
          ? <EnvironmentDetail item={selectedItem} />
          : <Empty title="Select a connection" />}
      />

      {creating && (
        <EnvironmentModal
          title="Add connection"
          submitLabel="Create"
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
          title="Edit connection"
          submitLabel="Save"
          env={editing}
          busy={saving === editing.name}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            await save(editing.name, fields)
            setEditing(null)
          }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete connection"
          message={`Delete "${deleting}"?`}
          confirmLabel="Delete"
          danger
          busy={saving === deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting).then(() => setDeleting(null))}
        />
      )}
    </ConsolePanel>
  )
}

function EnvironmentDetail({ item }: {
  item: SyncEnvironmentAdmin
}): JSX.Element {
  const accessLabel = item.defaultAccessMode === "read_only" ? "read only" : "read / write"

  return (
    <DetailBody>
      <DetailGrid>
        <DetailField label="Role" value={item.role} mono />
        <DetailField label="Access" value={accessLabel} />
        <DetailField label="Ring" value={String(item.ringOrder)} mono />
        <DetailField label="Targets" value={item.allowedSyncTargets?.join(", ") || "none"} mono span={2} />
        <DetailField label="Allowlist" value={item.syncAllowlist.join(", ") || "none"} mono span={2} />
        <DetailField
          label="Write blocks"
          value={`${item.denyDml ? "DML" : "—"} · ${item.denyDdl ? "DDL" : "—"}`}
        />
        <DetailField label="Agent URL" value={item.agentServiceBaseUrl} mono span={2} />
        <DetailField label="ETL URL" value={item.etlServiceBaseUrl} mono span={2} />
        <DetailField label="Gate URL" value={item.gateServiceBaseUrl} mono span={2} />
      </DetailGrid>
      <p className="mt-4 text-xs text-text-faint">
        updated {new Date(item.updatedAt).toLocaleString()}{item.updatedBy ? ` · ${item.updatedBy}` : ""}
      </p>
    </DetailBody>
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
  const [allowedTargetsText, setAllowedTargetsText] = useState((env?.allowedSyncTargets ?? []).join(", "))
  const [syncAllowlistText, setSyncAllowlistText] = useState((env?.syncAllowlist ?? []).join(", "))

  const effectiveOps = useMemo(
    () => deriveAllowedOperations(defaultAccessMode, denyDml, denyDdl),
    [defaultAccessMode, denyDml, denyDdl],
  )

  useEffect(() => {
    if (env || !name.trim()) return
    const suggested = suggestAccessForName(name.trim())
    setDefaultAccessMode(suggested.defaultAccessMode)
    setDenyDml(suggested.denyDml)
    setDenyDdl(suggested.denyDdl)
  }, [name, env])

  function onAccessModeChange(mode: SyncEnvironmentAdmin["defaultAccessMode"]): void {
    setDefaultAccessMode(mode)
    const flags = denyFlagsForAccessMode(mode)
    setDenyDml(flags.denyDml)
    setDenyDdl(flags.denyDdl)
  }

  const allowedSyncTargets = parseCsv(allowedTargetsText)
  const syncAllowlist = parseCsv(syncAllowlistText)
  const readOnly = defaultAccessMode === "read_only"

  return (
    <ModalShell
      title={title}
      subtitle="Name must match MSSQL_DATABASES"
      icon={<Database size={20} className="text-text-muted" />}
      size="focus"
      onClose={onClose}
      footer={
        <>
          <ModalBtnSecondary onClick={onClose} disabled={busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary
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
                allowedOperations: effectiveOps,
                approvalRequiredOperations: [],
                allowedSyncTargets,
                syncAllowlist,
              })}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {busy ? "Saving…" : submitLabel}
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <AdminModalRoot>
        <AdminModalCanvas>
          <FormSectionCard title="Identity" description="Name must match MSSQL_DATABASES in .env.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Name">
                <input value={name} disabled={Boolean(env)} onChange={(event) => setName(event.target.value)} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
              <FormFieldGroup label="Display name">
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="input w-full text-sm" />
              </FormFieldGroup>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormFieldGroup label="Color">
                <input value={color} onChange={(event) => setColor(event.target.value)} className="input w-full text-sm" />
              </FormFieldGroup>
              <FormFieldGroup label="Role">
                <Listbox value={role} options={ROLE_OPTIONS} onChange={setRole} size="sm" className="w-full" ariaLabel="Role" />
              </FormFieldGroup>
              <FormFieldGroup label="Ring">
                <input value={ringOrder} onChange={(event) => setRingOrder(event.target.value)} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
            </div>
          </FormSectionCard>

          <FormSectionCard title="Access" description="Default access mode and write blocks for this connection.">
            <FormFieldGroup label="Access mode">
              <Listbox value={defaultAccessMode} options={ACCESS_MODE_OPTIONS} onChange={onAccessModeChange} size="sm" className="w-full" ariaLabel="Access" />
            </FormFieldGroup>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormCheck label="Block DML" checked={denyDml} disabled={readOnly} onChange={setDenyDml} />
              <FormCheck label="Block DDL" checked={denyDdl} disabled={readOnly} onChange={setDenyDdl} />
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {effectiveOps.map((op) => (
                <span key={op} className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent" title={OP_LABELS[op]}>
                  {op}
                </span>
              ))}
            </div>
          </FormSectionCard>

          <FormSectionCard title="Service URLs" description="Optional endpoints for agent, ETL, and gate services.">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <FormFieldGroup label="Agent URL">
                <input value={agentServiceBaseUrl} onChange={(event) => setAgentServiceBaseUrl(event.target.value)} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
              <FormFieldGroup label="ETL URL">
                <input value={etlServiceBaseUrl} onChange={(event) => setEtlServiceBaseUrl(event.target.value)} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
              <FormFieldGroup label="Gate URL">
                <input value={gateServiceBaseUrl} onChange={(event) => setGateServiceBaseUrl(event.target.value)} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
            </div>
          </FormSectionCard>

          <FormSectionCard title="Sync scope">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldGroup label="Sync targets" hint="Comma-separated connection names">
                <textarea value={allowedTargetsText} onChange={(event) => setAllowedTargetsText(event.target.value)} rows={3} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
              <FormFieldGroup label="Entity allowlist" hint="Comma-separated entity ids">
                <textarea value={syncAllowlistText} onChange={(event) => setSyncAllowlistText(event.target.value)} rows={3} className="input w-full font-mono text-sm" />
              </FormFieldGroup>
            </div>
          </FormSectionCard>
        </AdminModalCanvas>
      </AdminModalRoot>
    </ModalShell>
  )
}

function parseCsv(text: string): string[] {
  return text.split(",").map((entry) => entry.trim()).filter(Boolean)
}

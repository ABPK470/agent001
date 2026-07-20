/**
 * ConnectorsShell — manage external data-source connectors.
 *
 * Layout mirrors the entity-registry Configuration modal: a top tab bar
 * (Connectors / Types), a left searchable list, and a right FormSectionCard
 * form. All enabled kinds are creatable; Hive stays greyed-out until its thrift binding lands.
 */

import { Download, Plus, Save, Search, Trash2, Upload, X } from "lucide-react"
import { useCallback, useMemo, useRef, useState, type JSX } from "react"
import { LabeledCheckbox } from "../../components/Checkbox"
import { EmptyState } from "../../components/EmptyState"
import {
  CONNECTOR_KINDS,
  getConnectorKind,
  SECRET_MASK,
  toConnectorId,
  validateConnectorConfig,
  type ConnectorAdmin,
  type ConnectorKindId,
} from "@mia/shared-types"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ConfirmModal } from "../sync-admin/chrome"
import {
  FORM_HEADING,
  HELP_TEXT,
  ICON_BTN,
  ICON_BTN_PRIMARY,
  META_TEXT,
  PANEL,
  TAB_PILL,
  TAB_PILL_ACTIVE,
  TAB_PILL_IDLE,
  TEXT_BTN,
  TEXT_BTN_PRIMARY,
  WIDGET_ENVELOPE,
} from "../entity-registry/chrome"
import { FormFieldGroup, FormSectionCard } from "../entity-registry/form-section"
import { ModalShell } from "../entity-registry/ModalShell"
import { ModalToastStack, useModalToasts } from "../entity-registry/ModalToastStack"
import { CONNECTOR_ICON } from "./kind-icon"
import { ConnectorKindMark } from "./ConnectorKindMark"
import {
  cloneConnectorFormSnapshot,
  connectorFormFromAdmin,
  connectorFormToPayload,
  emptyConnectorFormSnapshot,
  type ConfigValue,
  type ConnectorFormSnapshot,
} from "./connector-form-model"
import { ConnectorsImportGate } from "./ConnectorsImportGate"
import { useConnectors } from "./useConnectors"

type View = "connectors" | "types"
type FormMode = "create" | "edit"

const NAV_VIEWS: Array<{ view: View; label: string }> = [
  { view: "connectors", label: "Connectors" },
  { view: "types", label: "Types" },
]

const VIEW_DESCRIPTIONS: Record<View, string> = {
  connectors: "Managed connections to external data sources. Hive is the only kind still on the roadmap.",
  types: "The connector kind catalogue. Each kind declares its own config fields. Hive is greyed-out until its runtime binding lands.",
}

function kindOptions(current: ConnectorKindId): ListboxOption<ConnectorKindId>[] {
  return CONNECTOR_KINDS.map((kind) => ({
    value: kind.id,
    label: kind.displayName,
    hint: kind.enabled ? null : "Planned",
    disabled: !kind.enabled && kind.id !== current,
  }))
}

export function ConnectorsShell(): JSX.Element {
  const [view, setView] = useState<View>("connectors")
  const [listQuery, setListQuery] = useState("")
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<FormMode>("create")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectorFormSnapshot>(() => emptyConnectorFormSnapshot("mssql"))
  const [baseline, setBaseline] = useState<ConnectorFormSnapshot>(() => emptyConnectorFormSnapshot("mssql"))
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false)
  const [importGateOpen, setImportGateOpen] = useState(false)
  const { toasts, pushToast, dismissToast, clearToasts } = useModalToasts()

  const connectors = useConnectors(
    () => { /* CRUD success: list reload is enough */ },
    (message) => pushToast(message),
    true,
  )

  const formRef = useRef(form)
  formRef.current = form
  const patch = useCallback(
    (fields: Partial<ConnectorFormSnapshot>) => setForm({ ...formRef.current, ...fields }),
    [],
  )

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  )

  const kind = getConnectorKind(form.kind) ?? CONNECTOR_KINDS[0]!
  const kindDisabled = !kind.enabled

  function closeForm(): void {
    setFormOpen(false)
    setConfirmSaveOpen(false)
    setFormMode("create")
    setEditingId(null)
    const snapshot = emptyConnectorFormSnapshot("mssql")
    setForm(snapshot)
    setBaseline(cloneConnectorFormSnapshot(snapshot))
  }

  function startCreate(): void {
    const snapshot = emptyConnectorFormSnapshot("mssql")
    setFormOpen(true)
    setFormMode("create")
    setEditingId(null)
    setForm(snapshot)
    setBaseline(cloneConnectorFormSnapshot(snapshot))
  }

  function startEdit(item: ConnectorAdmin): void {
    const snapshot = connectorFormFromAdmin(item)
    setFormOpen(true)
    setFormMode("edit")
    setEditingId(item.id)
    setForm(snapshot)
    setBaseline(cloneConnectorFormSnapshot(snapshot))
  }

  function onKindChange(next: ConnectorKindId): void {
    const nextKind = getConnectorKind(next)
    if (!nextKind || (!nextKind.enabled && formMode === "create")) return
    setForm({
      ...formRef.current,
      kind: next,
      config: emptyConnectorFormSnapshot(next).config,
    })
  }

  function onNameChange(name: string): void {
    const next: ConnectorFormSnapshot = { ...formRef.current, name }
    if (formMode === "create") next.id = toConnectorId(name)
    setForm(next)
  }

  function requestSave(): void {
    if (!formOpen) return
    if (!form.name.trim()) {
      pushToast("Name is required.")
      return
    }
    if (kindDisabled) {
      pushToast(`Connector kind "${kind.displayName}" is not enabled yet.`)
      return
    }
    const validation = validateConnectorConfig(form.kind, form.config)
    if (!validation.ok) {
      pushToast(validation.error ?? "Config is invalid.")
      return
    }
    setConfirmSaveOpen(true)
  }

  async function commitSave(): Promise<void> {
    setConfirmSaveOpen(false)
    clearToasts()
    const payload = connectorFormToPayload(form)
    if (formMode === "create") {
      const id = await connectors.create(payload)
      if (id) {
        setFormMode("edit")
        setEditingId(id)
        setBaseline(cloneConnectorFormSnapshot(form))
      }
    } else if (editingId) {
      const ok = await connectors.save(editingId, payload)
      if (ok) setBaseline(cloneConnectorFormSnapshot(form))
    }
  }

  async function remove(id: string): Promise<void> {
    const ok = await connectors.remove(id)
    if (ok && editingId === id) closeForm()
  }

  async function exportConnectorsFile(): Promise<void> {
    clearToasts()
    const ok = await connectors.exportFile()
    if (ok) pushToast("Downloaded connectors.json", "ok")
  }

  const headerDescription = VIEW_DESCRIPTIONS[view]
  const trimmedQuery = listQuery.trim().toLowerCase()
  const filteredItems = trimmedQuery
    ? connectors.items.filter(
        (c) =>
          c.id.toLowerCase().includes(trimmedQuery) ||
          c.name.toLowerCase().includes(trimmedQuery) ||
          c.displayName.toLowerCase().includes(trimmedQuery),
      )
    : connectors.items

  return (
    <>
      <div className="connectors flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel p-3">
        <div className={WIDGET_ENVELOPE}>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ModalToastStack toasts={toasts} onDismiss={dismissToast} />
            <div className="shrink-0 space-y-2 border-b border-border-subtle px-5 py-3">
              <div className="flex h-9 items-center justify-between gap-3">
                <div className="inline-flex items-center gap-1" role="tablist" aria-label="Connectors sections">
                  {NAV_VIEWS.map((entry) => {
                    const active = view === entry.view
                    return (
                      <button
                        key={entry.view}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => { setView(entry.view); setListQuery("") }}
                        className={[TAB_PILL, active ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
                      >
                        {entry.label}
                      </button>
                    )
                  })}
                </div>
                {/* Always reserve the Connectors action cluster so Types does not reflow the header. */}
                <div
                  className={`flex shrink-0 items-center gap-1.5 ${view === "types" ? "invisible" : ""}`}
                  aria-hidden={view === "types"}
                >
                  <button
                    type="button"
                    onClick={() => setImportGateOpen(true)}
                    disabled={view !== "connectors" || connectors.busy || connectors.saving !== null}
                    tabIndex={view === "connectors" ? undefined : -1}
                    className={ICON_BTN}
                    title="Import connectors.json from this device"
                    aria-label="Import connectors.json"
                  >
                    <Upload size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void exportConnectorsFile()}
                    disabled={view !== "connectors" || connectors.busy || connectors.saving !== null}
                    tabIndex={view === "connectors" ? undefined : -1}
                    className={ICON_BTN}
                    title="Export connectors.json to this device (includes secrets)"
                    aria-label="Export connectors.json"
                  >
                    <Download size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={startCreate}
                    disabled={view !== "connectors"}
                    tabIndex={view === "connectors" ? undefined : -1}
                    className={ICON_BTN}
                    title="New connector"
                    aria-label="New connector"
                  >
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={requestSave}
                    disabled={
                      view !== "connectors" ||
                      connectors.saving !== null ||
                      !formOpen ||
                      !form.name.trim() ||
                      kindDisabled
                    }
                    tabIndex={view === "connectors" ? undefined : -1}
                    className={ICON_BTN_PRIMARY}
                    title={isDirty ? "Save unsaved changes" : "Save"}
                    aria-label="Save"
                  >
                    <Save size={16} />
                  </button>
                </div>
              </div>
              <p className={`${META_TEXT} min-h-[2.75rem] max-w-3xl leading-relaxed text-text-faint`}>
                {headerDescription}
              </p>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,auto)_minmax(0,1fr)] gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:grid-rows-1">
              <div className="flex min-h-0 max-h-[min(50dvh,22rem)] flex-col overflow-hidden border-b border-border-subtle p-5 lg:max-h-none lg:border-b-0 lg:border-r">
                {view === "connectors" ? (
                  <ConnectorList
                    items={filteredItems}
                    allCount={connectors.items.length}
                    query={listQuery}
                    onQueryChange={setListQuery}
                    selectedId={formOpen && formMode === "edit" ? editingId : null}
                    onSelect={(id) => {
                      const item = connectors.items.find((c) => c.id === id)
                      if (item) startEdit(item)
                    }}
                    onDelete={(id) => connectors.setDeleting(id)}
                  />
                ) : (
                  <KindList query={listQuery} onQueryChange={setListQuery} />
                )}
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {view === "connectors" && formOpen ? (
                  <>
                    <div className="shrink-0 border-b border-border-subtle bg-elevated/40 px-5 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                        Connectors · {formMode === "create" ? "New" : "Edit"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <h3 className={FORM_HEADING}>
                          {form.displayName.trim() || form.name.trim() || "New connector"}
                        </h3>
                        {isDirty && (
                          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-400/90">Unsaved</span>
                        )}
                      </div>
                      {formMode === "edit" && editingId && (
                        <p className={`${META_TEXT} mt-1 font-mono`}>{editingId}</p>
                      )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto bg-base/20 p-5">
                      <ConnectorForm
                        form={form}
                        mode={formMode}
                        onPatch={patch}
                        onKindChange={onKindChange}
                        onNameChange={onNameChange}
                      />
                    </div>
                  </>
                ) : view === "connectors" ? (
                  <EmptyState
                    icon={CONNECTOR_ICON}
                    message="Nothing selected"
                    className="bg-base/20"
                    detail={(
                      <>
                        Choose a connector from the list, or click{" "}
                        <Plus className="mx-0.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
                        {" "}to add a new one.
                      </>
                    )}
                  />
                ) : (
                  <KindDetail />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {confirmSaveOpen && (
        <ModalShell
          title={formMode === "create" ? "Create connector?" : "Save connector changes?"}
          subtitle={form.displayName.trim() || form.name.trim() || undefined}
          size="detail"
          stackLevel={1}
          onClose={() => setConfirmSaveOpen(false)}
          footer={(
            <div className="flex w-full flex-wrap items-center gap-2">
              {isDirty && (
                <button
                  type="button"
                  onClick={() => { setForm(cloneConnectorFormSnapshot(baseline)); setConfirmSaveOpen(false) }}
                  disabled={connectors.saving !== null}
                  className={`${TEXT_BTN} text-rose-400 hover:text-rose-300`}
                >
                  Discard changes
                </button>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => setConfirmSaveOpen(false)} disabled={connectors.saving !== null} className={TEXT_BTN}>
                  Keep editing
                </button>
                <button type="button" onClick={() => void commitSave()} disabled={connectors.saving !== null} className={TEXT_BTN_PRIMARY}>
                  {formMode === "create" ? "Create" : "Save changes"}
                </button>
              </div>
            </div>
          )}
        >
          <p className="p-5 text-sm leading-relaxed text-text-muted">
            {formMode === "create"
              ? `Create ${kind.displayName} connector "${form.name.trim()}"?`
              : `Write changes to connector "${form.name.trim()}"?`}
          </p>
        </ModalShell>
      )}

      {importGateOpen && (
        <ConnectorsImportGate
          onClose={() => setImportGateOpen(false)}
          onImported={() => {
            setImportGateOpen(false)
            closeForm()
            void connectors.load()
            pushToast("Imported connectors.json", "ok")
          }}
        />
      )}

      {connectors.deleting && (
        <ConfirmModal
          title="Delete connector"
          message={`Delete "${connectors.deleting}"?`}
          confirmLabel="Delete"
          danger
          busy={connectors.saving === connectors.deleting}
          stackLevel={1}
          onCancel={() => connectors.setDeleting(null)}
          onConfirm={() => void remove(connectors.deleting!).then(() => connectors.setDeleting(null))}
        />
      )}
    </>
  )
}

function ConnectorList({
  items,
  allCount,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  onDelete,
}: {
  items: ConnectorAdmin[]
  allCount: number
  query: string
  onQueryChange: (q: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const trimmed = query.trim().toLowerCase()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="input flex shrink-0 items-center gap-2 py-0 pl-2.5 pr-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
        <input
          type="text"
          role="searchbox"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search connectors…"
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm outline-none focus:ring-0"
          aria-label="Search connectors"
        />
        {query ? (
          <button type="button" onClick={() => onQueryChange("")} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-elevated hover:text-text" aria-label="Clear filter">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" aria-hidden />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <p className="text-sm text-text-muted">Empty.</p>
        ) : (
          <ul className={PANEL}>
            {items.map((item, index) => (
                <li
                  key={item.id}
                  className={[
                    "flex items-center gap-2 px-3 py-2 text-sm",
                    index < items.length - 1 ? "border-b border-border/20" : "",
                    selectedId === item.id ? "bg-elevated" : "",
                  ].join(" ")}
                >
                  <button type="button" onClick={() => onSelect(item.id)} className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ConnectorKindMark kind={item.kind} size={14} title={item.displayName} />
                      <span className="min-w-0 truncate font-medium text-text">{item.displayName}</span>
                    </span>
                    <span className={`font-mono ${META_TEXT}`}>{item.id} · {item.kind}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {!item.enabled && <span className={`shrink-0 ${META_TEXT} text-text-faint`}>Disabled</span>}
                    <button type="button" onClick={() => onDelete(item.id)} className={`${ICON_BTN} h-8 w-8 shrink-0`} title="Delete" aria-label="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
            ))}
          </ul>
        )}
      </div>
      {trimmed && items.length > 0 && items.length < allCount && (
        <p className={`shrink-0 ${META_TEXT} text-text-faint`}>{items.length} of {allCount}</p>
      )}
    </div>
  )
}

function KindList({
  query,
  onQueryChange,
}: {
  query: string
  onQueryChange: (q: string) => void
}): JSX.Element {
  const trimmed = query.trim().toLowerCase()
  const kinds = trimmed
    ? CONNECTOR_KINDS.filter(
        (k) =>
          k.id.toLowerCase().includes(trimmed) ||
          k.displayName.toLowerCase().includes(trimmed),
      )
    : CONNECTOR_KINDS

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="input flex shrink-0 items-center gap-2 py-0 pl-2.5 pr-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
        <input
          type="text"
          role="searchbox"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search types…"
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm outline-none focus:ring-0"
          aria-label="Search types"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-elevated hover:text-text"
            aria-label="Clear filter"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" aria-hidden />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {kinds.length === 0 ? (
          <p className="text-sm text-text-muted">Empty.</p>
        ) : (
          <ul className={PANEL}>
            {kinds.map((k, index) => (
              <li
                key={k.id}
                className={[
                  "flex items-center gap-2 px-3 py-2 text-sm",
                  index < kinds.length - 1 ? "border-b border-border/20" : "",
                  k.enabled ? "" : "opacity-50",
                ].join(" ")}
              >
                <ConnectorKindMark kind={k.id} size={14} title={k.displayName} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate font-medium text-text">{k.displayName}</span>
                  <span className={`font-mono ${META_TEXT}`}>{k.id}</span>
                </div>
                {k.enabled ? (
                  <span className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
                    Active
                  </span>
                ) : (
                  <span className={`shrink-0 ${META_TEXT} text-text-faint`}>Planned</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function KindDetail(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-base/20 px-6 py-16 text-center">
      <p className="text-sm font-medium text-text">Connector types</p>
      <p className={`mt-2 max-w-md ${HELP_TEXT}`}>
        Each kind declares its own config fields. Hive is the only kind still greyed-out — its adapter awaits a HiveServer2 thrift client binding.
      </p>
    </div>
  )
}

function ConnectorForm({
  form,
  mode,
  onPatch,
  onKindChange,
  onNameChange,
}: {
  form: ConnectorFormSnapshot
  mode: FormMode
  onPatch: (fields: Partial<ConnectorFormSnapshot>) => void
  onKindChange: (next: ConnectorKindId) => void
  onNameChange: (name: string) => void
}): JSX.Element {
  const kind = getConnectorKind(form.kind) ?? CONNECTOR_KINDS[0]!
  return (
    <div className="space-y-3">
      <FormSectionCard
        title="Identity"
        description="Pick a connector kind, then name the instance."
        emphasized
      >
        <FormFieldGroup label="Connector kind">
          <Listbox
            value={form.kind}
            options={kindOptions(form.kind)}
            onChange={onKindChange}
            size="sm"
            className="w-full"
            ariaLabel="Connector kind"
          />
        </FormFieldGroup>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Name" hint={mode === "edit" ? "Locked after create." : undefined}>
            <input
              value={form.name}
              disabled={mode === "edit"}
              onChange={(e) => onNameChange(e.target.value)}
              className="input text-sm"
              placeholder="dev"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Display name">
            <input
              value={form.displayName}
              onChange={(e) => onPatch({ displayName: e.target.value })}
              className="input text-sm"
              placeholder="Development"
            />
          </FormFieldGroup>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Connector id" hint={mode === "edit" ? "Locked after create." : "Auto-derived from name."}>
            <input
              value={form.id}
              disabled={mode === "edit"}
              onChange={(e) => onPatch({ id: toConnectorId(e.target.value) })}
              className="input font-mono text-sm"
              placeholder="dev"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Enabled">
            <LabeledCheckbox
              label="Use this connector"
              checked={form.enabled}
              onChange={(enabled) => onPatch({ enabled })}
              className="h-[34px]"
            />
          </FormFieldGroup>
        </div>
      </FormSectionCard>

      <FormSectionCard
        title={`${kind.displayName} configuration`}
        description={kind.description}
      >
        {kind.configSchema.map((field) => (
          <ConfigFieldRow
            key={field.key}
            label={field.label}
            type={field.type}
            required={Boolean(field.required)}
            placeholder={field.placeholder}
            help={field.help}
            value={form.config[field.key] ?? null}
            onChange={(value) => onPatch({ config: { ...form.config, [field.key]: value } })}
          />
        ))}
      </FormSectionCard>
    </div>
  )
}

function ConfigFieldRow({
  label,
  type,
  required,
  placeholder,
  help,
  value,
  onChange,
}: {
  label: string
  type: "text" | "password" | "number" | "boolean" | "url"
  required: boolean
  placeholder?: string
  help?: string
  value: ConfigValue
  onChange: (value: ConfigValue) => void
}): JSX.Element {
  const hint = help ?? (required ? "Required." : undefined)
  if (type === "boolean") {
    return (
      <FormFieldGroup label={label} hint={hint}>
        <LabeledCheckbox
          label={Boolean(value) ? "Yes" : "No"}
          checked={Boolean(value)}
          onChange={onChange}
          className="h-[34px]"
        />
      </FormFieldGroup>
    )
  }
  if (type === "number") {
    return (
      <FormFieldGroup label={label} hint={hint}>
        <input
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          placeholder={placeholder}
          className="input font-mono text-sm"
        />
      </FormFieldGroup>
    )
  }
  const isSecret = type === "password"
  return (
    <FormFieldGroup label={label} hint={isSecret && value === SECRET_MASK ? "Stored value hidden — retype to replace." : hint}>
      <input
        type={isSecret ? "password" : "text"}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input text-sm"
        autoComplete={isSecret ? "new-password" : "off"}
      />
    </FormFieldGroup>
  )
}



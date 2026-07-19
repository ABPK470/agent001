/**
 * Manage sync flows and platform setup.
 */

import { Lock, LockOpen, MousePointer2, Plus, Save, Search, Trash2, Workflow, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import type { AuthoredSyncFlowStep, CustomValueSourceDefinition, SyncEnvironmentAdmin, SyncFlowKindDefinition, SyncMetadataCatalogResponse } from "../../types"
import {
  flowStepPickerOptions,
  handlerInputSlots,
  idToCatalogDescription,
  idToCatalogLabel,
  isStepBoundHandlerSlot,
  METADATA_SYNC_KIND_ID,
  validateCatalogId,
  validateTargetSqlQuery,
  validateValueSource,
  valueSourceCatalogId,
} from "../../types"
import { ConfirmModal } from "../sync-admin/chrome"
import {
  CustomValueSourceDefinitionEditor,
  DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION,
  DEFAULT_STEP_TYPE_DEFINITION,
  StepTypeDefinitionEditor,
} from "./CatalogDefinitionEditor"
import { FORM_HEADING, HELP_TEXT, ICON_BTN, ICON_BTN_PRIMARY, META_TEXT, PANEL, TAB_PILL, TAB_PILL_ACTIVE, TAB_PILL_IDLE, TEXT_BTN, TEXT_BTN_PRIMARY } from "./chrome"
import { FormSurfaceExecutionSteps } from "./EntityEditSurfaces"
import { buildStepTypeCatalogLookup } from "./execution-step-shared"
import { FormFieldGroup, FormSectionCard } from "./form-section"
import {
  customValueSourceCatalogFromMetadata,
  sourcesCatalogListItems,
} from "./handler-editor"
import { ModalShell } from "./ModalShell"
import { ModalToastStack, useModalToasts } from "./ModalToastStack"
import { HANDLER_TYPE_TAG } from "./param-binding-ui"
import { SyncEnvironmentForm } from "./sync-environments/SyncEnvironmentForm"
import {
  CONFIG_SPLIT_FORM_CLASS,
  CONFIG_SPLIT_FORM_SCROLL_CLASS,
  CONFIG_SPLIT_GRID_CLASS,
  CONFIG_SPLIT_LIST_CLASS,
} from "./sync-environments/environment-form-layout"
import {
  cloneEnvironmentFormSnapshot,
  emptyEnvironmentFormSnapshot,
  environmentFormFromEnv,
  environmentFormToPayload,
  validateEnvironmentForm,
  type EnvironmentFormSnapshot,
} from "./sync-environments/environment-form-model"
import { useSyncEnvironments } from "./sync-environments/useSyncEnvironments"

type CatalogTab = "flows" | "actions" | "valueSources"
type CatalogView = "flows" | "actions" | "valueSources" | "environments"
type FormMode = "create" | "edit"

type FormSnapshot = {
  formId: string
  formLabel: string
  formDescription: string
  formSteps: AuthoredSyncFlowStep[]
  formStepTypeDefinition: SyncFlowKindDefinition
  formCustomValueSourceDefinition: CustomValueSourceDefinition
}

function cloneFormSnapshot(snapshot: FormSnapshot): FormSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as FormSnapshot
}

function emptyFormSnapshot(): FormSnapshot {
  return {
    formId: "",
    formLabel: "",
    formDescription: "",
    formSteps: [],
    formStepTypeDefinition: { ...DEFAULT_STEP_TYPE_DEFINITION },
    formCustomValueSourceDefinition: { ...DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION },
  }
}

function activeFormSlice(snapshot: FormSnapshot, tab: CatalogTab): unknown {
  switch (tab) {
    case "flows":
      return {
        formId: snapshot.formId,
        formLabel: snapshot.formLabel,
        formDescription: snapshot.formDescription,
        formSteps: snapshot.formSteps,
      }
    case "actions":
      return {
        formId: snapshot.formId,
        formLabel: snapshot.formLabel,
        formStepTypeDefinition: snapshot.formStepTypeDefinition,
      }
    case "valueSources":
      return {
        formId: snapshot.formId,
        formLabel: snapshot.formLabel,
        formCustomValueSourceDefinition: snapshot.formCustomValueSourceDefinition,
      }
  }
}

const TAB_SINGULAR: Record<CatalogTab, string> = {
  flows: "flow",
  actions: "action",
  valueSources: "value source",
}

const VIEW_DESCRIPTIONS: Record<CatalogView, string> = {
  flows: "Ordered steps each entity runs. Expand a step for Text: values or per-flow resolver overrides.",
  actions: "Wire each parameter to Auto:, Query:, Text:, a literal, earlier-step output, or leave blank for per-flow choice.",
  valueSources: "Value source catalog — plan context, target SQL, and step text fields. Seeded from Catalog seeds.",
  environments: "MSSQL sync environments (dev / uat / prod) for preview and execute. Stored in SQLite; .env environment names are not modified.",
}

const NAV_VIEWS: Array<{ view: CatalogView; label: string }> = [
  { view: "flows", label: "Flows" },
  { view: "actions", label: "Actions" },
  { view: "valueSources", label: "Sources" },
  { view: "environments", label: "Environments" },
]

const SETUP_ORDER_HINT = "Compose flows, wire actions once. Manage catalog for paramters wiring and resolvers."

function formPanelTitle(
  mode: FormMode,
  tab: CatalogTab,
  editingId: string | null,
  flowLabel: string,
  formLabel: string,
): string {
  if (tab === "flows") {
    if (mode === "edit" && flowLabel.trim()) return flowLabel.trim()
    return mode === "edit" ? "Edit flow" : "New flow"
  }
  if (mode === "edit" && formLabel.trim()) return formLabel.trim()
  if (mode === "edit" && editingId) return `Edit ${TAB_SINGULAR[tab]}`
  return `New ${TAB_SINGULAR[tab]}`
}

export interface SyncMetadataModalProps {
  onClose: () => void
  onChanged?: () => void
  /** Open the flows tab and load this flow into the editor. */
  initialFlowId?: string | null
  /** Nested inside entity editor / other modals. */
  stackLevel?: number
}

export function SyncMetadataModal({
  onClose,
  onChanged,
  initialFlowId = null,
  stackLevel = 0,
}: SyncMetadataModalProps): JSX.Element {
  const [tab, setTab] = useState<CatalogTab>("flows")
  const [catalogView, setCatalogView] = useState<CatalogView>("flows")
  const [catalog, setCatalog] = useState<SyncMetadataCatalogResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const { toasts, pushToast, dismissToast, clearToasts } = useModalToasts()
  const [formMode, setFormMode] = useState<FormMode>("create")
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBuiltIn, setEditingBuiltIn] = useState(false)
  const [formId, setFormId] = useState("")
  const [formLabel, setFormLabel] = useState("")
  const [formDescription, setFormDescription] = useState("")
  const [formSteps, setFormSteps] = useState<AuthoredSyncFlowStep[]>([])
  const [formStepTypeDefinition, setFormStepTypeDefinition] = useState<SyncFlowKindDefinition>(DEFAULT_STEP_TYPE_DEFINITION)
  const [formCustomValueSourceDefinition, setFormCustomValueSourceDefinition] = useState<CustomValueSourceDefinition>(
    DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION,
  )
  const [labelTouched, setLabelTouched] = useState(false)
  const [descTouched, setDescTouched] = useState(false)
  const [listQuery, setListQuery] = useState("")
  const [formBaseline, setFormBaseline] = useState<FormSnapshot>(() => emptyFormSnapshot())
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false)
  const [unlockBuiltinConfirmOpen, setUnlockBuiltinConfirmOpen] = useState(false)
  const [environmentFormOpen, setEnvironmentFormOpen] = useState(false)
  const [environmentFormMode, setEnvironmentFormMode] = useState<FormMode>("create")
  const [environmentEditingId, setEnvironmentEditingId] = useState<string | null>(null)
  const [environmentEditingBuiltIn, setEnvironmentEditingBuiltIn] = useState(false)
  const [environmentForm, setEnvironmentForm] = useState<EnvironmentFormSnapshot>(() => emptyEnvironmentFormSnapshot())
  const [environmentFormBaseline, setEnvironmentFormBaseline] = useState<EnvironmentFormSnapshot>(() => emptyEnvironmentFormSnapshot())
  const [environmentConfirmSaveOpen, setEnvironmentConfirmSaveOpen] = useState(false)
  const pendingInitialFlowId = useRef(initialFlowId)

  const environments = useSyncEnvironments(
    () => { /* success toasts omitted — list reload is enough */ },
    (message) => pushToast(message),
    catalogView === "environments",
  )

  const currentFormSnapshot = useMemo(
    (): FormSnapshot => ({
      formId,
      formLabel,
      formDescription,
      formSteps,
      formStepTypeDefinition,
      formCustomValueSourceDefinition,
    }),
    [
      formCustomValueSourceDefinition,
      formDescription,
      formId,
      formLabel,
      formSteps,
      formStepTypeDefinition,
    ],
  )

  const isFormDirty = useMemo(
    () =>
      JSON.stringify(activeFormSlice(currentFormSnapshot, tab)) !==
      JSON.stringify(activeFormSlice(formBaseline, tab)),
    [currentFormSnapshot, formBaseline, tab],
  )

  const isEnvironmentFormDirty = useMemo(
    () => JSON.stringify(environmentForm) !== JSON.stringify(environmentFormBaseline),
    [environmentForm, environmentFormBaseline],
  )

  const environmentFormReadOnly = useMemo(
    () => environmentFormMode === "edit" && environmentEditingBuiltIn && !environments.builtinEditUnlocked,
    [environmentEditingBuiltIn, environmentFormMode, environments.builtinEditUnlocked],
  )

  const load = useCallback(async (): Promise<SyncMetadataCatalogResponse | null> => {
    setBusy(true)
    clearToasts()
    try {
      const next = await api.getSyncMetadataCatalog()
      setCatalog(next)
      return next
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(false)
    }
  }, [clearToasts, pushToast])

  useEffect(() => { void load() }, [load])

  function reopenSavedEntry(nextCatalog: SyncMetadataCatalogResponse, savedId: string): void {
    if (tab === "flows") {
      const flow = nextCatalog.flows.find((entry) => entry.id === savedId)
      if (flow) startEdit(flow, { description: flow.description, steps: flow.steps })
      return
    }
    if (tab === "actions") {
      const kind = nextCatalog.actions.find((entry) => entry.id === savedId)
      if (kind) startEdit(kind, { stepTypeDefinition: kind.definition })
      return
    }
    if (tab === "valueSources") {
      const source = nextCatalog.valueSources.find((entry) => entry.id === savedId)
      if (source) startEdit(source, { customValueSourceDefinition: source.definition })
    }
  }

  const stepTypeOptions = useMemo(
    () => (catalog?.actions ?? []).map((k) => ({ value: k.id as AuthoredSyncFlowStep["kind"], label: k.label })),
    [catalog],
  )

  const customValueSourceCatalog = useMemo(
    () => customValueSourceCatalogFromMetadata(catalog?.valueSources ?? []),
    [catalog],
  )

  const stepTypeCatalogLookup = useMemo(
    () => buildStepTypeCatalogLookup(catalog?.actions ?? null),
    [catalog],
  )

  const flowStepPickerOpts = useMemo(
    () => flowStepPickerOptions(catalog?.flows ?? [], formSteps),
    [catalog, formSteps],
  )

  const allFlowStepsForHints = useMemo(() => {
    const steps = [...formSteps]
    for (const flow of catalog?.flows ?? []) {
      for (const step of flow.steps) steps.push(step)
    }
    return steps
  }, [catalog, formSteps])

  function resolveKind(kindId: string) {
    return stepTypeCatalogLookup?.get(kindId)
  }

  function applyFormSnapshot(snapshot: FormSnapshot): void {
    setFormId(snapshot.formId)
    setFormLabel(snapshot.formLabel)
    setFormDescription(snapshot.formDescription)
    setFormSteps(snapshot.formSteps.map((step) => ({ ...step })))
    setFormStepTypeDefinition({ ...snapshot.formStepTypeDefinition })
    setFormCustomValueSourceDefinition({ ...snapshot.formCustomValueSourceDefinition })
  }

  function setFormBaselineFrom(snapshot: FormSnapshot): void {
    setFormBaseline(cloneFormSnapshot(snapshot))
  }

  function closeEnvironmentForm(): void {
    setEnvironmentFormOpen(false)
    setEnvironmentConfirmSaveOpen(false)
    setEnvironmentFormMode("create")
    setEnvironmentEditingId(null)
    setEnvironmentEditingBuiltIn(false)
    const snapshot = emptyEnvironmentFormSnapshot()
    setEnvironmentForm(snapshot)
    setEnvironmentFormBaseline(cloneEnvironmentFormSnapshot(snapshot))
  }

  function startEnvironmentCreate(): void {
    const snapshot = emptyEnvironmentFormSnapshot()
    setEnvironmentFormOpen(true)
    setEnvironmentFormMode("create")
    setEnvironmentEditingId(null)
    setEnvironmentEditingBuiltIn(false)
    setEnvironmentForm(snapshot)
    setEnvironmentFormBaseline(cloneEnvironmentFormSnapshot(snapshot))
  }

  function startEnvironmentEdit(item: SyncEnvironmentAdmin): void {
    if (
      environmentFormOpen
      && environmentFormMode === "edit"
      && environmentEditingId === item.name
    ) {
      return
    }
    const snapshot = environmentFormFromEnv(item)
    setEnvironmentFormOpen(true)
    setEnvironmentFormMode("edit")
    setEnvironmentEditingId(item.name)
    setEnvironmentEditingBuiltIn(Boolean(item.builtIn))
    setEnvironmentForm(snapshot)
    setEnvironmentFormBaseline(cloneEnvironmentFormSnapshot(snapshot))
  }

  function requestEnvironmentSave(): void {
    if (!environmentFormOpen || environmentFormReadOnly) return
    const validationError = validateEnvironmentForm(environmentForm)
    if (validationError) {
      pushToast(validationError)
      return
    }
    setEnvironmentConfirmSaveOpen(true)
  }

  function discardEnvironmentFormChanges(): void {
    setEnvironmentForm(cloneEnvironmentFormSnapshot(environmentFormBaseline))
    setEnvironmentConfirmSaveOpen(false)
  }

  async function commitEnvironmentSave(): Promise<void> {
    if (!environmentFormOpen || environmentFormReadOnly) return
    const payload = environmentFormToPayload(environmentForm)
    const name = String(payload.name ?? "")
    setEnvironmentConfirmSaveOpen(false)
    clearToasts()
    try {
      if (environmentFormMode === "create") {
        await environments.create(payload)
        setEnvironmentFormMode("edit")
        setEnvironmentEditingId(name)
        setEnvironmentEditingBuiltIn(false)
        setEnvironmentFormBaseline(cloneEnvironmentFormSnapshot(environmentForm))
      } else if (environmentEditingId) {
        await environments.save(
          environmentEditingId,
          payload,
          Boolean(environmentEditingBuiltIn && environments.builtinEditUnlocked),
        )
        setEnvironmentFormBaseline(cloneEnvironmentFormSnapshot(environmentForm))
      }
      onChanged?.()
    } catch {
      // useSyncEnvironments already surfaced the error
    }
  }

  function closeForm(): void {
    setFormOpen(false)
    setConfirmSaveOpen(false)
    setFormMode("create")
    setEditingId(null)
    setEditingBuiltIn(false)
    const snapshot = emptyFormSnapshot()
    applyFormSnapshot(snapshot)
    setFormBaselineFrom(snapshot)
    setLabelTouched(false)
    setDescTouched(false)
  }

  function startCreate(): void {
    setFormOpen(true)
    setFormMode("create")
    setEditingId(null)
    setEditingBuiltIn(false)
    const snapshot = emptyFormSnapshot()
    applyFormSnapshot(snapshot)
    setFormBaselineFrom(snapshot)
    setLabelTouched(false)
    setDescTouched(false)
  }

  function startEdit(
    item: { id: string; label: string; builtIn: boolean },
    extra?: {
      description?: string
      steps?: AuthoredSyncFlowStep[]
      stepTypeDefinition?: SyncFlowKindDefinition
      customValueSourceDefinition?: CustomValueSourceDefinition
    },
  ): void {
    setFormOpen(true)
    setFormMode("edit")
    setEditingId(item.id)
    setEditingBuiltIn(item.builtIn)
    const snapshot: FormSnapshot = {
      formId: item.id,
      formLabel: item.label,
      formDescription: extra?.description ?? "",
      formSteps: extra?.steps ? extra.steps.map((step) => ({ ...step })) : [],
      formStepTypeDefinition: extra?.stepTypeDefinition
        ? { ...extra.stepTypeDefinition, summary: extra.stepTypeDefinition.summary || item.label }
        : { ...DEFAULT_STEP_TYPE_DEFINITION },
      formCustomValueSourceDefinition: extra?.customValueSourceDefinition
        ? { ...extra.customValueSourceDefinition }
        : { ...DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION },
    }
    applyFormSnapshot(snapshot)
    setFormBaselineFrom(snapshot)
    setLabelTouched(true)
    setDescTouched(true)
  }

  useEffect(() => {
    if (!catalog || !pendingInitialFlowId.current) return
    const flowId = pendingInitialFlowId.current
    pendingInitialFlowId.current = null
    const flow = catalog.flows.find((entry) => entry.id === flowId)
    if (!flow) return
    setTab("flows")
    setCatalogView("flows")
    startEdit(flow, { description: flow.description, steps: flow.steps })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once when catalog loads
  }, [catalog])

  const sourcesListItems = useMemo(
    () => sourcesCatalogListItems(catalog?.valueSources ?? []),
    [catalog],
  )

  function switchView(next: CatalogView): void {
    setCatalogView(next)
    setListQuery("")
    if (next === "environments") {
      closeForm()
      return
    }
    closeEnvironmentForm()
    if (next === "flows") {
      setTab("flows")
    } else if (next === "actions") {
      setTab("actions")
    } else {
      setTab("valueSources")
    }
    closeForm()
  }

  function selectSourcesItem(id: string): void {
    setCatalogView("valueSources")
    setTab("valueSources")
    const entry = catalog?.valueSources?.find((row) => row.id === id)
    if (entry) startEdit(entry, { customValueSourceDefinition: entry.definition })
  }

  function onFormIdChange(id: string): void {
    setFormId(id)
    if (formMode !== "create") return
    const label = idToCatalogLabel(id)
    if (!labelTouched) {
      setFormLabel(label)
      if (tab === "actions") {
        setFormStepTypeDefinition((current) => ({ ...current, summary: label }))
      }
    }
    if (!descTouched) {
      const kind =
        tab === "flows"
          ? "flow"
          : tab === "valueSources"
            ? "customValueSource"
            : "stepType"
      const description = idToCatalogDescription(id, kind)
      if (tab === "flows") setFormDescription(description)
      else if (tab === "valueSources") {
        setFormCustomValueSourceDefinition((current) => ({ ...current, description }))
      } else {
        setFormStepTypeDefinition((current) => ({ ...current, description }))
      }
    }
  }

  function validateForm(): string | null {
    const entryLabel =
      tab === "actions"
        ? "Action id"
        : tab === "valueSources"
          ? "Custom value source id"
          : "Flow id"
    const idError = validateCatalogId(formId, entryLabel)
    if (idError) return idError

    if (tab === "flows") {
      const kindIds = new Set((catalog?.actions ?? []).map((k) => k.id))
      for (const step of formSteps) {
        const stepIdError = validateCatalogId(step.id, "Step id")
        if (stepIdError) return `Step id "${step.id || "?"}": ${stepIdError}`
        const kindIdError = validateCatalogId(step.kind, "Kind id")
        if (kindIdError) {
          return `Step "${step.id || "?"}": kind "${step.kind}" is invalid — use camelCase catalog id (e.g. metadataSync).`
        }
        if (!kindIds.has(step.kind)) {
          return `Step "${step.id}" references unknown action "${step.kind}". Pick an action from the Actions catalog.`
        }
      }
      const metadataCount = formSteps.filter((step) => step.kind === METADATA_SYNC_KIND_ID).length
      if (metadataCount !== 1) {
        return `Flow must include exactly one ${METADATA_SYNC_KIND_ID} step (found ${metadataCount}).`
      }
    }

    if (tab === "actions") {
      const catalogIds = new Set((catalog?.valueSources ?? []).map((entry) => entry.id))
      for (const slot of handlerInputSlots(formStepTypeDefinition.handler)) {
        if (isStepBoundHandlerSlot(slot)) continue
        if (!slot.source) continue
        const sourceError = validateValueSource(slot.source, `Parameter "${slot.name}"`)
        if (sourceError) return sourceError
        const catalogId = valueSourceCatalogId(slot.source)
        if (catalogId && !catalogIds.has(catalogId)) {
          return `Parameter "${slot.name}" references unknown value source "${catalogId}".`
        }
      }
    }

    if (tab === "valueSources") {
      const resolver = formCustomValueSourceDefinition.resolver
      if (resolver.kind === "targetSql") {
        const queryError = validateTargetSqlQuery(resolver.query)
        if (queryError) return queryError
        if (!resolver.resultColumn?.trim()) return "Result column is required."
      }
    }

    return null
  }

  async function commitSaveEntry(): Promise<void> {
    const id = formId.trim()
    const label = formLabel.trim()
    if (!id || !label) return
    setBusy(true)
    clearToasts()
    setConfirmSaveOpen(false)
    try {
      if (tab === "actions") {
        await api.saveSyncMetadataStepType({
          id,
          label,
          definition: { ...formStepTypeDefinition, summary: formStepTypeDefinition.summary || label },
        })
      } else if (tab === "valueSources") {
        await api.saveSyncMetadataCustomValueSource({
          id,
          label,
          definition: { ...formCustomValueSourceDefinition },
        })
      } else {
        await api.saveSyncMetadataFlow({
          id,
          label,
          description: formDescription.trim(),
          steps: formSteps,
        })
      }
      const nextCatalog = await api.getSyncMetadataCatalog()
      setCatalog(nextCatalog)
      reopenSavedEntry(nextCatalog, id)
      onChanged?.()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function requestSave(): void {
    if (!formOpen) return
    const id = formId.trim()
    const label = formLabel.trim()
    if (!id || !label) return
    const validationError = validateForm()
    if (validationError) {
      pushToast(validationError)
      return
    }
    setConfirmSaveOpen(true)
  }

  function discardFormChanges(): void {
    applyFormSnapshot(formBaseline)
    setConfirmSaveOpen(false)
  }

  async function removeEntry(id: string): Promise<void> {
    setBusy(true)
    clearToasts()
    try {
      if (tab === "actions") await api.deleteSyncMetadataStepType(id)
      else if (tab === "valueSources") await api.deleteSyncMetadataCustomValueSource(id)
      else await api.deleteSyncMetadataFlow(id)
      if (editingId === id) closeForm()
      await load()
      onChanged?.()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const metadataStepCount = useMemo(
    () => formSteps.filter((step) => step.kind === METADATA_SYNC_KIND_ID).length,
    [formSteps],
  )

  const headerDescription = VIEW_DESCRIPTIONS[catalogView]

  const saveConfirmTitle =
    formMode === "create"
      ? `Create ${TAB_SINGULAR[tab]}?`
      : `Save ${TAB_SINGULAR[tab]} changes?`

  const saveConfirmBody = (() => {
    const name = formLabel.trim() || formId.trim() || TAB_SINGULAR[tab]
    if (formMode === "create") {
      if (tab === "flows") {
        return `Create flow "${name}" with ${formSteps.length} step${formSteps.length === 1 ? "" : "s"}?`
      }
      return `Create new ${TAB_SINGULAR[tab]} "${name}"?`
    }
    if (!isFormDirty) {
      return `No edits detected for "${name}". Save anyway?`
    }
    if (tab === "flows") {
      return `Write changes to flow "${name}" (${formSteps.length} step${formSteps.length === 1 ? "" : "s"})?`
    }
    return `Write changes to ${TAB_SINGULAR[tab]} "${name}"?`
  })()

  const environmentSaveConfirmTitle =
    environmentFormMode === "create" ? "Create environment?" : "Save environment changes?"

  const environmentSaveConfirmBody = (() => {
    const name = environmentForm.displayName.trim() || environmentForm.name.trim() || "environment"
    if (environmentFormMode === "create") {
      return `Create MSSQL environment "${name}"?`
    }
    if (!isEnvironmentFormDirty) {
      return `No edits detected for "${name}". Save anyway?`
    }
    return `Write changes to environment "${name}"?`
  })()

  return (
    <>
    <ModalShell
      title={initialFlowId ? `Configure flow · ${initialFlowId}` : "Configuration"}
      subtitle={initialFlowId ? "Edit steps and per-flow settings for this entity's run recipe." : SETUP_ORDER_HINT}
      icon={<Workflow size={20} className="text-text-muted" />}
      stackLevel={stackLevel}
      onClose={() => {
        if (confirmSaveOpen || environmentConfirmSaveOpen) return
        onClose()
      }}
      size="focus"
    >
      <div className="entity-registry relative flex min-h-0 flex-1 flex-col">
        <ModalToastStack toasts={toasts} onDismiss={dismissToast} />
        <div className="shrink-0 space-y-2 border-b border-border-subtle px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1" role="tablist" aria-label="Configuration sections">
              {NAV_VIEWS.map((entry) => {
                const active = catalogView === entry.view
                return (
                  <button
                    key={entry.view}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchView(entry.view)}
                    className={[TAB_PILL, active ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
                  >
                    {entry.label}
                  </button>
                )
              })}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {catalogView === "environments" && (
                <>
                  <button
                    type="button"
                    className={[
                      ICON_BTN,
                      environments.builtinEditUnlocked ? "text-warning" : "",
                    ].join(" ")}
                    title={environments.builtinEditUnlocked ? "Lock built-in environments" : "Unlock built-in environments"}
                    aria-label={environments.builtinEditUnlocked ? "Lock built-in environments" : "Unlock built-in environments"}
                    onClick={() => {
                      if (environments.builtinEditUnlocked) {
                        environments.setBuiltinEditUnlocked(false)
                      } else {
                        setUnlockBuiltinConfirmOpen(true)
                      }
                    }}
                  >
                    {environments.builtinEditUnlocked ? <LockOpen size={16} /> : <Lock size={16} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEnvironmentCreate()}
                    className={ICON_BTN}
                    title="New environment"
                    aria-label="New environment"
                  >
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={requestEnvironmentSave}
                    disabled={
                      environments.saving !== null
                      || !environmentFormOpen
                      || !environmentForm.name.trim()
                      || environmentFormReadOnly
                    }
                    className={ICON_BTN_PRIMARY}
                    title={isEnvironmentFormDirty ? "Save unsaved changes" : "Save"}
                    aria-label="Save"
                  >
                    <Save size={16} />
                  </button>
                </>
              )}
              {catalogView !== "environments" && (
                <>
              {catalogView === "valueSources" ? (
                <button
                  type="button"
                  onClick={() => {
                    setTab("valueSources")
                    startCreate()
                  }}
                  className={ICON_BTN}
                  title="New custom value source"
                  aria-label="New custom value source"
                >
                  <Plus size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => startCreate()}
                  className={ICON_BTN}
                  title={`New ${TAB_SINGULAR[tab]}`}
                  aria-label={`New ${TAB_SINGULAR[tab]}`}
                >
                  <Plus size={16} />
                </button>
              )}
              <button
                type="button"
                onClick={requestSave}
                disabled={busy || !formOpen || !formId.trim() || !formLabel.trim()}
                className={ICON_BTN_PRIMARY}
                title={isFormDirty ? "Save unsaved changes" : "Save"}
                aria-label="Save"
              >
                <Save size={16} />
              </button>
                </>
              )}
            </div>
          </div>
          <p className={`${META_TEXT} max-w-3xl leading-relaxed text-text-faint`}>{headerDescription}</p>
        </div>

        <div className={CONFIG_SPLIT_GRID_CLASS}>
          <div className={CONFIG_SPLIT_LIST_CLASS}>
            {!catalog && busy && catalogView !== "environments" && <p className="shrink-0 text-sm text-text-muted">Loading…</p>}
            {catalogView === "environments" && environments.busy && environments.items.length === 0 && (
              <p className="shrink-0 text-sm text-text-muted">Loading…</p>
            )}
            {catalogView === "environments" && (
              <CatalogList
                query={listQuery}
                onQueryChange={setListQuery}
                searchPlaceholder="Search environments…"
                items={environments.catalogItems.map((item) => ({
                  ...item,
                  deletable: !item.builtIn || environments.builtinEditUnlocked,
                }))}
                selectedId={environmentFormOpen && environmentFormMode === "edit" ? environmentEditingId : null}
                onSelect={(id) => {
                  const item = environments.items.find((entry) => entry.name === id)
                  if (item) startEnvironmentEdit(item)
                }}
                onDelete={(id) => environments.setDeleting(id)}
              />
            )}
            {catalog && catalogView === "flows" && (
              <CatalogList
                query={listQuery}
                onQueryChange={setListQuery}
                searchPlaceholder="Search flows…"
                items={catalog.flows.map((p) => ({ id: p.id, label: p.label, hint: `${p.steps.length} steps`, builtIn: p.builtIn }))}
                selectedId={formOpen && formMode === "edit" ? editingId : null}
                onSelect={(id) => {
                  const p = catalog.flows.find((x) => x.id === id)
                  if (p) startEdit(p, { description: p.description, steps: p.steps })
                }}
                onDelete={(id) => void removeEntry(id)}
              />
            )}
            {catalog && catalogView === "valueSources" && (
              <CatalogList
                query={listQuery}
                onQueryChange={setListQuery}
                searchPlaceholder="Search sources…"
                items={sourcesListItems}
                selectedId={formOpen && formMode === "edit" ? editingId : null}
                onSelect={(id) => selectSourcesItem(id)}
                onDelete={(id) => void removeEntry(id)}
              />
            )}
            {catalog && catalogView === "actions" && (
              <CatalogList
                query={listQuery}
                onQueryChange={setListQuery}
                searchPlaceholder="Search actions…"
                items={catalog.actions.map((k) => ({
                  id: k.id,
                  label: k.label,
                  tag: HANDLER_TYPE_TAG[k.definition.handler.type] ?? k.definition.handler.type,
                  hint: k.definition.summary.trim() !== k.label.trim() ? k.definition.summary : undefined,
                  builtIn: k.builtIn,
                }))}
                selectedId={formOpen && formMode === "edit" ? editingId : null}
                onSelect={(id) => {
                  const k = catalog.actions.find((x) => x.id === id)
                  if (k) startEdit(k, { stepTypeDefinition: k.definition })
                }}
                onDelete={(id) => void removeEntry(id)}
              />
            )}
          </div>

          <div className={CONFIG_SPLIT_FORM_CLASS}>
            {catalogView === "environments" && environmentFormOpen ? (
              <div className={CONFIG_SPLIT_FORM_CLASS}>
                <div className="shrink-0 border-b border-border-subtle bg-elevated/40 px-5 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                    Environments
                    {" · "}
                    {environmentFormMode === "create" ? "New" : "Edit"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h3 className={FORM_HEADING}>
                      {environmentForm.displayName.trim() || environmentForm.name.trim() || "New environment"}
                    </h3>
                    {isEnvironmentFormDirty && (
                      <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-400/90">
                        Unsaved
                      </span>
                    )}
                    {environmentEditingBuiltIn && (
                      <span className="rounded-full bg-overlay-2 px-2 py-0.5 text-xs text-text-muted">Built-in</span>
                    )}
                    {environments.builtinEditUnlocked && environmentEditingBuiltIn && (
                      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">Editing unlocked</span>
                    )}
                  </div>
                  {environmentFormMode === "edit" && environmentEditingId && (
                    <p className={`${META_TEXT} mt-1 font-mono`}>{environmentEditingId}</p>
                  )}
                </div>
                <div className={CONFIG_SPLIT_FORM_SCROLL_CLASS}>
                  <SyncEnvironmentForm
                    value={environmentForm}
                    onChange={setEnvironmentForm}
                    mode={environmentFormMode}
                    readOnly={environmentFormReadOnly}
                    stackLevel={stackLevel + 1}
                    peerEnvironments={environments.items.map((item) => ({
                      name: item.name,
                      displayName: item.displayName,
                    }))}
                  />
                </div>
              </div>
            ) : catalogView === "environments" ? (
              <EmptyState
                icon={MousePointer2}
                message="Nothing selected"
                className="bg-base/20"
                detail={(
                  <>
                    Choose an environment from the list, or click{" "}
                    <Plus className="mx-0.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
                    {" "}to add one matching an enabled SQL Server connector.
                  </>
                )}
              />
            ) : formOpen ? (
              <div className={CONFIG_SPLIT_FORM_CLASS}>
            <div className="shrink-0 border-b border-border-subtle bg-elevated/40 px-5 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                {catalogView === "flows" ? "Flows" : catalogView === "actions" ? "Actions" : "Sources"}
                {" · "}
                {formMode === "create" ? "New" : "Edit"}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h3 className={FORM_HEADING}>{formPanelTitle(formMode, tab, editingId, formLabel, formLabel)}</h3>
                {isFormDirty && (
                  <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-400/90">
                    Unsaved
                  </span>
                )}
              </div>
              {formMode === "edit" && editingId && tab !== "flows" && (
                <p className={`${META_TEXT} mt-1 font-mono`}>{editingId}</p>
              )}
              {formMode === "edit" && editingId && tab === "flows" && (
                <p className={`${META_TEXT} mt-1`}>
                  Flow key: <span className="font-mono">{editingId}</span>
                </p>
              )}
            </div>

            <div className={CONFIG_SPLIT_FORM_SCROLL_CLASS}>
            {formMode === "edit" && editingBuiltIn && tab === "valueSources" && (
              <p className={`mb-4 ${HELP_TEXT}`}>
                Built-in value source — resolution kind and SQL are locked. You can still update the name and description.
              </p>
            )}
            {formMode === "edit" && editingBuiltIn && tab === "actions" && (
              <p className={`mb-4 ${HELP_TEXT}`}>Built-in action — handler wiring is locked; names and descriptions can be updated.</p>
            )}

            <div className="space-y-3">
              {tab === "flows" ? (
                <>
                  <FormSectionCard
                    title="Flow details"
                    description="Name and key entities reference when they pick this recipe."
                    emphasized
                  >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormFieldGroup label="Flow name">
                        <input
                          value={formLabel}
                          onChange={(e) => {
                            setLabelTouched(true)
                            setFormLabel(e.target.value)
                          }}
                          className="input text-sm"
                          placeholder="Contract deploy"
                        />
                      </FormFieldGroup>
                      <FormFieldGroup
                        label="Flow key"
                        hint={formMode === "edit" ? "Locked after create." : "Kebab-case id used in entity sync config."}
                      >
                        <input
                          value={formId}
                          onChange={(e) => onFormIdChange(e.target.value)}
                          disabled={formMode === "edit"}
                          placeholder="contract-deploy"
                          className="input font-mono text-sm"
                        />
                      </FormFieldGroup>
                    </div>
                    <FormFieldGroup label="Description">
                      <input
                        value={formDescription}
                        onChange={(e) => {
                          setDescTouched(true)
                          setFormDescription(e.target.value)
                        }}
                        className="input text-sm"
                        placeholder="What this recipe is for"
                      />
                    </FormFieldGroup>
                  </FormSectionCard>

                  <FormSectionCard
                    title="Steps"
                    description="Top to bottom is run order. Expand a step to set parameters and step identity."
                  >
                    {formSteps.length > 0 && metadataStepCount !== 1 && (
                      <p className={`${HELP_TEXT} text-error`}>
                        Include exactly one metadata sync step (found {metadataStepCount}).
                      </p>
                    )}
                    <FormSurfaceExecutionSteps
                      executionSteps={formSteps}
                      onExecutionSteps={setFormSteps}
                      rootTable="schema.Entity"
                      entityId={formId}
                      stepTypeOptions={stepTypeOptions}
                      actions={catalog?.actions}
                      customValueSourceCatalog={customValueSourceCatalog}
                      showAddButton
                    />
                  </FormSectionCard>
                </>
              ) : (
                <>
              <FormSectionCard
                title="Identity"
                description={
                  tab === "actions"
                    ? "Catalog id and display name for this action."
                    : tab === "valueSources"
                      ? "Catalog id and label for this value source."
                      : "Catalog id and display name for this action."
                }
                emphasized
              >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormFieldGroup label="Key">
                  <input
                    value={formId}
                    onChange={(e) => onFormIdChange(e.target.value)}
                    disabled={formMode === "edit"}
                    placeholder={
                      tab === "valueSources"
                        ? "ruleInputDatasetId"
                        : "auditCheck"
                    }
                    className="input font-mono text-sm"
                  />
                </FormFieldGroup>
                <FormFieldGroup label="Name">
                  <input
                    value={formLabel}
                    onChange={(e) => {
                      setLabelTouched(true)
                      const label = e.target.value
                      setFormLabel(label)
                      if (tab === "actions") setFormStepTypeDefinition((c) => ({ ...c, summary: label }))
                    }}
                    className="input text-sm"
                  />
                </FormFieldGroup>
              </div>
              </FormSectionCard>
              {tab === "actions" && (
                <FormSectionCard
                  title="Handler wiring"
                  description="How each parameter is supplied: fixed resolver, Text: field, literal, earlier step output, or chosen on each flow step."
                >
                  <StepTypeDefinitionEditor
                    value={formStepTypeDefinition}
                    onChange={(next) => {
                      setDescTouched(true)
                      setFormStepTypeDefinition(next)
                    }}
                    kindId={(editingId ?? formId.trim()) || undefined}
                    readOnlyHandler={editingBuiltIn}
                    hideSummary
                    customValueSourceCatalog={customValueSourceCatalog}
                    flowStepOptions={flowStepPickerOpts}
                    resolveKind={resolveKind}
                    flowStepsForOutputHints={allFlowStepsForHints}
                  />
                </FormSectionCard>
              )}
              {tab === "valueSources" && (
                <FormSectionCard
                  title="Resolver definition"
                  description={
                    formMode === "create"
                      ? "Pick resolution kind — referenced as { type: \"catalog\", id: \"yourId\" } from action wiring."
                      : "How this catalog entry resolves at execute time."
                  }
                >
                  <CustomValueSourceDefinitionEditor
                    value={formCustomValueSourceDefinition}
                    onChange={(next) => {
                      setDescTouched(true)
                      setFormCustomValueSourceDefinition(next)
                    }}
                    readOnlyResolver={editingBuiltIn}
                    entryId={editingId ?? (formId.trim() || undefined)}
                  />
                </FormSectionCard>
              )}
                </>
              )}
            </div>
            </div>
              </div>
            ) : (
              <EmptyState
                icon={MousePointer2}
                message="Nothing selected"
                className="bg-base/20"
                detail={(
                  <>
                    Choose an item from the list to edit it, or click{" "}
                    <Plus className="mx-0.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
                    {catalogView === "valueSources"
                      ? " to create a custom value source."
                      : ` to create a new ${TAB_SINGULAR[tab]}.`}
                  </>
                )}
              />
            )}
          </div>
        </div>
      </div>
    </ModalShell>

    {unlockBuiltinConfirmOpen && (
      <ConfirmModal
        title="Unlock built-in environments?"
        message="Built-in environments (dev, uat, prod) are protected by default. Unlock only when you intend to edit them. You can lock again anytime from the toolbar."
        confirmLabel="Unlock editing"
        stackLevel={stackLevel + 1}
        onCancel={() => setUnlockBuiltinConfirmOpen(false)}
        onConfirm={() => {
          environments.setBuiltinEditUnlocked(true)
          setUnlockBuiltinConfirmOpen(false)
        }}
      />
    )}

    {environmentConfirmSaveOpen && (
      <ModalShell
        title={environmentSaveConfirmTitle}
        subtitle={environmentForm.displayName.trim() || environmentForm.name.trim() || undefined}
        size="detail"
        stackLevel={stackLevel + 1}
        onClose={() => setEnvironmentConfirmSaveOpen(false)}
        footer={(
          <div className="flex w-full flex-wrap items-center gap-2">
            {isEnvironmentFormDirty && (
              <button
                type="button"
                onClick={discardEnvironmentFormChanges}
                disabled={environments.saving !== null}
                className={`${TEXT_BTN} text-rose-400 hover:text-rose-300`}
              >
                Discard changes
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEnvironmentConfirmSaveOpen(false)}
                disabled={environments.saving !== null}
                className={TEXT_BTN}
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => void commitEnvironmentSave()}
                disabled={environments.saving !== null}
                className={TEXT_BTN_PRIMARY}
              >
                {environmentFormMode === "create" ? "Create" : "Save changes"}
              </button>
            </div>
          </div>
        )}
      >
        <p className="p-5 text-sm leading-relaxed text-text-muted">{environmentSaveConfirmBody}</p>
      </ModalShell>
    )}

    {environments.deleting && (
      <ConfirmModal
        title="Delete environment"
        message={`Delete "${environments.deleting}"?`}
        confirmLabel="Delete"
        danger
        busy={environments.saving === environments.deleting}
        onCancel={() => environments.setDeleting(null)}
        onConfirm={() => void environments.remove(
          environments.deleting!,
          Boolean(environments.items.find((i) => i.name === environments.deleting)?.builtIn && environments.builtinEditUnlocked),
        ).then(() => {
          if (environmentEditingId === environments.deleting) closeEnvironmentForm()
          environments.setDeleting(null)
          onChanged?.()
        })}
      />
    )}

    {confirmSaveOpen && (
      <ModalShell
        title={saveConfirmTitle}
        subtitle={formLabel.trim() || formId.trim() || undefined}
        size="detail"
        stackLevel={stackLevel + 1}
        onClose={() => setConfirmSaveOpen(false)}
        footer={(
          <div className="flex w-full flex-wrap items-center gap-2">
            {isFormDirty && (
              <button
                type="button"
                onClick={discardFormChanges}
                disabled={busy}
                className={`${TEXT_BTN} text-rose-400 hover:text-rose-300`}
              >
                Discard changes
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmSaveOpen(false)}
                disabled={busy}
                className={TEXT_BTN}
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => void commitSaveEntry()}
                disabled={busy}
                className={TEXT_BTN_PRIMARY}
              >
                {formMode === "create" ? "Create" : "Save changes"}
              </button>
            </div>
          </div>
        )}
      >
        <p className="p-5 text-sm leading-relaxed text-text-muted">{saveConfirmBody}</p>
      </ModalShell>
    )}
    </>
  )
}

function CatalogList({
  items,
  selectedId,
  onSelect,
  onDelete,
  query,
  onQueryChange,
  searchPlaceholder = "Filter…",
}: {
  items: Array<{ id: string; label: string; hint?: string; tag?: string; builtIn: boolean; deletable?: boolean }>
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  query: string
  onQueryChange: (query: string) => void
  searchPlaceholder?: string
}): JSX.Element {
  const trimmedQuery = query.trim().toLowerCase()
  const filtered = trimmedQuery
    ? items.filter(
        (item) =>
          item.id.toLowerCase().includes(trimmedQuery) ||
          item.label.toLowerCase().includes(trimmedQuery) ||
          item.hint?.toLowerCase().includes(trimmedQuery),
      )
    : items

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="input flex shrink-0 items-center gap-2 py-0 pl-2.5 pr-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
        <input
          type="text"
          role="searchbox"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm outline-none focus:ring-0"
          aria-label={searchPlaceholder}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <p className="text-sm text-text-muted">Empty.</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-text-muted">No matches for &ldquo;{query.trim()}&rdquo;.</p>
        ) : (
          <ul className={PANEL}>
            {filtered.map((item, index) => (
              <li
                key={item.id}
                className={[
                  "flex items-center gap-2 px-3 py-2 text-sm",
                  index < filtered.length - 1 ? "border-b border-border/20" : "",
                  selectedId === item.id ? "bg-elevated" : "",
                ].join(" ")}
              >
                <button type="button" onClick={() => onSelect(item.id)} className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
                  <span className="min-w-0 truncate font-medium text-text">{item.label}</span>
                  <span className={`font-mono ${META_TEXT}`}>{item.id}</span>
                  {item.hint && <span className={`line-clamp-2 leading-snug text-text-faint ${META_TEXT}`}>{item.hint}</span>}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {item.tag && (
                    <span className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
                      {item.tag}
                    </span>
                  )}
                  {item.builtIn && <span className={`shrink-0 ${META_TEXT} text-text-faint`}>Built-in</span>}
                  {(item.deletable ?? !item.builtIn) && onDelete && (
                    <button type="button" onClick={() => onDelete(item.id)} className={`${ICON_BTN} h-8 w-8 shrink-0`} title="Delete" aria-label="Delete">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {trimmedQuery && filtered.length > 0 && filtered.length < items.length && (
        <p className={`shrink-0 ${META_TEXT} text-text-faint`}>
          {filtered.length} of {items.length}
        </p>
      )}
    </div>
  )
}

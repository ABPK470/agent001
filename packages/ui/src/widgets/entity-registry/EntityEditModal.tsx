import { AlertTriangle, CalendarClock, FilePenLine, GitBranch, Loader2, Save, Workflow } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { canApply, fingerprintPayload } from "../../lib/import-gate"
import type {
  AuthoredSyncFlowStep,
  EntityRegistryDefinition,
  EntityRegistrySyncFlowTemplateId,
  EntityRegistryYamlImportResponse,
} from "../../types"
import { ImportImpactPanel } from "../platform/ImportImpactPanel"
import { FIELD_LABEL, ICON_BTN, PANEL, SECTION_TITLE, TEXT_BTN, TEXT_BTN_PRIMARY } from "./chrome"
import {
  applySourcePreviewToForm,
  buildEntityEditSections,
  defaultNewFormState,
  defToFormState,
  formStateToDefinition,
  formatSourceImportError,
  mergeDraftSuggestion,
  NEW_ENTITY_JSON_TEMPLATE,
  type EntityEditFormState,
  type EntityEditSectionId,
  validateEntityEditForm,
} from "./entity-edit-form"
import { EntityJsonSurface } from "./EntityEditSurfaces"
import { EntityTableListEditor } from "./EntityTableListEditor"
import { FlowStepsPreview } from "./FlowStepsPreview"
import { FreezeWindowsSelect } from "./FreezeWindowsSelect"
import { FreezeWindowsModal } from "./freeze-windows/FreezeWindowsModal"
import { ModalShell } from "./ModalShell"
import { StrategiesModal } from "./scd2/StrategiesModal"
import { StrategySelect } from "./StrategySelect"
import { SyncMetadataModal } from "./SyncMetadataModal"

export interface EntityEditModalProps {
  mode: "new" | "edit"
  initial: EntityRegistryDefinition | null
  /** Known entity ids (active list + any retired ids the server still reserves). */
  reservedEntityIds?: readonly string[]
  onClose: () => void
  onSaved: (id: string, version: number) => void
}

const SECTION_LABELS: Record<EntityEditSectionId, string> = {
  identity: "Identity",
  scd2: "SCD2 strategy",
  policies: "Freeze windows",
  tables: "Tables",
  flow: "Flow",
  source: "Entity JSON",
}

export function EntityEditModal({ mode, initial, reservedEntityIds = [], onClose, onSaved }: EntityEditModalProps): JSX.Element {
  const entityId = initial?.id ?? ""
  const [section, setSection] = useState<EntityEditSectionId>("identity")
  const [form, setForm] = useState<EntityEditFormState>(defaultNewFormState)
  const [baseDef, setBaseDef] = useState<EntityRegistryDefinition | null>(initial)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(mode === "edit")
  const [err, setErr] = useState<string | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [flowTemplateOptions, setFlowTemplateOptions] = useState<ListboxOption<EntityRegistrySyncFlowTemplateId>[]>([])
  const [flowStepsById, setFlowStepsById] = useState<Record<string, AuthoredSyncFlowStep[]>>({})
  const touchedFieldsRef = useRef(new Set<string>())
  const tablesUserEditedRef = useRef(false)
  const [suggestNotes, setSuggestNotes] = useState<string[]>([])
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [syncMetadataOpen, setSyncMetadataOpen] = useState(false)
  const [freezeWindowsOpen, setFreezeWindowsOpen] = useState(false)
  const [strategiesOpen, setStrategiesOpen] = useState(false)
  const [governanceCatalogRev, setGovernanceCatalogRev] = useState(0)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceSyncBusy, setSourceSyncBusy] = useState(false)
  const skipSourceToFormRef = useRef(false)
  const skipFormToSourceRef = useRef(false)
  const hydratedRef = useRef(false)
  const structuredEditedRef = useRef(false)
  const formBaselineRef = useRef<EntityEditFormState>(defaultNewFormState())
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false)
  const [savePreview, setSavePreview] = useState<EntityRegistryYamlImportResponse | null>(null)
  const [savePreviewBusy, setSavePreviewBusy] = useState(false)
  const [savePreviewFingerprint, setSavePreviewFingerprint] = useState<string | null>(null)
  const [savePreviewErr, setSavePreviewErr] = useState<string | null>(null)

  const markTouched = useCallback((field: string) => {
    touchedFieldsRef.current.add(field)
  }, [])

  const applyDraftSuggestion = useCallback(async (rootTable: string, opts?: { forceTables?: boolean }) => {
    const trimmed = rootTable.trim()
    if (!trimmed) return
    setSuggestBusy(true)
    try {
      const suggestion = await api.suggestEntityRegistryDraft(trimmed)
      setSuggestNotes(suggestion.notes)
      structuredEditedRef.current = true
      setForm((current) =>
        mergeDraftSuggestion(current, suggestion, {
          touchedFields: touchedFieldsRef.current,
          tablesUserEdited: opts?.forceTables ? false : tablesUserEditedRef.current,
        }),
      )
      if (opts?.forceTables) tablesUserEditedRef.current = false
    } catch {
      setSuggestNotes([])
    } finally {
      setSuggestBusy(false)
    }
  }, [])

  const patch = useCallback((partial: Partial<EntityEditFormState>) => {
    if ("sourceBody" in partial) {
      structuredEditedRef.current = false
    } else if (
      Object.keys(partial).some((key) => key !== "reason")
    ) {
      structuredEditedRef.current = true
    }
    setForm((current) => ({ ...current, ...partial }))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [runtimeOptions, catalog, configs] = await Promise.all([
        api.getSyncDefinitionConfigOptions(),
        api.getSyncMetadataCatalog().catch(() => null),
        api.listSyncDefinitionConfigs().catch(() => []),
      ])

      const flowOptions = catalog?.flows.length
        ? catalog.flows.map((p) => ({ value: p.id as EntityRegistrySyncFlowTemplateId, label: p.label, hint: p.description }))
        : runtimeOptions.flowTemplates.map((o) => ({ value: o.id, label: o.label, hint: o.description }))

      setFlowTemplateOptions(flowOptions)
      setFlowStepsById(
        Object.fromEntries(
          (catalog?.flows ?? []).map((flow) => [flow.id, flow.steps.map((step) => ({ ...step }))]),
        ),
      )

      if (mode === "edit" && entityId && initial) {
        const source = await api.getEntityRegistryJson(entityId)
        const configFlowId = configs.find((item) => item.id === entityId)?.flowTemplateId
        const hydrated: EntityRegistryDefinition = {
          ...initial,
          flowId: initial.flowId?.trim() || configFlowId || "metadataOnly",
        }
        setBaseDef(hydrated)
        structuredEditedRef.current = false
        setForm({
          ...defToFormState(hydrated),
          sourceBody: source,
        })
        formBaselineRef.current = {
          ...defToFormState(hydrated),
          sourceBody: source,
        }
      } else {
        setBaseDef(null)
        structuredEditedRef.current = false
        const next = defaultNewFormState()
        setForm(next)
        formBaselineRef.current = next
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
      setRuntimeLoading(false)
    }
  }, [entityId, initial, mode])

  useEffect(() => { void load() }, [load])

  const refreshRunCatalog = useCallback(async () => {
    try {
      const [runtimeOptions, catalog] = await Promise.all([
        api.getSyncDefinitionConfigOptions(),
        api.getSyncMetadataCatalog().catch(() => null),
      ])
      const flowOptions = catalog?.flows.length
        ? catalog.flows.map((p) => ({ value: p.id as EntityRegistrySyncFlowTemplateId, label: p.label, hint: p.description }))
        : runtimeOptions.flowTemplates.map((o) => ({ value: o.id, label: o.label, hint: o.description }))
      setFlowTemplateOptions(flowOptions)
      setFlowStepsById(
        Object.fromEntries(
          (catalog?.flows ?? []).map((flow) => [flow.id, flow.steps.map((step) => ({ ...step }))]),
        ),
      )
    } catch {
      // keep current preview if refresh fails
    }
  }, [])

  useEffect(() => {
    if (mode !== "new" || loading) return
    const rootTable = form.rootTable.trim()
    if (rootTable.length < 3) return
    const handle = window.setTimeout(() => {
      void applyDraftSuggestion(rootTable)
    }, 450)
    return () => window.clearTimeout(handle)
  }, [applyDraftSuggestion, form.rootTable, loading, mode])

  const flowPreviewSteps = useMemo(
    () => flowStepsById[form.flowId] ?? [],
    [flowStepsById, form.flowId],
  )

  const sections = useMemo(
    () =>
      buildEntityEditSections(form, {
        flowStepCount: flowPreviewSteps.length,
        entityVersion: mode === "edit" ? baseDef?.version ?? null : null,
      }),
    [form, flowPreviewSteps.length, mode, baseDef?.version],
  )

  useEffect(() => {
    if (!loading) hydratedRef.current = true
  }, [loading])

  const structuredFormKey = useMemo(
    () =>
      JSON.stringify({
        id: form.id,
        displayName: form.displayName,
        description: form.description,
        rootTable: form.rootTable,
        idColumn: form.idColumn,
        labelColumn: form.labelColumn,
        selfJoinColumn: form.selfJoinColumn,
        strategyId: form.strategyId,
        strategyVersion: form.strategyVersion,
        freezeWindowIds: form.freezeWindowIds,
        tables: form.tables,
        flowId: form.flowId,
      }),
    [form],
  )

  useEffect(() => {
    if (loading || !hydratedRef.current) return
    const source = form.sourceBody
    if (!source.trim()) {
      setSourceError(null)
      return
    }
    if (skipFormToSourceRef.current) {
      skipFormToSourceRef.current = false
      return
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        setSourceSyncBusy(true)
        try {
          const result = await api.importEntityRegistryJson(source, "preview", { dryRun: true })
          if (!result.ok || result.rowErrors.length > 0) {
            const first = result.rowErrors[0]
            setSourceError(first ? formatSourceImportError(first) : "Invalid JSON")
            return
          }
          const item = result.preview?.[0]
          if (!item) {
            setSourceError("JSON did not parse to an entity")
            return
          }
          if (mode === "edit" && item.def.id !== entityId) {
            setSourceError(`Entity id must remain "${entityId}"`)
            return
          }
          setSourceError(null)
          skipSourceToFormRef.current = true
          setForm((current) => ({
            ...applySourcePreviewToForm(current, item.def, mode),
            sourceBody: current.sourceBody,
            reason: current.reason,
            versionLabel: current.versionLabel,
          }))
        } catch (error) {
          setSourceError(error instanceof Error ? error.message : String(error))
        } finally {
          setSourceSyncBusy(false)
        }
      })()
    }, 450)
    return () => window.clearTimeout(handle)
  }, [entityId, form.sourceBody, loading, mode])

  useEffect(() => {
    if (loading || !hydratedRef.current || !structuredEditedRef.current) return
    if (skipSourceToFormRef.current) {
      skipSourceToFormRef.current = false
      return
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const shell: EntityRegistryDefinition = baseDef ?? {
            id: form.id.trim(),
            tenantId: "_default",
            displayName: "",
            description: "",
            rootTable: "",
            idColumn: "",
            labelColumn: null,
            selfJoinColumn: null,
            flowId: form.flowId.trim() || "metadataOnly",
            tables: [],
            policies: { freezeWindowIds: [] },
            scd2: { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null },
            lineageRefs: [],
            provenance: { kind: "manual" },
            legacyEntrySproc: null,
            reverseOrder: [],
            discrepancies: [],
            version: 0,
            versionLabel: null,
            createdBy: "",
            reason: "",
            createdAt: new Date().toISOString(),
            retiredAt: null,
          }
          const def = formStateToDefinition(shell, form)
          const { json } = await api.previewEntityRegistryJson(def)
          skipFormToSourceRef.current = true
          structuredEditedRef.current = false
          patch({ sourceBody: json })
        } catch {
          // keep current source when preview fails
        }
      })()
    }, 450)
    return () => window.clearTimeout(handle)
  }, [structuredFormKey, loading, baseDef, form, patch])

  const reservedIds = useMemo(() => new Set(reservedEntityIds), [reservedEntityIds])

  const missing = useMemo<string | null>(
    () => validateEntityEditForm(form, mode, reservedIds, sourceError),
    [form, mode, reservedIds, sourceError],
  )

  async function reloadSavedSource(): Promise<void> {
    if (mode !== "edit" || !entityId) return
    setErr(null)
    try {
      skipFormToSourceRef.current = true
      const source = await api.getEntityRegistryJson(entityId)
      patch({ sourceBody: source })
      setSourceError(null)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  const sourceFingerprint = useMemo(
    () => fingerprintPayload(form.sourceBody),
    [form.sourceBody],
  )

  const saveApplyEnabled = canApply({
    preview: savePreview,
    payloadFingerprint: savePreviewFingerprint,
    currentFingerprint: sourceFingerprint,
    reason: form.reason,
  })

  useEffect(() => {
    if (!confirmSaveOpen) {
      setSavePreview(null)
      setSavePreviewFingerprint(null)
      setSavePreviewErr(null)
      setSavePreviewBusy(false)
      return
    }
    const payload = form.sourceBody
    const fingerprint = fingerprintPayload(payload)
    let cancelled = false
    setSavePreviewBusy(true)
    setSavePreviewErr(null)
    void (async () => {
      try {
        const preview = await api.importEntityRegistryJson(payload, form.reason.trim() || "preview", {
          dryRun: true,
        })
        if (cancelled) return
        if (mode === "edit") {
          const previewId = preview.preview?.[0]?.def.id ?? preview.saved[0]?.id
          if (previewId && previewId !== entityId) {
            setSavePreview(null)
            setSavePreviewFingerprint(null)
            setSavePreviewErr(`Entity id must remain "${entityId}"`)
            setSavePreviewBusy(false)
            return
          }
        }
        setSavePreview(preview)
        setSavePreviewFingerprint(fingerprint)
        setSavePreviewErr(preview.ok ? null : preview.errors[0] ?? "Validation failed")
        setSavePreviewBusy(false)
      } catch (error) {
        if (cancelled) return
        setSavePreview(null)
        setSavePreviewFingerprint(null)
        setSavePreviewErr(error instanceof Error ? error.message : String(error))
        setSavePreviewBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [confirmSaveOpen, entityId, form.reason, form.sourceBody, mode])

  async function doSave(): Promise<void> {
    setErr(null)
    if (missing || !saveApplyEnabled) return
    setBusy(true)
    try {
      const result = await api.importEntityRegistryJson(form.sourceBody, form.reason.trim(), {
        dryRun: false,
      })
      if (!result.ok || result.rowErrors.length > 0) {
        const first = result.rowErrors[0]
        throw new Error(first ? formatSourceImportError(first) : result.errors[0] ?? "Save failed")
      }
      const saved = result.saved[0]
      if (!saved) throw new Error("Save produced no entity revision")
      onSaved(saved.id, saved.version)
      onClose()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      setConfirmSaveOpen(false)
    }
  }

  function requestSave(): void {
    if (missing || busy || loading || sourceSyncBusy) return
    setConfirmSaveOpen(true)
  }

  function discardFormChanges(): void {
    setForm(JSON.parse(JSON.stringify(formBaselineRef.current)) as EntityEditFormState)
    structuredEditedRef.current = false
    tablesUserEditedRef.current = false
    touchedFieldsRef.current = new Set()
    setConfirmSaveOpen(false)
  }

  return (
    <>
    <ModalShell
      title={mode === "new" ? "New entity" : `Edit · ${entityId}`}
      subtitle={
        mode === "edit" && initial
          ? `Revision ${initial.version} → ${initial.version + 1}`
          : "Edit Catalog entity"
      }
      icon={<FilePenLine size={20} className="text-text-muted" />}
      size="focus"
      onClose={onClose}
      footer={(
        <div className="flex w-full flex-wrap items-center gap-2">
          {err && (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-rose-300">
              <AlertTriangle className="h-3 w-3 shrink-0" /> {err}
            </div>
          )}
          {missing && !busy && !loading && (
            <span className="text-sm text-text-faint">{missing}</span>
          )}
          {sourceSyncBusy && !missing && (
            <span className="text-sm text-text-faint">Syncing source…</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={requestSave}
              disabled={busy || loading || sourceSyncBusy || missing !== null}
              title={missing ?? undefined}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {mode === "new" ? "Create" : "Save"}
            </button>
          </div>
        </div>
      )}
    >
      <div className="entity-registry flex min-h-0 flex-1 flex-col">
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
            <div className="min-h-0 shrink-0 overflow-auto border-b border-border-subtle p-5 lg:max-w-[min(36rem,42%)] lg:flex-1 lg:border-b-0 lg:border-r">
              <ul className={PANEL}>
                {sections.map((item) => (
                  <li
                    key={item.id}
                    className={[
                      "border-b border-border-subtle last:border-b-0",
                      section === item.id ? "bg-elevated" : "",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      onClick={() => setSection(item.id)}
                      className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-text">{item.label}</span>
                        <span className="mt-0.5 block truncate text-sm text-text-muted">{item.hint}</span>
                      </span>
                      {item.badge && (
                        <span className="shrink-0 rounded border border-border-subtle bg-panel px-1.5 py-0.5 text-xs text-text-muted">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-4 border-t border-border-subtle pt-4">
                <Field label="Reason for change">
                  <input
                    value={form.reason}
                    onChange={(e) => patch({ reason: e.target.value })}
                    placeholder="required"
                    className="input"
                  />
                </Field>
              </div>
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-5 lg:min-h-0">
              <div className="flex shrink-0 items-center justify-between gap-2">
                <div className={SECTION_TITLE}>{SECTION_LABELS[section]}</div>
                {section === "flow" && (
                  <button
                    type="button"
                    disabled={runtimeLoading}
                    onClick={() => setSyncMetadataOpen(true)}
                    className={ICON_BTN}
                    title="Configuration"
                    aria-label="Configuration"
                  >
                    <Workflow size={16} />
                  </button>
                )}
                {section === "scd2" && (
                  <button
                    type="button"
                    onClick={() => setStrategiesOpen(true)}
                    className={ICON_BTN}
                    title="Manage SCD2 strategies"
                    aria-label="Manage SCD2 strategies"
                  >
                    <GitBranch size={16} />
                  </button>
                )}
                {section === "policies" && (
                  <button
                    type="button"
                    onClick={() => setFreezeWindowsOpen(true)}
                    className={ICON_BTN}
                    title="Manage freeze windows"
                    aria-label="Manage freeze windows"
                  >
                    <CalendarClock size={16} />
                  </button>
                )}
              </div>
              {section === "source" ? (
                <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 text-sm text-text-muted">
                      Entity source — edits here stay in sync with Identity, Tables, Flow, and Configuration.
                    </p>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {mode === "new" && (
                        <button
                          type="button"
                          onClick={() => patch({ sourceBody: NEW_ENTITY_JSON_TEMPLATE })}
                          className={TEXT_BTN}
                        >
                          Load starter template
                        </button>
                      )}
                      {mode === "edit" && (
                        <button
                          type="button"
                          onClick={() => void reloadSavedSource()}
                          disabled={busy}
                          className={TEXT_BTN}
                        >
                          Reload saved JSON
                        </button>
                      )}
                    </div>
                  </div>
                  {sourceError && (
                    <div className="flex shrink-0 items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {sourceError}
                    </div>
                  )}
                  {!sourceError && form.sourceBody.trim() && !sourceSyncBusy && (
                    <p className="shrink-0 text-sm text-emerald-400/90">JSON is valid and synced with the structured sections.</p>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-base/40">
                    <EntityJsonSurface
                      loading={false}
                      body={form.sourceBody}
                      onBody={(sourceBody) => patch({ sourceBody })}
                      placeholder="Paste or edit EntityDefinition JSON…"
                    />
                  </div>
                </div>
              ) : (
              <div className="mt-4 min-h-0 flex-1 overflow-auto">
              {section === "identity" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Root table">
                      <input
                        value={form.rootTable}
                        onChange={(e) => patch({ rootTable: e.target.value })}
                        className="input font-mono text-sm"
                        placeholder="schema.TableName"
                      />
                      {mode === "new" && (suggestBusy || suggestNotes.length > 0) && (
                        <span className="mt-1 block text-sm text-text-muted">
                          {suggestBusy ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Suggesting from schema…
                            </span>
                          ) : (
                            suggestNotes[suggestNotes.length - 1]
                          )}
                        </span>
                      )}
                    </Field>
                    <Field label="Display name">
                      <input
                        value={form.displayName}
                        onChange={(e) => {
                          markTouched("displayName")
                          patch({ displayName: e.target.value })
                        }}
                        className="input text-sm"
                      />
                    </Field>
                    <Field label="Entity id">
                      <input
                        value={form.id}
                        onChange={(e) => {
                          markTouched("id")
                          patch({ id: e.target.value })
                        }}
                        disabled={mode === "edit"}
                        className="input font-mono text-sm"
                      />
                    </Field>
                    <Field label="ID column">
                      <input
                        value={form.idColumn}
                        onChange={(e) => {
                          markTouched("idColumn")
                          patch({ idColumn: e.target.value })
                        }}
                        className="input font-mono text-sm"
                      />
                    </Field>
                    <Field label="Label column">
                      <input
                        value={form.labelColumn}
                        onChange={(e) => {
                          markTouched("labelColumn")
                          patch({ labelColumn: e.target.value })
                        }}
                        className="input font-mono text-sm"
                        placeholder="optional"
                      />
                    </Field>
                    <Field label="Self-join column">
                      <input
                        value={form.selfJoinColumn}
                        onChange={(e) => {
                          markTouched("selfJoinColumn")
                          patch({ selfJoinColumn: e.target.value })
                        }}
                        className="input font-mono text-sm"
                        placeholder="optional"
                      />
                    </Field>
                  </div>
                  <Field label="Description">
                    <textarea
                      value={form.description}
                      onChange={(e) => {
                        markTouched("description")
                        patch({ description: e.target.value })
                      }}
                      rows={3}
                      className="input"
                    />
                  </Field>
                </div>
              )}

              {section === "scd2" && (
                <div>
                  <StrategySelect
                    key={`strategy-${governanceCatalogRev}`}
                    strategyId={form.strategyId}
                    strategyVersion={form.strategyVersion}
                    onStrategyId={(strategyId) => patch({ strategyId })}
                    onStrategyVersion={(strategyVersion) => patch({ strategyVersion })}
                  />
                </div>
              )}

              {section === "policies" && (
                <div className="space-y-4">
                  <p className="text-xs text-text-muted">
                    Block sync execute when a registered freeze window is active (e.g. month-end close).
                    Preview warns; execute refuses unless the operator overrides.
                  </p>
                  <div>
                    <span className={`mb-2 block ${FIELD_LABEL}`}>Freeze windows</span>
                    <FreezeWindowsSelect
                      key={`freezes-${governanceCatalogRev}`}
                      selected={form.freezeWindowIds} onSelected={(freezeWindowIds) => patch({ freezeWindowIds })} />
                  </div>
                </div>
              )}

              {section === "tables" && (
                <div className="space-y-3">
                  {mode === "new" && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-text-muted">
                        Tables are suggested from the FK graph when a schema catalog is available.
                      </p>
                      <button
                        type="button"
                        disabled={suggestBusy || !form.rootTable.trim()}
                        onClick={() => void applyDraftSuggestion(form.rootTable, { forceTables: true })}
                        className="rounded border border-border-subtle px-2.5 py-1 text-sm text-text-muted hover:bg-overlay-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {suggestBusy ? "Suggesting…" : "Suggest from schema"}
                      </button>
                    </div>
                  )}
                  <EntityTableListEditor
                    tables={form.tables}
                    entityContext={
                      form.rootTable.trim() && form.idColumn.trim()
                        ? { rootTable: form.rootTable.trim(), idColumn: form.idColumn.trim() }
                        : null
                    }
                    onTables={(tables) => {
                      tablesUserEditedRef.current = true
                      patch({ tables })
                    }}
                  />
                </div>
              )}

              {section === "flow" && (
                <div className="space-y-4">
                  <p className="text-sm text-text-muted">
                    Choose which flow recipe runs when this entity syncs. Edit flows, actions, and wiring in Configuration.
                  </p>
                  {runtimeLoading ? (
                    <div className="flex items-center gap-2 text-text-muted">
                      <Loader2 className="h-3 w-3 animate-spin" /> loading…
                    </div>
                  ) : (
                    <>
                      <Field label="Flow">
                        <Listbox
                          value={form.flowId as EntityRegistrySyncFlowTemplateId}
                          options={flowTemplateOptions}
                          onChange={(flowId) => {
                            markTouched("flowId")
                            patch({ flowId })
                          }}
                          className="w-full"
                          ariaLabel="Sync flow"
                        />
                      </Field>
                      <Field label="Flow steps">
                        <FlowStepsPreview flowId={form.flowId} steps={flowPreviewSteps} />
                      </Field>
                    </>
                  )}
                </div>
              )}
              </div>
              )}
            </div>
          </div>
        )}
      </div>
    </ModalShell>
    {confirmSaveOpen && (
      <ModalShell
        title={mode === "new" ? "Create entity?" : "Save entity changes?"}
        subtitle={mode === "edit" ? entityId : form.id.trim() || undefined}
        size="detail"
        stackLevel={1}
        onClose={() => setConfirmSaveOpen(false)}
        footer={(
          <div className="flex w-full flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={discardFormChanges}
              disabled={busy || savePreviewBusy}
              className={`${TEXT_BTN} text-rose-400 hover:text-rose-300`}
            >
              Discard changes
            </button>
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
                onClick={() => void doSave()}
                disabled={busy || savePreviewBusy || !saveApplyEnabled}
                title={
                  saveApplyEnabled
                    ? undefined
                    : "Validation must succeed for the current source before applying"
                }
                className={TEXT_BTN_PRIMARY}
              >
                {mode === "new" ? "Create entity" : "Save changes"}
              </button>
            </div>
          </div>
        )}
      >
        <div className="space-y-3 p-5">
          <p className="text-sm leading-relaxed text-text-muted">
            {mode === "new"
              ? "This creates a new entity definition in the registry via the same import gate used for JSON imports. Review impact below, then publish when you want sync environments to pick it up."
              : "This writes a new revision via the same import gate used for JSON imports. Publish separately so sync preview/execute use the new revision."}
          </p>
          {savePreviewBusy && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Validating source…
            </div>
          )}
          {savePreviewErr && <p className="text-sm text-error">{savePreviewErr}</p>}
          {savePreview && <ImportImpactPanel result={savePreview} />}
        </div>
      </ModalShell>
    )}
    {syncMetadataOpen && (
      <SyncMetadataModal
        stackLevel={1}
        onClose={() => setSyncMetadataOpen(false)}
        onChanged={() => void refreshRunCatalog()}
      />
    )}
    {freezeWindowsOpen && (
      <FreezeWindowsModal
        stackLevel={1}
        onClose={() => setFreezeWindowsOpen(false)}
        onChanged={() => setGovernanceCatalogRev((revision) => revision + 1)}
      />
    )}
    {strategiesOpen && (
      <StrategiesModal
        stackLevel={1}
        onClose={() => setStrategiesOpen(false)}
        onChanged={() => setGovernanceCatalogRev((revision) => revision + 1)}
        initialStrategyId={form.strategyId || null}
      />
    )}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  )
}

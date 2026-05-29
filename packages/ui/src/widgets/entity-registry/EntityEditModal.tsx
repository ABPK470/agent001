/**
 * EntityEditModal — admin-only New/Edit for an EntityDefinition.
 *
 * Two equivalent authoring surfaces, switchable via the in-modal tab:
 *
 *   ┌─ Form ──┬─ YAML body ──┐
 *
 *  - Form:  structured fields, posts via `saveEntityRegistry`.
 *  - YAML:  full document editor, posts via `importEntityRegistryYaml`.
 *
 * Edit mode + YAML tab: body is lazy-loaded from
 * `getEntityRegistryYaml(id)` the first time the operator switches.
 * New mode + YAML tab: seeded from a minimal template.
 *
 * Both paths require a `reason` for the audit trail; server stamps
 * version / createdBy / createdAt.
 */

import { AlertTriangle, FileCode2, FormInput, Loader2, Save } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { AuthoredSyncFlowStep, EntityRegistryDefinition, EntityRegistrySyncFlowPreset, SyncDefinitionAdminItem, SyncDefinitionRuntimeOptions } from "../../types"
import { deriveDisplayName, deriveEntityId, deriveIdColumn } from "./derive"
import { FormSurface, FormSurfaceExecutionSteps, YamlSurface } from "./EntityEditSurfaces"
import { ModalShell } from "./ModalShell"

export interface EntityEditModalProps {
  mode:    "new" | "edit"
  initial: EntityRegistryDefinition | null
  onClose: () => void
  onSaved: (id: string, version: number) => void
}

type AuthoringMode = "form" | "yaml"

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/
const FLOW_PRESETS: EntityRegistrySyncFlowPreset[] = ["contract", "dataset", "rule", "pipelineActivity", "gateMetadata", "content", "metadata-only"]
const FLOW_PRESET_LABELS: Record<EntityRegistrySyncFlowPreset, string> = {
  contract: "Contract deploy",
  dataset: "Dataset deploy",
  rule: "Rule deploy",
  pipelineActivity: "Pipeline register",
  gateMetadata: "Gate refresh",
  content: "Content dependencies",
  "metadata-only": "Metadata only",
}
const DEFAULT_RUNTIME_OPTIONS: SyncDefinitionRuntimeOptions = {
  flowPresets: FLOW_PRESETS.map((preset) => ({ id: preset, label: FLOW_PRESET_LABELS[preset], description: null })),
  flowPresetTemplates: Object.fromEntries(FLOW_PRESETS.map((preset) => [preset, []])) as SyncDefinitionRuntimeOptions["flowPresetTemplates"],
  serviceProfiles: [{ id: "default", label: "Default service routing", description: "Use the standard environment-resolved service endpoints." }],
  environmentPolicies: [{ id: "default", label: "Default environment rules", description: "Apply the standard environment access and allowlist checks." }],
}

const NEW_ENTITY_YAML_TEMPLATE = `# Required fields. See the YAML tab of an existing entity for a full example.
id: my-entity
tenantId: _default
displayName: My Entity
description: ""
rootTable: schema.MyTable
idColumn: myEntityId
scd2:
  strategyId: mymi-scd2
  strategyVersion: latest
tables: []
policies:
  freezeWindowIds: []
  riskMultiplier: 1
provenance:
  kind: manual
`

function emptyDef(): EntityRegistryDefinition {
  return {
    id:               "",
    tenantId:         "_default",
    displayName:      "",
    description:      "",
    rootTable:        "",
    idColumn:         "",
    labelColumn:      null,
    selfJoinColumn:   null,
    tables:           [],
    policies:         { freezeWindowIds: [], riskMultiplier: 1.0 },
    scd2:             { strategyId: "mymi-scd2", strategyVersion: "latest", entityOverride: null },
    lineageRefs:      [],
    provenance:       { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder:     [],
    discrepancies:    [],
    version:          0,
    versionLabel:     null,
    createdBy:        "",
    reason:           "",
    createdAt:        "",
    retiredAt:        null,
  }
}

export function EntityEditModal({ mode, initial, onClose, onSaved }: EntityEditModalProps): JSX.Element {
  const seed = useMemo<EntityRegistryDefinition>(() => initial ?? emptyDef(), [initial])

  const [authoring,    setAuthoring]    = useState<AuthoringMode>("form")
  const [reason,       setReason]       = useState("")
  const [versionLabel, setVersionLabel] = useState("")
  const [busy,         setBusy]         = useState(false)
  const [err,          setErr]          = useState<string | null>(null)

  // Form-mode field state.
  const [id,             setId]             = useState(seed.id)
  const [displayName,    setDisplayName]    = useState(seed.displayName)
  const [description,    setDescription]    = useState(seed.description)
  const [rootTable,      setRootTable]      = useState(seed.rootTable)
  const [idColumn,       setIdColumn]       = useState(seed.idColumn)
  const [labelColumn,    setLabelColumn]    = useState(seed.labelColumn ?? "")
  const [selfJoinColumn, setSelfJoinColumn] = useState(seed.selfJoinColumn ?? "")
  const [strategyId,     setStrategyId]     = useState(seed.scd2.strategyId)
  const [strategyVersion, setStrategyVersion] = useState<number | "latest">(seed.scd2.strategyVersion ?? "latest")
  const [freezeWindowIds, setFreezeWindowIds]   = useState<readonly string[]>(seed.policies.freezeWindowIds ?? [])
  const [riskMultiplier, setRiskMultiplier] = useState(String(seed.policies.riskMultiplier))
  const [tablesJson,     setTablesJson]     = useState(JSON.stringify(seed.tables, null, 2))

  // YAML-mode body state. Lazy-loaded for edit mode on first tab switch.
  const [yamlBody,    setYamlBody]    = useState<string>(mode === "new" ? NEW_ENTITY_YAML_TEMPLATE : "")
  const [yamlLoading, setYamlLoading] = useState(false)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [runtimeOptions, setRuntimeOptions] = useState<SyncDefinitionRuntimeOptions>(DEFAULT_RUNTIME_OPTIONS)
  const [flowPreset, setFlowPreset] = useState<EntityRegistrySyncFlowPreset>(defaultRuntimeFlowPreset(seed.id))
  const [executionSteps, setExecutionSteps] = useState<AuthoredSyncFlowStep[]>([])
  const [serviceProfileRef, setServiceProfileRef] = useState("default")
  const [environmentPolicyRef, setEnvironmentPolicyRef] = useState("default")

  // Auto-derive id / displayName / idColumn from rootTable in `new` mode,
  // but only as long as the operator hasn't manually overridden each one.
  // We track per-field "touched" flags so user edits stop the derivation
  // for that specific field — both directions remain editable.
  const touched = useRef({ id: false, displayName: false, idColumn: false })
  useEffect(() => {
    if (mode !== "new") return
    const r = rootTable.trim()
    if (!r) return
    if (!touched.current.id)          setId(deriveEntityId(r))
    if (!touched.current.displayName) setDisplayName(deriveDisplayName(r))
    if (!touched.current.idColumn)    setIdColumn(deriveIdColumn(r))
  }, [rootTable, mode])

  function handleIdChange(v: string)          { touched.current.id          = true; setId(v) }
  function handleDisplayNameChange(v: string) { touched.current.displayName = true; setDisplayName(v) }
  function handleIdColumnChange(v: string)    { touched.current.idColumn    = true; setIdColumn(v) }

  useEffect(() => {
    if (authoring !== "yaml" || mode !== "edit" || yamlBody) return
    setYamlLoading(true)
    void api.getEntityRegistryYaml(seed.id)
      .then((y) => setYamlBody(y))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setYamlLoading(false))
  }, [authoring, mode, seed.id, yamlBody])

  useEffect(() => {
    let cancelled = false
    setRuntimeLoading(true)
    void Promise.all([
      api.getSyncDefinitionConfigOptions(),
      mode === "edit" ? api.listSyncDefinitionConfigs() : Promise.resolve<SyncDefinitionAdminItem[]>([]),
    ])
      .then(([options, rows]) => {
        if (cancelled) return
        setRuntimeOptions(options)
        const config = rows.find((row) => row.id === seed.id)
        if (config) hydrateRuntimeConfig(config, options)
        else {
          const selectedPreset = pickRuntimeValue(options.flowPresets, defaultRuntimeFlowPreset(seed.id), "metadata-only")
          setFlowPreset(selectedPreset)
          setExecutionSteps(cloneSteps(options.flowPresetTemplates[selectedPreset] ?? []))
          setServiceProfileRef(pickRuntimeValue(options.serviceProfiles, "default"))
          setEnvironmentPolicyRef(pickRuntimeValue(options.environmentPolicies, "default"))
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setRuntimeLoading(false)
      })
    return () => { cancelled = true }
  }, [mode, seed.id])

  const flowPresetOptions = useMemo<ListboxOption<EntityRegistrySyncFlowPreset>[]>(() => runtimeOptions.flowPresets.map((option) => ({
    value: option.id,
    label: option.label,
    hint: option.description ?? undefined,
  })), [runtimeOptions.flowPresets])
  const serviceProfileOptions = useMemo<ListboxOption<string>[]>(() => runtimeOptions.serviceProfiles.map((option) => ({
    value: option.id,
    label: option.label,
    hint: option.description ?? undefined,
  })), [runtimeOptions.serviceProfiles])
  const environmentPolicyOptions = useMemo<ListboxOption<string>[]>(() => runtimeOptions.environmentPolicies.map((option) => ({
    value: option.id,
    label: option.label,
    hint: option.description ?? undefined,
  })), [runtimeOptions.environmentPolicies])

  async function doSave() {
    setErr(null)
    if (!reason.trim()) return setErr("reason is required (saved with the audit trail)")
    setBusy(true)
    try {
      if (authoring === "yaml") await saveViaYaml()
      else                      await saveViaForm()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveViaForm() {
    if (!ID_RE.test(id))     throw new Error(`id: must match ${ID_RE} (kebab-case, lowercase)`)
    if (!displayName.trim()) throw new Error("displayName is required")
    if (!rootTable.trim())   throw new Error("rootTable is required (e.g. core.Contract)")
    if (!idColumn.trim())    throw new Error("idColumn is required")

    let tables: EntityRegistryDefinition["tables"]
    try { tables = JSON.parse(tablesJson) }
    catch (e) { throw new Error(`tables JSON parse error: ${(e as Error).message}`) }
    if (!Array.isArray(tables)) throw new Error("tables must be a JSON array")

    const riskNum = Number(riskMultiplier)
    if (!Number.isFinite(riskNum) || riskNum <= 0) throw new Error("riskMultiplier must be a positive number")

    const def: EntityRegistryDefinition = {
      ...seed,
      id,
      displayName,
      description,
      rootTable,
      idColumn,
      labelColumn:    labelColumn.trim()    || null,
      selfJoinColumn: selfJoinColumn.trim() || null,
      tables,
      policies: {
        ...seed.policies,
        freezeWindowIds: [...freezeWindowIds],
        riskMultiplier:  riskNum,
      },
      scd2: { ...seed.scd2, strategyId, strategyVersion },
    }
    const r = await api.saveEntityRegistry(def, reason, versionLabel.trim() ? { versionLabel } : undefined)
    await api.updateSyncDefinitionConfig(r.id, {
      flowPreset,
      executionSteps,
      serviceProfileRef,
      environmentPolicyRef,
    })
    onSaved(r.id, r.version)
    onClose()
  }

  async function saveViaYaml() {
    if (!yamlBody.trim()) throw new Error("YAML body is empty")
    const r = await api.importEntityRegistryYaml(yamlBody, reason)
    if (!r.ok || r.errors.length > 0) {
      const first = r.errors[0]
      throw new Error(
        first
          ? `${first.id ?? "(parse)"}: ${typeof first.error === "string" ? first.error : JSON.stringify(first.error.errors)}`
          : "import failed",
      )
    }
    const saved = r.saved[0]
    if (!saved) throw new Error("import returned no saved entity")
    await api.updateSyncDefinitionConfig(saved.id, {
      flowPreset,
      executionSteps,
      serviceProfileRef,
      environmentPolicyRef,
    })
    onSaved(saved.id, saved.version)
    onClose()
  }

  // Surface what's blocking save on the button itself rather than
  // sprinkling red asterisks all over the form.
  const missing: string | null = (() => {
    if (authoring === "yaml") {
      if (!yamlBody.trim()) return "Paste a YAML body"
      if (!reason.trim())   return "Add a reason for change"
      return null
    }
    if (!rootTable.trim())   return "Pick a root table"
    if (!displayName.trim()) return "Give it a display name"
    if (!ID_RE.test(id))     return "Identifier needs a tweak (advanced)"
    if (!idColumn.trim())    return "Identifier column missing (advanced)"
    if (!reason.trim())      return "Add a reason for change"
    return null
  })()

  return (
    <ModalShell
      title={mode === "new" ? "New entity" : `Edit entity · ${seed.id}`}
      subtitle={mode === "edit" ? `v${seed.version} → v${seed.version + 1}` : undefined}
      onClose={onClose}
      widthClass="max-w-5xl"
      footer={
        <>
          {err && (
            <div className="flex items-center gap-2 text-xs text-rose-300">
              <AlertTriangle className="h-3 w-3" /> {err}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {missing && !busy && (
              <span className="text-[11px] text-text-faint">{missing}</span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
            >Cancel</button>
            <button
              type="button"
              onClick={() => void doSave()}
              disabled={busy || missing !== null || (authoring === "yaml" && yamlLoading)}
              title={missing ?? undefined}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {mode === "new" ? "Create" : "Save new version"}
            </button>
          </div>
        </>
      }
    >
      <ModeToggle value={authoring} onChange={setAuthoring} />

      {authoring === "form" ? (
        <FormSurface
          mode={mode}
          id={id}                         onId={handleIdChange}
          displayName={displayName}       onDisplayName={handleDisplayNameChange}
          description={description}       onDescription={setDescription}
          rootTable={rootTable}           onRootTable={setRootTable}
          idColumn={idColumn}             onIdColumn={handleIdColumnChange}
          labelColumn={labelColumn}       onLabelColumn={setLabelColumn}
          selfJoinColumn={selfJoinColumn} onSelfJoinColumn={setSelfJoinColumn}
          strategyId={strategyId}         onStrategyId={setStrategyId}
          strategyVersion={strategyVersion} onStrategyVersion={setStrategyVersion}
          freezeWindowIds={freezeWindowIds}   onFreezeWindowIds={setFreezeWindowIds}
          riskMultiplier={riskMultiplier} onRiskMultiplier={setRiskMultiplier}
          tablesJson={tablesJson}         onTablesJson={setTablesJson}
          flowPreset={flowPreset}         onFlowPreset={setFlowPresetChange}
          flowPresetOptions={flowPresetOptions}
          executionSteps={executionSteps} onExecutionSteps={setExecutionSteps}
          serviceProfileRef={serviceProfileRef} onServiceProfileRef={setServiceProfileRef}
          serviceProfileOptions={serviceProfileOptions}
          environmentPolicyRef={environmentPolicyRef} onEnvironmentPolicyRef={setEnvironmentPolicyRef}
          environmentPolicyOptions={environmentPolicyOptions}
          runtimeLoading={runtimeLoading}
          reason={reason}                 onReason={setReason}
          versionLabel={versionLabel}     onVersionLabel={setVersionLabel}
        />
      ) : (
        <div className="flex h-full flex-col">
          <YamlSurface
            loading={yamlLoading}
            body={yamlBody}
            onBody={setYamlBody}
            reason={reason}
            onReason={setReason}
          />
          <div className="border-t border-border-subtle px-6 py-4">
            <RuntimeConfigSection
              flowPreset={flowPreset}
              onFlowPreset={setFlowPresetChange}
              flowPresetOptions={flowPresetOptions}
              executionSteps={executionSteps}
              onExecutionSteps={setExecutionSteps}
              rootTable={rootTable}
              serviceProfileRef={serviceProfileRef}
              onServiceProfileRef={setServiceProfileRef}
              serviceProfileOptions={serviceProfileOptions}
              environmentPolicyRef={environmentPolicyRef}
              onEnvironmentPolicyRef={setEnvironmentPolicyRef}
              environmentPolicyOptions={environmentPolicyOptions}
              loading={runtimeLoading}
            />
          </div>
        </div>
      )}
    </ModalShell>
  )

  function hydrateRuntimeConfig(config: SyncDefinitionAdminItem, options: SyncDefinitionRuntimeOptions): void {
    const selectedPreset = pickRuntimeValue(options.flowPresets, config.flowPreset, "metadata-only")
    setFlowPreset(selectedPreset)
    setExecutionSteps(cloneSteps(config.executionSteps.length > 0 ? config.executionSteps : (options.flowPresetTemplates[selectedPreset] ?? [])))
    setServiceProfileRef(pickRuntimeValue(options.serviceProfiles, config.serviceProfileRef))
    setEnvironmentPolicyRef(pickRuntimeValue(options.environmentPolicies, config.environmentPolicyRef))
  }

  function setFlowPresetChange(value: EntityRegistrySyncFlowPreset): void {
    setFlowPreset(value)
    setExecutionSteps(cloneSteps(runtimeOptions.flowPresetTemplates[value] ?? []))
  }
}

function cloneSteps(steps: AuthoredSyncFlowStep[]): AuthoredSyncFlowStep[] {
  return steps.map((step) => ({ ...step }))
}

function pickRuntimeValue<T extends string>(
  options: Array<{ id: T }>,
  value: string,
  fallback?: T,
): T {
  const match = options.find((option) => option.id === value)
  if (match) return match.id
  if (fallback) return fallback
  return options[0]?.id ?? value as T
}

// ── Mode toggle ────────────────────────────────────────────────────

function ModeToggle({ value, onChange }: { value: AuthoringMode; onChange: (m: AuthoringMode) => void }): JSX.Element {
  const item = (m: AuthoringMode, label: string, Icon: typeof FormInput) => (
    <button
      key={m}
      type="button"
      onClick={() => onChange(m)}
      className={[
        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
        value === m ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-3 w-3" /> {label}
    </button>
  )
  return (
    <nav className="flex items-center gap-0.5 border-b border-border-subtle bg-panel px-4">
      {item("form", "Form",      FormInput)}
      {item("yaml", "YAML body", FileCode2)}
    </nav>
  )
}

function defaultRuntimeFlowPreset(entityId: string): EntityRegistrySyncFlowPreset {
  return FLOW_PRESETS.includes(entityId as EntityRegistrySyncFlowPreset)
    ? entityId as EntityRegistrySyncFlowPreset
    : "metadata-only"
}

function RuntimeConfigSection({
  flowPreset,
  onFlowPreset,
  flowPresetOptions,
  executionSteps,
  onExecutionSteps,
  rootTable,
  serviceProfileRef,
  onServiceProfileRef,
  serviceProfileOptions,
  environmentPolicyRef,
  onEnvironmentPolicyRef,
  environmentPolicyOptions,
  loading,
}: {
  flowPreset: EntityRegistrySyncFlowPreset
  onFlowPreset: (value: EntityRegistrySyncFlowPreset) => void
  flowPresetOptions: ListboxOption<EntityRegistrySyncFlowPreset>[]
  executionSteps: AuthoredSyncFlowStep[]
  onExecutionSteps: (value: AuthoredSyncFlowStep[]) => void
  rootTable: string
  serviceProfileRef: string
  onServiceProfileRef: (value: string) => void
  serviceProfileOptions: ListboxOption<string>[]
  environmentPolicyRef: string
  onEnvironmentPolicyRef: (value: string) => void
  environmentPolicyOptions: ListboxOption<string>[]
  loading: boolean
}): JSX.Element {
  return (
    <section className="rounded-lg border border-border-subtle bg-panel/60 p-4">
      <div className="mb-3">
        <h3 className="text-xs font-medium text-text">Sync behavior</h3>
        <p className="mt-1 text-[11px] text-text-faint">Save stores this with the entity. Publish later makes it live for preview and execute.</p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> loading current runtime config...
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Sync behavior</span>
            <Listbox value={flowPreset} options={flowPresetOptions} onChange={onFlowPreset} className="w-full" ariaLabel="Sync behavior" />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Service profile</span>
              <Listbox value={serviceProfileRef} options={serviceProfileOptions} onChange={onServiceProfileRef} className="w-full" ariaLabel="Service profile" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Environment rules</span>
              <Listbox value={environmentPolicyRef} options={environmentPolicyOptions} onChange={onEnvironmentPolicyRef} className="w-full" ariaLabel="Environment rules" />
            </label>
          </div>
          <div className="rounded-lg border border-border-subtle bg-panel/40 p-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Execution steps</div>
            <FormSurfaceExecutionSteps executionSteps={executionSteps} onExecutionSteps={onExecutionSteps} rootTable={rootTable} />
          </div>
        </div>
      )}
    </section>
  )
}

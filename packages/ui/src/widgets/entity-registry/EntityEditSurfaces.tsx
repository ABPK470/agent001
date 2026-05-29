/**
 * Authoring surfaces for `EntityEditModal`.
 *
 * The Form surface is built around a single principle: humans should
 * not type identifiers. The operator picks a real-world root table,
 * and we silently derive `id`, `displayName`, and `idColumn` from it.
 * Those derived fields live inside the *Identifiers* disclosure for
 * power users who need to override them — the day-one user never
 * sees them.
 *
 * Required-ness is communicated by the disabled Save button (which
 * names what's missing) rather than red asterisks on every label.
 */

import { ChevronDown, FileCode2, Loader2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useState } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { AuthoredSyncFlowStep, EntityRegistrySyncFlowPreset } from "../../types"
import { FreezeWindowsSelect } from "./FreezeWindowsSelect"
import { StrategySelect } from "./StrategySelect"

const FLOW_PHASE_OPTIONS: ListboxOption<AuthoredSyncFlowStep["phase"]>[] = [
  { value: "pre-transaction", label: "Pre-transaction" },
  { value: "metadata", label: "Metadata" },
  { value: "post-metadata", label: "Post-metadata" },
  { value: "post-commit", label: "Post-commit" },
]

const FLOW_KIND_OPTIONS: ListboxOption<AuthoredSyncFlowStep["kind"]>[] = [
  "metadataSync",
  "auditCheck",
  "targetLock",
  "targetUnlock",
  "contractUndeploy",
  "contractPreScript",
  "contractCreateStageDataset",
  "contractCreateArchiveDataset",
  "contractCreateListDataset",
  "contractCreateDimDataset",
  "contractCreateFactDataset",
  "contractCreateDatasetFks",
  "contractDeployEtl",
  "contractDeployRoutine",
  "contractPostScript",
  "datasetDeploy",
  "rulesDeploy",
  "pipelineRegister",
  "metaRefresh",
  "pipelineStart",
  "handleDependencies",
  "syncDate",
  "deployDate",
].map((value) => ({ value, label: value }))

const SUBJECT_REF_OPTIONS: ListboxOption<NonNullable<AuthoredSyncFlowStep["subjectRef"]>>[] = [
  { value: "entityId", label: "Entity id" },
  { value: "ruleInputDatasetId", label: "Rule input dataset id" },
  { value: "contractPipelineId", label: "Contract pipeline id" },
]

const AUDIT_OBJECT_TYPE_OPTIONS: ListboxOption<string>[] = [
  { value: "Contract", label: "Contract" },
  { value: "Dataset", label: "Dataset" },
  { value: "Rule", label: "Rule" },
]

const OBJECT_NAME_OPTIONS: ListboxOption<string>[] = [
  { value: "content", label: "content" },
  { value: "rule", label: "rule" },
]

// ── Form ──────────────────────────────────────────────────────────

export interface FormSurfaceProps {
  mode: "new" | "edit"
  id: string;              onId: (v: string) => void
  displayName: string;     onDisplayName: (v: string) => void
  description: string;     onDescription: (v: string) => void
  rootTable: string;       onRootTable: (v: string) => void
  idColumn: string;        onIdColumn: (v: string) => void
  labelColumn: string;     onLabelColumn: (v: string) => void
  selfJoinColumn: string;  onSelfJoinColumn: (v: string) => void
  strategyId: string;      onStrategyId: (v: string) => void
  strategyVersion: number | "latest"; onStrategyVersion: (v: number | "latest") => void
  freezeWindowIds: readonly string[]; onFreezeWindowIds: (v: string[]) => void
  riskMultiplier: string;  onRiskMultiplier: (v: string) => void
  tablesJson: string;      onTablesJson: (v: string) => void
  flowPreset: EntityRegistrySyncFlowPreset; onFlowPreset: (v: EntityRegistrySyncFlowPreset) => void
  flowPresetOptions: ListboxOption<EntityRegistrySyncFlowPreset>[]
  executionSteps: AuthoredSyncFlowStep[]; onExecutionSteps: (v: AuthoredSyncFlowStep[]) => void
  rootTable: string
  serviceProfileRef: string; onServiceProfileRef: (v: string) => void
  serviceProfileOptions: ListboxOption<string>[]
  environmentPolicyRef: string; onEnvironmentPolicyRef: (v: string) => void
  environmentPolicyOptions: ListboxOption<string>[]
  runtimeLoading: boolean
  reason: string;          onReason: (v: string) => void
  versionLabel: string;    onVersionLabel: (v: string) => void
}

export function FormSurface(p: FormSurfaceProps): JSX.Element {
  return (
    <div className="space-y-4 p-6 text-xs">
      {/* ── Basics ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BigField label="Root table">
          <input
            value={p.rootTable}
            onChange={(e) => p.onRootTable(e.target.value)}
            placeholder="schema.TableName"
            className="input font-mono text-sm py-2.5"
            autoFocus={p.mode === "new"}
          />
        </BigField>

        <BigField label="Display name">
          <input
            value={p.displayName}
            onChange={(e) => p.onDisplayName(e.target.value)}
            placeholder=""
            className="input py-2.5"
          />
        </BigField>
      </div>

      <BigField label="Description">
        <textarea
          value={p.description}
          onChange={(e) => p.onDescription(e.target.value)}
          rows={2}
          placeholder=""
          className="input font-sans py-2"
        />
      </BigField>

      {/* ── Advanced disclosures ───────────────────────────────── */}
      <Disclosure
        title="Identifiers"
        summary={summary([
          ["id",       p.id || "—"],
          ["idColumn", p.idColumn || "—"],
          p.labelColumn ? ["labelColumn", p.labelColumn] : null,
        ])}
        defaultOpen={p.mode === "edit"}
      >
        <Grid2>
          <Field label="id" mono>
            <input
              value={p.id}
              onChange={(e) => p.onId(e.target.value)}
              disabled={p.mode === "edit"}
              className="input"
            />
          </Field>
          <Field label="idColumn" mono>
            <input value={p.idColumn} onChange={(e) => p.onIdColumn(e.target.value)} className="input" />
          </Field>
          <Field label="labelColumn" mono>
            <input value={p.labelColumn} onChange={(e) => p.onLabelColumn(e.target.value)} placeholder="optional" className="input" />
          </Field>
          <Field label="selfJoinColumn" mono>
            <input value={p.selfJoinColumn} onChange={(e) => p.onSelfJoinColumn(e.target.value)} placeholder="optional" className="input" />
          </Field>
        </Grid2>
      </Disclosure>

      <Disclosure
        title="SCD2 strategy"
        summary={`${p.strategyId} · ${p.strategyVersion === "latest" ? "latest" : `v${p.strategyVersion}`}`}
      >
        <StrategySelect
          strategyId={p.strategyId}
          strategyVersion={p.strategyVersion}
          onStrategyId={p.onStrategyId}
          onStrategyVersion={p.onStrategyVersion}
        />
      </Disclosure>

      <Disclosure
        title="Sync behavior"
        summary={summary([
          ["mode", p.flowPreset],
          ["steps", `${p.executionSteps.length}`],
          ["service", p.serviceProfileRef || "default"],
          ["env", p.environmentPolicyRef || "default"],
        ])}
        defaultOpen
      >
        {p.runtimeLoading ? (
          <div className="flex items-center gap-2 text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> loading current runtime config…
          </div>
        ) : (
          <>
            <Grid2>
              <Field label="Sync behavior">
                <Listbox value={p.flowPreset} options={p.flowPresetOptions} onChange={p.onFlowPreset} className="w-full" ariaLabel="Sync behavior" />
              </Field>
              <Field label="Service profile">
                <Listbox value={p.serviceProfileRef} options={p.serviceProfileOptions} onChange={p.onServiceProfileRef} className="w-full" ariaLabel="Service profile" />
              </Field>
              <Field label="Environment rules">
                <Listbox value={p.environmentPolicyRef} options={p.environmentPolicyOptions} onChange={p.onEnvironmentPolicyRef} className="w-full" ariaLabel="Environment rules" />
              </Field>
            </Grid2>
            <div className="mt-3 rounded-lg border border-border-subtle bg-panel/40 p-3">
              <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Execution steps</div>
              <FormSurfaceExecutionSteps executionSteps={p.executionSteps} onExecutionSteps={p.onExecutionSteps} rootTable={p.rootTable} />
            </div>
          </>
        )}
      </Disclosure>

      <Disclosure
        title="Sync policies"
        summary={summary([
          ["risk×",         p.riskMultiplier],
          p.freezeWindowIds.length ? ["freezes", `${p.freezeWindowIds.length}`] : null,
        ])}
      >
        <Grid2>
          <Field label="Risk multiplier">
            <input value={p.riskMultiplier} onChange={(e) => p.onRiskMultiplier(e.target.value)} className="input" />
          </Field>
        </Grid2>
        <div className="mt-3">
          <FieldLabel label="Freeze windows" />
          <FreezeWindowsSelect
            selected={p.freezeWindowIds}
            onSelected={p.onFreezeWindowIds}
          />
        </div>
      </Disclosure>

      <Disclosure
        title="Tables (advanced JSON)"
        summary={tablesSummary(p.tablesJson)}
        icon={<FileCode2 className="h-3 w-3 text-text-faint" />}
      >
        <textarea
          value={p.tablesJson}
          onChange={(e) => p.onTablesJson(e.target.value)}
          rows={10}
          className="input font-mono text-[11px]"
          spellCheck={false}
        />
      </Disclosure>

      {/* ── Audit ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border-subtle bg-panel/60 p-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Reason for change">
          <input
            value={p.reason}
            onChange={(e) => p.onReason(e.target.value)}
            placeholder="e.g. add risk-tier column"
            className="input"
          />
        </Field>
        <Field label="Version label">
          <input
            value={p.versionLabel}
            onChange={(e) => p.onVersionLabel(e.target.value)}
            placeholder="optional"
            className="input"
          />
        </Field>
      </div>
    </div>
  )
}

// ── YAML ──────────────────────────────────────────────────────────

export interface YamlSurfaceProps {
  loading: boolean
  body: string;   onBody: (v: string) => void
  reason: string; onReason: (v: string) => void
}

export function YamlSurface({ loading, body, onBody, reason, onReason }: YamlSurfaceProps): JSX.Element {
  return (
    <div className="flex h-full flex-col gap-3 p-6 text-xs">
      {loading && (
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> loading…
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        spellCheck={false}
        placeholder={"id: my-entity\ntenantId: _default\n..."}
        className="input flex-1 min-h-0 resize-none font-mono text-[11px]"
      />
      <Field label="Reason for change">
        <input value={reason} onChange={(e) => onReason(e.target.value)} placeholder="e.g. backfill schema" className="input" />
      </Field>
    </div>
  )
}

// ── Layout primitives ─────────────────────────────────────────────

function BigField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text">{label}</span>
      {children}
    </label>
  )
}

function Disclosure({ title, summary, defaultOpen, icon, children }: {
  title: string; summary: string; defaultOpen?: boolean; icon?: ReactNode; children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <section className="rounded-lg border border-border-subtle bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-overlay-2/40"
      >
        <span className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-xs font-medium text-text">{title}</span>
          <span className="truncate text-[11px] text-text-faint">· {summary}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t border-border-subtle p-4">{children}</div>}
    </section>
  )
}

function Grid2({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
}

function FieldLabel({ label }: { label: string }): JSX.Element {
  return (
    <span className="mb-1 block text-[10px] uppercase tracking-wider text-text-muted">
      {label}
    </span>
  )
}

function Field({ label, children, mono }: {
  label: string; children: ReactNode; mono?: boolean
}): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 ${mono ? "font-mono" : ""}`}>
      <FieldLabel label={label} />
      {children}
    </label>
  )
}

export function FormSurfaceExecutionSteps({
  executionSteps,
  onExecutionSteps,
  rootTable,
}: {
  executionSteps: AuthoredSyncFlowStep[]
  onExecutionSteps: (value: AuthoredSyncFlowStep[]) => void
  rootTable: string
}): JSX.Element {
  function patchStep(index: number, patch: Partial<AuthoredSyncFlowStep>): void {
    onExecutionSteps(executionSteps.map((step, current) => current === index ? normalizeStep({ ...step, ...patch }, rootTable) : step))
  }

  function removeStep(index: number): void {
    onExecutionSteps(executionSteps.filter((_, current) => current !== index))
  }

  function addStep(): void {
    const next = executionSteps.length + 1
    onExecutionSteps([
      ...executionSteps,
      normalizeStep({
        id: `step-${next}`,
        phase: "metadata",
        kind: "metadataSync",
        title: `Step ${next}`,
        description: "",
      }, rootTable),
    ])
  }

  return (
    <div className="space-y-3">
      {executionSteps.length === 0 && (
        <div className="text-[11px] text-text-muted">No execution steps defined yet.</div>
      )}
      {executionSteps.map((step, index) => (
        <div key={`${step.id}-${index}`} className="rounded-lg border border-border-subtle bg-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[11px] font-medium text-text">Step {index + 1}</div>
            <button type="button" onClick={() => removeStep(index)} className="rounded border border-border-subtle px-2 py-1 text-[10px] text-text-muted hover:bg-overlay-2 hover:text-text">Remove</button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="id" mono>
              <input value={step.id} onChange={(e) => patchStep(index, { id: e.target.value })} className="input" />
            </Field>
            <Field label="phase">
              <Listbox value={step.phase} options={FLOW_PHASE_OPTIONS} onChange={(phase) => patchStep(index, { phase })} className="w-full" ariaLabel={`Execution step ${index + 1} phase`} />
            </Field>
            <Field label="kind">
              <Listbox value={step.kind} options={FLOW_KIND_OPTIONS} onChange={(kind) => patchStep(index, { kind })} className="w-full" ariaLabel={`Execution step ${index + 1} kind`} />
            </Field>
            {usesSubjectRef(step.kind) && (
              <Field label="subject ref">
                <Listbox
                  value={(step.subjectRef ?? defaultSubjectRef(step.kind)) as NonNullable<AuthoredSyncFlowStep["subjectRef"]>}
                  options={SUBJECT_REF_OPTIONS}
                  onChange={(subjectRef) => patchStep(index, { subjectRef })}
                  className="w-full"
                  ariaLabel={`Execution step ${index + 1} subject ref`}
                />
              </Field>
            )}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="title">
              <input value={step.title} onChange={(e) => patchStep(index, { title: e.target.value })} className="input" />
            </Field>
            {usesAuditObjectType(step.kind) && (
              <Field label="Audit object type">
                <Listbox
                  value={step.auditObjectType ?? defaultAuditObjectType(step.kind)}
                  options={AUDIT_OBJECT_TYPE_OPTIONS}
                  onChange={(auditObjectType) => patchStep(index, { auditObjectType })}
                  className="w-full"
                  ariaLabel={`Execution step ${index + 1} audit object type`}
                />
              </Field>
            )}
            {usesObjectName(step.kind) && (
              <Field label="Object name">
                <Listbox
                  value={step.objectName ?? defaultObjectName(step.kind)}
                  options={OBJECT_NAME_OPTIONS}
                  onChange={(objectName) => patchStep(index, { objectName })}
                  className="w-full"
                  ariaLabel={`Execution step ${index + 1} object name`}
                />
              </Field>
            )}
            {usesPipelineName(step.kind) && (
              <Field label="Pipeline name">
                <input value={step.pipelineName ?? derivePipelineName(rootTable)} readOnly className="input bg-panel/50 text-text-muted" />
              </Field>
            )}
          </div>
          <div className="mt-3">
            <Field label="description">
              <textarea value={step.description} onChange={(e) => patchStep(index, { description: e.target.value })} rows={3} className="input" />
            </Field>
          </div>
        </div>
      ))}
      <button type="button" onClick={addStep} className="rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text">Add step</button>
    </div>
  )
}

function usesSubjectRef(kind: AuthoredSyncFlowStep["kind"]): boolean {
  return kind === "datasetDeploy" || kind === "pipelineRegister"
}

function defaultSubjectRef(kind: AuthoredSyncFlowStep["kind"]): NonNullable<AuthoredSyncFlowStep["subjectRef"]> {
  if (kind === "pipelineRegister") return "contractPipelineId"
  return "entityId"
}

function usesAuditObjectType(kind: AuthoredSyncFlowStep["kind"]): boolean {
  return kind === "auditCheck" || kind === "syncDate" || kind === "deployDate"
}

function defaultAuditObjectType(kind: AuthoredSyncFlowStep["kind"]): string {
  if (kind === "auditCheck") return "Contract"
  return "Dataset"
}

function usesObjectName(kind: AuthoredSyncFlowStep["kind"]): boolean {
  return kind === "handleDependencies"
}

function defaultObjectName(kind: AuthoredSyncFlowStep["kind"]): string {
  return kind === "handleDependencies" ? "content" : ""
}

function usesPipelineName(kind: AuthoredSyncFlowStep["kind"]): boolean {
  return kind === "pipelineStart"
}

function derivePipelineName(rootTable: string): string {
  const tableName = rootTable.trim().split(".").filter(Boolean).at(-1) ?? "Entity"
  return `Synchronize ${tableName}`
}

function normalizeStep(step: AuthoredSyncFlowStep, rootTable: string): AuthoredSyncFlowStep {
  return {
    ...step,
    ...(usesSubjectRef(step.kind) ? { subjectRef: step.subjectRef ?? defaultSubjectRef(step.kind) } : { subjectRef: undefined }),
    ...(usesObjectName(step.kind) ? { objectName: step.objectName ?? defaultObjectName(step.kind) } : { objectName: undefined }),
    ...(usesAuditObjectType(step.kind) ? { auditObjectType: step.auditObjectType ?? defaultAuditObjectType(step.kind) } : { auditObjectType: undefined }),
    ...(usesPipelineName(step.kind) ? { pipelineName: step.pipelineName ?? derivePipelineName(rootTable) } : { pipelineName: undefined }),
  }
}

// ── Summary helpers ───────────────────────────────────────────────

function summary(pairs: ([string, string] | null)[]): string {
  const live = pairs.filter((p): p is [string, string] => p !== null && p[1] !== "")
  return live.length === 0 ? "defaults" : live.map(([k, v]) => `${k}: ${v}`).join(" · ")
}

function tablesSummary(json: string): string {
  try {
    const arr = JSON.parse(json) as unknown
    return Array.isArray(arr) ? `${arr.length} table${arr.length === 1 ? "" : "s"}` : "invalid JSON"
  } catch { return "invalid JSON" }
}

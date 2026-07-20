/**
 * Sync metadata — kind and custom value source definition editors.
 */

import type { JSX, ReactNode } from "react"
import { LabeledCheckbox } from "../../components/Checkbox"
import { Listbox } from "../../components/Listbox"
import type {
  AuthoredSyncFlowStep,
  CatalogResolver,
  CustomValueSourceDefinition,
  SyncFlowKindDefinition,
  SyncFlowPhaseDefinition,
} from "../../types"
import {
  CATALOG_RESOLVER_KIND_OPTIONS,
  catalogResolverFamilyLabel,
  defaultCatalogResolver,
  formatCatalogResolverRuntimePreview,
  inferTargetSqlResultType,
  SYNC_STEP_FIELD_KEYS,
  validateTargetSqlQuery,
} from "../../types"
import { FIELD_LABEL, HELP_TEXT, SUBSECTION_HEADING } from "./chrome"
import {
  showsSkipWhenDatasetLayerFailed,
  withNormalizedKindDefinition,
  type CustomValueSourceUiCatalog,
} from "./handler-editor"
import { HandlerConfigPanel } from "./HandlerConfigPanel"

function FieldLabel({ label }: { label: string }): JSX.Element {
  return <span className={FIELD_LABEL}>{label}</span>
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel label={label} />
      {children}
    </label>
  )
}

const PHASE_BOUNDARY_OPTIONS = [
  { value: "pre_metadata" as const, label: "Pre-metadata (before metadataSync)" },
  { value: "metadata_transaction" as const, label: "Metadata transaction" },
  { value: "post_metadata" as const, label: "Post-metadata (after metadataSync)" },
  { value: "post_commit" as const, label: "Post-commit (reserved)" },
]

const CONNECTION_OPTIONS = [
  { value: "source" as const, label: "Source" },
  { value: "target" as const, label: "Target" },
  { value: "mixed" as const, label: "Mixed" },
]

const FAILURE_OPTIONS = [
  { value: "fatal" as const, label: "Fatal — stops run" },
  { value: "warning" as const, label: "Warning — logs and continues" },
]

export function PhaseDefinitionEditor({
  value,
  onChange,
  readOnlyHandler,
}: {
  value: SyncFlowPhaseDefinition
  onChange: (value: SyncFlowPhaseDefinition) => void
  readOnlyHandler?: boolean
}): JSX.Element {
  return (
    <div className="space-y-3 border-t border-border-subtle pt-4">
      <p className={SUBSECTION_HEADING}>Phase behavior</p>
      <Field label="Summary">
        <input value={value.summary} onChange={(e) => onChange({ ...value, summary: e.target.value })} className="input text-sm" />
      </Field>
      <Field label="Description">
        <textarea value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} rows={4} className="input text-sm" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Execution boundary">
          <Listbox value={value.boundary} options={PHASE_BOUNDARY_OPTIONS} onChange={(boundary) => onChange({ ...value, boundary })} className="w-full" ariaLabel="Phase boundary" disabled={readOnlyHandler} />
        </Field>
        <Field label="Connection">
          <Listbox value={value.connection} options={CONNECTION_OPTIONS} onChange={(connection) => onChange({ ...value, connection })} className="w-full" ariaLabel="Phase connection" disabled={readOnlyHandler} />
        </Field>
        <Field label="Default failure mode">
          <Listbox value={value.defaultFailureMode} options={FAILURE_OPTIONS} onChange={(defaultFailureMode) => onChange({ ...value, defaultFailureMode })} className="w-full" ariaLabel="Default failure mode" />
        </Field>
      </div>
      <Field label="Ordering hint">
        <input value={value.orderingHint} onChange={(e) => onChange({ ...value, orderingHint: e.target.value })} className="input text-sm" disabled={readOnlyHandler} />
      </Field>
    </div>
  )
}

export function StepTypeDefinitionEditor({
  value,
  onChange,
  readOnlyHandler,
  hideSummary = false,
  kindId,
  bindingSourceCatalog = {},
  customValueSourceCatalog,
  flowStepOptions = [],
  resolveKind,
  flowStepsForOutputHints = [],
}: {
  value: SyncFlowKindDefinition
  onChange: (value: SyncFlowKindDefinition) => void
  readOnlyHandler?: boolean
  hideSummary?: boolean
  kindId?: string
  bindingSourceCatalog?: CustomValueSourceUiCatalog
  customValueSourceCatalog?: CustomValueSourceUiCatalog
  flowStepOptions?: readonly import("../../components/SearchablePick").SearchablePickOption[]
  resolveKind?: (kindId: string) => SyncFlowKindDefinition | undefined
  flowStepsForOutputHints?: readonly AuthoredSyncFlowStep[]
}): JSX.Element {
  const resolvedCatalog = customValueSourceCatalog ?? bindingSourceCatalog ?? {}
  const showSkipWhenDatasetFailed =
    !readOnlyHandler && showsSkipWhenDatasetLayerFailed(value, { editable: true })

  return (
    <div className="space-y-3">
      {!hideSummary && (
        <Field label="Summary">
          <input value={value.summary} onChange={(e) => onChange({ ...value, summary: e.target.value })} className="input text-sm" />
        </Field>
      )}
      <Field label="Description">
        <textarea value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} rows={3} className="input text-sm" />
      </Field>

      <div className="rounded-lg border border-border-subtle bg-panel/40 p-3">
        <HandlerConfigPanel
          value={withNormalizedKindDefinition(value, kindId)}
          onChange={readOnlyHandler ? undefined : (next) => onChange(withNormalizedKindDefinition(next, kindId))}
          readOnly={readOnlyHandler}
          kindId={kindId}
          customValueSourceCatalog={resolvedCatalog}
          bindingSourceCatalog={resolvedCatalog}
          flowStepOptions={flowStepOptions}
          resolveKind={resolveKind}
          flowStepsForOutputHints={flowStepsForOutputHints}
        />
      </div>

      {showSkipWhenDatasetFailed && (
        <LabeledCheckbox
          label="Skip when contract dataset create failed"
          checked={!!value.skipWhenDatasetLayerFailed}
          onChange={(next) => onChange({ ...value, skipWhenDatasetLayerFailed: next || undefined })}
          className={HELP_TEXT}
        />
      )}
    </div>
  )
}

export const DEFAULT_PHASE_DEFINITION: SyncFlowPhaseDefinition = {
  summary: "",
  description: "",
  boundary: "post_metadata",
  connection: "mixed",
  defaultFailureMode: "warning",
  orderingHint: "Place in flow array relative to metadataSync.",
}

export const DEFAULT_STEP_TYPE_DEFINITION: SyncFlowKindDefinition = {
  summary: "",
  description: "",
  handler: {
    type: "mssql_procedure",
    connection: "target",
    procedure: "core.uspCustomStep",
    parameters: [{ name: "id", source: { type: "catalog", id: "planEntityId" } }],
  },
  stepFields: {},
  failureMode: "warning",
  entityTypes: ["any"],
}

export function CustomValueSourceDefinitionEditor({
  value,
  onChange,
  readOnlyResolver,
  entryId,
}: {
  value: CustomValueSourceDefinition
  onChange: (value: CustomValueSourceDefinition) => void
  readOnlyResolver?: boolean
  entryId?: string
}): JSX.Element {
  const resolver = value.resolver
  const queryError =
    resolver.kind === "targetSql" ? validateTargetSqlQuery(resolver.query) : null

  function patchResolver(next: CatalogResolver): void {
    onChange({ ...value, resolver: next })
  }

  return (
    <div className="space-y-3">
      <Field label="Description">
        <textarea
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          rows={3}
          className="input text-sm"
        />
      </Field>
      <Field label="Resolution">
        <Listbox
          value={resolver.kind}
          options={CATALOG_RESOLVER_KIND_OPTIONS.map((entry) => ({
            value: entry.kind,
            label: entry.label,
            hint: entry.description,
          }))}
          onChange={(kind) => patchResolver(defaultCatalogResolver(kind))}
          className="w-full"
          ariaLabel="Resolution"
          disabled={readOnlyResolver}
        />
      </Field>
      {resolver.kind === "stepField" && (
        <Field label="Step property">
          <Listbox
            value={resolver.field}
            options={SYNC_STEP_FIELD_KEYS.map((field) => ({
              value: field,
              label: field,
              hint: `step.${field}`,
            }))}
            onChange={(field) => patchResolver({ kind: "stepField", field })}
            className="w-full"
            ariaLabel="Step property"
            disabled={readOnlyResolver}
          />
        </Field>
      )}
      {resolver.kind === "targetSql" && (
        <div className="space-y-3">
          <Field label="SQL query (target)">
            <textarea
              value={resolver.query}
              onChange={(e) => patchResolver({ ...resolver, query: e.target.value })}
              rows={4}
              className="input font-mono text-sm"
              placeholder="SELECT inputDatasetId FROM core.[Rule] WHERE ruleId = @entityId"
              disabled={readOnlyResolver}
            />
            {queryError && <p className="mt-1 text-xs text-error">{queryError}</p>}
          </Field>
          <Field label="Result column">
            <input
              value={resolver.resultColumn}
              onChange={(e) => {
                const resultColumn = e.target.value
                patchResolver({
                  ...resolver,
                  resultColumn,
                  resultType: inferTargetSqlResultType(resultColumn),
                })
              }}
              className="input font-mono text-sm"
              placeholder="name, inputDatasetId, pipelineId, …"
              disabled={readOnlyResolver}
            />
            <p className={`mt-1 ${HELP_TEXT}`}>
              Column type is inferred automatically (*Id → number, otherwise text).
            </p>
          </Field>
        </div>
      )}
      <div className="rounded-lg border border-border-subtle bg-base/60 px-3 py-2.5">
        <p className={`mb-2 ${SUBSECTION_HEADING}`}>Execute preview</p>
        <p className="text-sm leading-relaxed text-text">
          {formatCatalogResolverRuntimePreview(value, entryId ?? "valueSource")}
        </p>
        <p className={`mt-2 ${HELP_TEXT}`}>{catalogResolverFamilyLabel(resolver)}</p>
      </div>
    </div>
  )
}

export const DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION: CustomValueSourceDefinition = {
  description: "",
  resolver: { kind: "targetSql", query: "", resultColumn: "" },
}

/** @deprecated Use CustomValueSourceDefinitionEditor */
export const BindingSourceDefinitionEditor = CustomValueSourceDefinitionEditor

/** @deprecated Use DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION */
export const DEFAULT_BINDING_SOURCE_DEFINITION = DEFAULT_CUSTOM_VALUE_SOURCE_DEFINITION

export const KindDefinitionEditor = StepTypeDefinitionEditor
export const DEFAULT_KIND_DEFINITION = DEFAULT_STEP_TYPE_DEFINITION

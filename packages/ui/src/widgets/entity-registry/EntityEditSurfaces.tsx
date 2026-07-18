/**
 * Authoring surfaces shared by EntityEditModal and SyncMetadataModal.
 */

import { Loader2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { type ListboxOption } from "../../components/Listbox"
import type { AuthoredSyncFlowStep, SyncMetadataCatalogAction } from "../../types"
import { ExecutionStepFields } from "./ExecutionStepFields"
import { ExecutionStepListEditor } from "./ExecutionStepListEditor"
import type { CustomValueSourceUiCatalog } from "./handler-editor"
import {
  buildStepTypeCatalogLookup,
  FLOW_STEP_TYPE_OPTIONS,
  newStep,
} from "./execution-step-shared"

export interface SourceSurfaceProps {
  loading: boolean
  body: string
  onBody: (v: string) => void
  reason?: string
  onReason?: (v: string) => void
  placeholder?: string
}

export function SourceSurface({ loading, body, onBody, reason, onReason, placeholder }: SourceSurfaceProps): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 text-xs">
      {loading && (
        <div className="flex shrink-0 items-center gap-2 text-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> loading…
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        spellCheck={false}
        placeholder={placeholder}
        className="h-0 min-h-0 w-full min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-3 font-mono text-sm leading-relaxed text-text outline-none focus:ring-0"
      />
      {onReason && (
        <Field label="Reason">
          <input value={reason ?? ""} onChange={(e) => onReason(e.target.value)} placeholder="required" className="input" />
        </Field>
      )}
    </div>
  )
}

function FieldLabel({ label }: { label: string }): JSX.Element {
  return (
    <span className="mb-1 block text-xs uppercase tracking-wider text-text-muted">
      {label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel label={label} />
      {children}
    </label>
  )
}

export function FormSurfaceExecutionSteps({
  executionSteps,
  onExecutionSteps,
  rootTable,
  entityId = "",
  stepTypeOptions,
  actions,
  stepTypes,
  customValueSourceCatalog,
  bindingSourceCatalog,
  kindOptions,
  variant = "list",
  showAddButton = true,
}: {
  executionSteps: AuthoredSyncFlowStep[]
  onExecutionSteps: (value: AuthoredSyncFlowStep[]) => void
  rootTable: string
  entityId?: string
  stepTypeOptions?: ListboxOption<AuthoredSyncFlowStep["kind"]>[]
  actions?: readonly SyncMetadataCatalogAction[] | null
  /** @deprecated Use `actions` */
  stepTypes?: readonly SyncMetadataCatalogAction[] | null
  customValueSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use customValueSourceCatalog */
  bindingSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use stepTypeOptions */
  kindOptions?: ListboxOption<AuthoredSyncFlowStep["kind"]>[]
  variant?: "list" | "expanded"
  showAddButton?: boolean
}): JSX.Element {
  const resolvedStepTypeOptions = stepTypeOptions ?? kindOptions
  const stepTypeCatalog = buildStepTypeCatalogLookup(actions ?? stepTypes)
  const resolvedCatalog = customValueSourceCatalog ?? bindingSourceCatalog ?? {}
  if (variant === "list") {
    return (
      <ExecutionStepListEditor
        executionSteps={executionSteps}
        onExecutionSteps={onExecutionSteps}
        rootTable={rootTable}
        entityId={entityId}
        stepTypeOptions={resolvedStepTypeOptions}
        stepTypeCatalog={stepTypeCatalog}
        customValueSourceCatalog={resolvedCatalog}
        showAddButton={showAddButton}
      />
    )
  }

  const resolvedStepTypeOptionsFinal = resolvedStepTypeOptions ?? FLOW_STEP_TYPE_OPTIONS

  function patchStep(index: number, step: AuthoredSyncFlowStep): void {
    onExecutionSteps(executionSteps.map((current, i) => (i === index ? step : current)))
  }

  function removeStep(index: number): void {
    onExecutionSteps(executionSteps.filter((_, i) => i !== index))
  }

  function addStep(): void {
    onExecutionSteps([...executionSteps, newStep(executionSteps.length + 1, rootTable, entityId, "auditCheck", stepTypeCatalog, executionSteps)])
  }

  return (
    <div className="space-y-3">
      {executionSteps.length === 0 && (
        <div className="text-sm text-text-muted">No execution steps defined yet.</div>
      )}
      {executionSteps.map((step, index) => (
        <div key={index} className="rounded-lg border border-border-subtle bg-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-text">Step {index + 1}</div>
            <button type="button" onClick={() => removeStep(index)} className="rounded-lg border border-border-subtle px-2 py-1 text-xs font-medium text-text-muted hover:bg-elevated hover:text-text">Remove</button>
          </div>
          <ExecutionStepFields
            step={step}
            stepIndex={index}
            allSteps={executionSteps}
            rootTable={rootTable}
            entityId={entityId}
            stepTypeOptions={resolvedStepTypeOptionsFinal}
            stepTypeCatalog={stepTypeCatalog}
            customValueSourceCatalog={resolvedCatalog}
            onChange={(next) => patchStep(index, next)}
          />
        </div>
      ))}
      <button type="button" onClick={addStep} className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs font-medium text-text-muted hover:bg-elevated hover:text-text">Add Step</button>
    </div>
  )
}

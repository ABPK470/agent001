import { ChevronDown, Plus, Trash2 } from "lucide-react"
import { forwardRef, useCallback, useImperativeHandle, useState, type JSX } from "react"
import type { ListboxOption } from "../../components/Listbox"
import type { AuthoredSyncFlowStep } from "../../types"
import { HELP_TEXT, META_TEXT, PANEL, TEXT_BTN } from "./chrome"
import { ExecutionStepFields } from "./ExecutionStepFields"
import type { CustomValueSourceUiCatalog } from "./handler-editor"
import { HandlerTypeTag } from "./param-binding-ui"
import {
  flowStepHeaderLines,
  newStep,
  normalizeStep,
  stepSettingsSummary,
  type StepTypeCatalogLookup,
} from "./execution-step-shared"

export interface ExecutionStepListEditorHandle {
  addStep: () => void
}

export interface ExecutionStepListEditorProps {
  executionSteps: AuthoredSyncFlowStep[]
  onExecutionSteps: (value: AuthoredSyncFlowStep[]) => void
  rootTable: string
  entityId?: string
  stepTypeOptions?: ListboxOption<AuthoredSyncFlowStep["kind"]>[]
  stepTypeCatalog?: StepTypeCatalogLookup | null
  customValueSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use customValueSourceCatalog */
  bindingSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use stepTypeOptions */
  kindOptions?: ListboxOption<AuthoredSyncFlowStep["kind"]>[]
  showAddButton?: boolean
}

export const ExecutionStepListEditor = forwardRef<
  ExecutionStepListEditorHandle,
  ExecutionStepListEditorProps
>(function ExecutionStepListEditor({
  executionSteps,
  onExecutionSteps,
  rootTable,
  entityId = "",
  stepTypeOptions,
  stepTypeCatalog = null,
  customValueSourceCatalog,
  bindingSourceCatalog,
  kindOptions,
  showAddButton = true,
}, ref): JSX.Element {
  const resolvedCatalog = customValueSourceCatalog ?? bindingSourceCatalog ?? {}
  const resolvedStepTypeOptions = stepTypeOptions ?? kindOptions
  const [expandedIndices, setExpandedIndices] = useState<ReadonlySet<number>>(() => new Set())

  function patchStep(index: number, step: AuthoredSyncFlowStep): void {
    onExecutionSteps(executionSteps.map((current, i) => (i === index ? step : current)))
  }

  function removeStep(index: number): void {
    onExecutionSteps(executionSteps.filter((_, i) => i !== index))
    setExpandedIndices((current) => {
      const next = new Set<number>()
      for (const i of current) {
        if (i === index) continue
        next.add(i > index ? i - 1 : i)
      }
      return next
    })
  }

  const addStep = useCallback((): void => {
    const next = newStep(
      executionSteps.length + 1,
      rootTable,
      entityId,
      "auditCheck",
      stepTypeCatalog,
      executionSteps,
    )
    onExecutionSteps([...executionSteps, next])
    setExpandedIndices((current) => new Set([...current, executionSteps.length]))
  }, [executionSteps, entityId, onExecutionSteps, rootTable, stepTypeCatalog])

  useImperativeHandle(ref, () => ({ addStep }), [addStep])

  function toggleExpanded(index: number): void {
    setExpandedIndices((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="space-y-3">
      {executionSteps.length === 0 ? (
        <div className={`px-1 py-4 text-center ${HELP_TEXT}`}>
          <p className="text-sm text-text">No steps yet.</p>
          <p className="mt-1 text-xs text-text-muted">Add steps in order — include exactly one metadata sync step.</p>
        </div>
      ) : (
        <ol className={PANEL}>
          {executionSteps.map((step, index) => {
            const expanded = expandedIndices.has(index)
            const { primary, secondary, handlerType } = flowStepHeaderLines(
              step,
              stepTypeCatalog,
              resolvedStepTypeOptions,
            )
            const settings = stepSettingsSummary(step, stepTypeCatalog, resolvedCatalog)
            return (
              <li
                key={index}
                className={[
                  "border-b border-border-subtle last:border-b-0",
                  expanded ? "bg-canvas/30" : "",
                ].join(" ")}
              >
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(index)}
                    className={[
                      "flex min-w-0 flex-1 items-start gap-3 px-3 py-3 text-left transition-colors",
                      expanded ? "border-b border-border-subtle bg-elevated/70" : "hover:bg-elevated/40",
                    ].join(" ")}
                    aria-expanded={expanded}
                  >
                    <span
                      className={[
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums",
                        expanded
                          ? "bg-accent/15 text-accent"
                          : "bg-elevated text-text-muted",
                      ].join(" ")}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-text">{primary}</span>
                      <span className={`mt-0.5 block truncate font-mono ${META_TEXT}`}>{secondary}</span>
                      {!expanded && settings ? (
                        <span className="mt-1 block truncate text-xs text-text-muted">{settings}</span>
                      ) : null}
                    </span>
                    {handlerType ? <HandlerTypeTag type={handlerType} /> : null}
                    <ChevronDown
                      className={`mt-0.5 h-4 w-4 shrink-0 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(index)}
                    className={[
                      "flex shrink-0 items-center border-l border-border-subtle px-2.5 text-text-muted transition-colors hover:bg-elevated hover:text-rose-400",
                      expanded ? "border-b border-border-subtle bg-elevated/70" : "",
                    ].join(" ")}
                    title="Remove step"
                    aria-label={`Remove step ${index + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {expanded && (
                  <div className="bg-base/25 px-3 py-3">
                    <ExecutionStepFields
                      step={step}
                      stepIndex={index}
                      allSteps={executionSteps}
                      rootTable={rootTable}
                      entityId={entityId}
                      stepTypeOptions={resolvedStepTypeOptions}
                      stepTypeCatalog={stepTypeCatalog}
                      customValueSourceCatalog={resolvedCatalog}
                      onChange={(next) =>
                        patchStep(index, normalizeStep(next, rootTable, entityId, stepTypeCatalog))
                      }
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {showAddButton && (
        <button type="button" onClick={addStep} className={`${TEXT_BTN} w-full justify-center`}>
          <Plus className="h-3.5 w-3.5" />
          Add step
        </button>
      )}
    </div>
  )
})

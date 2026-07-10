import type { JSX } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import type { AuthoredSyncFlowStep, SyncStepFieldKey } from "../../types"
import { formatValueSourcePreview } from "../../types"
import {
  defaultStepBindings,
  defaultStepFieldValue,
  deriveStepIdentityFromAction,
  FLOW_STEP_TYPE_OPTIONS,
  kindDisplayLabel,
  normalizeStep,
  planBindingSourceListboxOptions,
  requiredBindingSlotNames,
  requiredStepFieldKeys,
  type StepTypeCatalogLookup,
} from "./execution-step-shared"
import { FormFieldGroup, FormSectionCard } from "./form-section"
import type { CustomValueSourceUiCatalog } from "./handler-editor"
import {
  parseValueSourceListboxValue,
  PRIOR_STEP_OUTPUT_LISTBOX_VALUE,
  valueSourceListboxValue,
} from "./handler-editor"

function ParamGroupHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">{children}</p>
  )
}

export interface ExecutionStepFieldsProps {
  step: AuthoredSyncFlowStep
  rootTable: string
  entityId?: string
  stepIndex?: number
  allSteps?: readonly AuthoredSyncFlowStep[]
  stepTypeOptions?: ListboxOption<AuthoredSyncFlowStep["kind"]>[]
  stepTypeCatalog?: StepTypeCatalogLookup | null
  customValueSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use customValueSourceCatalog */
  bindingSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use stepTypeOptions */
  kindOptions?: ListboxOption<AuthoredSyncFlowStep["kind"]>[]
  onChange: (step: AuthoredSyncFlowStep) => void
}

function DynamicStepField({
  field,
  step,
  rootTable,
  entityId,
  onPatch,
}: {
  field: SyncStepFieldKey
  step: AuthoredSyncFlowStep
  rootTable: string
  entityId: string
  onPatch: (field: SyncStepFieldKey, value: string) => void
}): JSX.Element {
  const current = step[field]
  const value = typeof current === "string" ? current : ""
  const label = formatValueSourcePreview({ type: "catalog", id: field })
  const suggested = defaultStepFieldValue(field, step.kind, entityId, rootTable)
  const placeholder = suggested && suggested !== value ? suggested : undefined

  return (
    <FormFieldGroup
      label={label}
      hint={placeholder ? `Suggested: ${placeholder}` : undefined}
    >
      <input
        value={value}
        onChange={(e) => onPatch(field, e.target.value)}
        placeholder={placeholder}
        className="input"
      />
    </FormFieldGroup>
  )
}

export function ExecutionStepFields({
  step,
  rootTable,
  entityId = "",
  stepIndex,
  allSteps = [],
  stepTypeOptions,
  stepTypeCatalog = null,
  customValueSourceCatalog,
  bindingSourceCatalog,
  kindOptions,
  onChange,
}: ExecutionStepFieldsProps): JSX.Element {
  const resolvedCatalog = customValueSourceCatalog ?? bindingSourceCatalog ?? {}
  const resolvedStepTypeOptions = stepTypeOptions ?? kindOptions ?? FLOW_STEP_TYPE_OPTIONS
  const bindingOptions = planBindingSourceListboxOptions(resolvedCatalog)
  const bindingSlotNames = requiredBindingSlotNames(step.kind, stepTypeCatalog)
  const fieldKeys = requiredStepFieldKeys(step.kind, stepTypeCatalog, step)
  const hasBindings = bindingSlotNames.length > 0
  const hasFieldValues = fieldKeys.length > 0
  const actionLabel = kindDisplayLabel(step.kind, stepTypeCatalog, resolvedStepTypeOptions)

  function patch(patch: Partial<AuthoredSyncFlowStep>): void {
    onChange(normalizeStep({ ...step, ...patch }, rootTable, entityId, stepTypeCatalog))
  }

  function patchStepField(field: SyncStepFieldKey, value: string): void {
    patch({ [field]: value } as Partial<AuthoredSyncFlowStep>)
  }

  function patchBinding(slotName: string, listboxValue: string): void {
    const source = parseValueSourceListboxValue(listboxValue)
    if (!source) return
    patch({
      bindings: {
        ...(step.bindings ?? {}),
        [slotName]: source,
      },
    })
  }

  function onKindChange(kind: AuthoredSyncFlowStep["kind"]): void {
    const nextKindDef = stepTypeCatalog?.get(kind)
    patch({
      ...deriveStepIdentityFromAction(
        kind,
        stepTypeCatalog,
        resolvedStepTypeOptions,
        allSteps,
        stepIndex,
      ),
      bindings: nextKindDef ? defaultStepBindings({ kind }, entityId, nextKindDef) : {},
    })
  }

  return (
    <div className="space-y-3">
      <FormSectionCard
        title="Action"
        description="Catalog action executed when this step runs."
        emphasized
      >
        <FormFieldGroup label="Action type">
          <Listbox
            value={step.kind}
            options={resolvedStepTypeOptions}
            onChange={onKindChange}
            className="w-full"
            ariaLabel="Action type"
          />
        </FormFieldGroup>
      </FormSectionCard>

      {(hasFieldValues || hasBindings) && (
        <FormSectionCard title="Parameters" description="Runtime inputs and resolver picks for this step.">
          {hasFieldValues ? (
            <div className="space-y-3">
              {hasBindings ? <ParamGroupHeading>Step inputs</ParamGroupHeading> : null}
              <div className="grid grid-cols-1 gap-3">
                {fieldKeys.map((field) => (
                  <DynamicStepField
                    key={field}
                    field={field}
                    step={step}
                    rootTable={rootTable}
                    entityId={entityId}
                    onPatch={patchStepField}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {hasBindings ? (
            <div className={`space-y-3${hasFieldValues ? " border-t border-border-subtle/70 pt-3" : ""}`}>
              {hasFieldValues ? <ParamGroupHeading>Resolver wiring</ParamGroupHeading> : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {bindingSlotNames.map((slotName) => (
                  <FormFieldGroup key={slotName} label={`@${slotName}`}>
                    <Listbox
                      value={valueSourceListboxValue(step.bindings?.[slotName])}
                      options={bindingOptions.filter((option) => option.value !== PRIOR_STEP_OUTPUT_LISTBOX_VALUE)}
                      onChange={(listboxValue) => patchBinding(slotName, listboxValue)}
                      className="w-full"
                      ariaLabel={`Resolver for ${slotName}`}
                    />
                  </FormFieldGroup>
                ))}
              </div>
            </div>
          ) : null}
        </FormSectionCard>
      )}

      <FormSectionCard
        title="Step identity"
        description="How this step appears in the flow list — does not change handler wiring."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Step key" hint="Prefilled when you change action type — rename anytime.">
            <input
              value={step.id}
              onChange={(e) => patch({ id: e.target.value })}
              className="input font-mono text-sm"
            />
          </FormFieldGroup>
          <FormFieldGroup
            label="Display title"
            hint="Prefilled when you change action type — rename anytime. Empty uses the action name."
          >
            <input
              value={step.title}
              onChange={(e) => patch({ title: e.target.value })}
              className="input text-sm"
              placeholder={actionLabel}
            />
          </FormFieldGroup>
        </div>
        <FormFieldGroup label="Notes">
          <textarea
            value={step.description}
            onChange={(e) => patch({ description: e.target.value })}
            rows={2}
            className="input text-sm"
            placeholder="Optional explanation for operators"
          />
        </FormFieldGroup>
      </FormSectionCard>
    </div>
  )
}

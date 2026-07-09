import type { ListboxOption } from "../../components/Listbox"
import type {
  AuthoredSyncFlowStep,
  SyncFlowKindDefinition,
  SyncMetadataCatalogStepType,
  SyncStepFieldKey,
  ValueSource,
  AuthoredSyncFlowKind,
} from "../../types"
import {
  defaultAuditObjectType,
  defaultObjectName,
  defaultStepBindings,
  defaultStepFieldValue,
  derivePipelineName,
  formatValueSourcePreview,
  handlerInputSlots,
  isStepBoundHandlerSlot,
  normalizeAuthoredSyncFlowStep,
  stepFieldKeysForStep,
  stepFieldKeysFromHandler,
} from "../../types"
import { handlerInputSourceListboxOptions } from "./handler-editor"

/** Fallback kind picker when sync metadata catalog is not loaded. */
export const FLOW_STEP_TYPE_OPTIONS: ListboxOption<AuthoredSyncFlowStep["kind"]>[] = [
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
].map((value) => ({ value, label: value })) as ListboxOption<AuthoredSyncFlowKind>[]

export type StepTypeCatalogLookup = Map<string, SyncFlowKindDefinition>

export function buildStepTypeCatalogLookup(
  stepTypes?: readonly SyncMetadataCatalogStepType[] | null,
): StepTypeCatalogLookup | null {
  if (!stepTypes?.length) return null
  return new Map(stepTypes.map((entry) => [entry.id, entry.definition]))
}

export function requiredBindingSlotNames(
  kind: AuthoredSyncFlowStep["kind"],
  catalog: StepTypeCatalogLookup | null,
): string[] {
  const def = catalog?.get(kind)
  if (!def) return []
  return handlerInputSlots(def.handler)
    .filter(isStepBoundHandlerSlot)
    .map((slot) => slot.name.trim())
    .filter(Boolean)
    .sort()
}

export function requiredStepFieldKeys(
  kind: AuthoredSyncFlowStep["kind"],
  catalog: StepTypeCatalogLookup | null,
  step?: Pick<AuthoredSyncFlowStep, "bindings">,
): SyncStepFieldKey[] {
  const def = catalog?.get(kind)
  if (def) return stepFieldKeysForStep(step ?? {}, def)
  return []
}

/** @deprecated Use requiredStepFieldKeys */
export const requiredStepFieldIds = requiredStepFieldKeys

export { defaultAuditObjectType, defaultObjectName, defaultStepBindings, defaultStepFieldValue, derivePipelineName }

export function normalizeStep(
  step: AuthoredSyncFlowStep,
  rootTable: string,
  entityId: string,
  stepTypeCatalog?: StepTypeCatalogLookup | null,
): AuthoredSyncFlowStep {
  const kindDef = stepTypeCatalog?.get(step.kind)
  const bindings = {
    ...(kindDef ? defaultStepBindings(step, entityId, kindDef) : {}),
    ...(step.bindings ?? {}),
  }
  return normalizeAuthoredSyncFlowStep(
    { ...step, bindings },
    {
      entityId,
      rootTable,
    },
    stepTypeCatalog
      ? {
          resolveKind(kindId: string) {
            return stepTypeCatalog.get(kindId)
          },
        }
      : undefined,
  )
}

export function planBindingSourceListboxOptions(
  customValueSourceCatalog: import("./handler-editor").CustomValueSourceUiCatalog,
): ReturnType<typeof handlerInputSourceListboxOptions> {
  return handlerInputSourceListboxOptions(customValueSourceCatalog)
}

export function bindingSourceListboxOptions(
  customValueSourceCatalog: import("./handler-editor").CustomValueSourceUiCatalog,
): ReturnType<typeof handlerInputSourceListboxOptions> {
  return handlerInputSourceListboxOptions(customValueSourceCatalog)
}

export function bindingLabel(
  source: ValueSource | undefined,
  customValueSourceCatalog: import("./handler-editor").CustomValueSourceUiCatalog,
): string {
  if (!source) return ""
  return formatValueSourcePreview(source, {
    customCatalog: Object.fromEntries(
      Object.entries(customValueSourceCatalog).map(([id, entry]) => [id, entry.definition]),
    ),
    customLabels: Object.fromEntries(
      Object.entries(customValueSourceCatalog).map(([id, entry]) => [id, entry.label]),
    ),
  })
}

export function flowStepHeaderLines(
  step: AuthoredSyncFlowStep,
  stepTypeCatalog: StepTypeCatalogLookup | null,
  stepTypeOptions?: readonly ListboxOption<AuthoredSyncFlowStep["kind"]>[],
): { actionLabel: string; primary: string; secondary: string; handlerType?: string } {
  const actionLabel = kindDisplayLabel(step.kind, stepTypeCatalog, stepTypeOptions)
  const displayTitle = step.title.trim()
  const primary = displayTitle || actionLabel
  const secondary = displayTitle ? `${actionLabel} · ${step.id}` : step.id
  const handlerType = stepTypeCatalog?.get(step.kind)?.handler.type
  return { actionLabel, primary, secondary, handlerType }
}

export function kindDisplayLabel(
  kind: string,
  stepTypeCatalog: StepTypeCatalogLookup | null,
  stepTypeOptions?: readonly ListboxOption<AuthoredSyncFlowStep["kind"]>[],
): string {
  const catalog = stepTypeCatalog?.get(kind)
  if (catalog?.summary?.trim()) return catalog.summary.trim()
  const option = stepTypeOptions?.find((entry) => entry.value === kind)
  if (option?.label?.trim()) return option.label.trim()
  return kind
}

export function deriveStepKeyForKind(
  kind: string,
  steps: readonly Pick<AuthoredSyncFlowStep, "id">[],
  excludeIndex?: number,
): string {
  const usedIds = new Set(
    steps
      .map((entry, index) => (index === excludeIndex ? null : entry.id.trim()))
      .filter((id): id is string => Boolean(id)),
  )
  if (!usedIds.has(kind)) return kind
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${kind}-${suffix}`
    if (!usedIds.has(candidate)) return candidate
  }
  return `${kind}-${Date.now()}`
}

export function deriveStepIdentityFromAction(
  kind: AuthoredSyncFlowStep["kind"],
  stepTypeCatalog: StepTypeCatalogLookup | null,
  stepTypeOptions?: readonly ListboxOption<AuthoredSyncFlowStep["kind"]>[],
  steps: readonly Pick<AuthoredSyncFlowStep, "id">[] = [],
  excludeIndex?: number,
): Pick<AuthoredSyncFlowStep, "id" | "kind" | "title"> {
  return {
    kind,
    id: deriveStepKeyForKind(kind, steps, excludeIndex),
    title: kindDisplayLabel(kind, stepTypeCatalog, stepTypeOptions),
  }
}

export function stepSettingsSummary(
  step: AuthoredSyncFlowStep,
  stepTypeCatalog: StepTypeCatalogLookup | null,
  customValueSourceCatalog: import("./handler-editor").CustomValueSourceUiCatalog = {},
): string {
  const parts: string[] = []
  const kindDef = stepTypeCatalog?.get(step.kind)
  const previewOptions = {
    customCatalog: Object.fromEntries(
      Object.entries(customValueSourceCatalog).map(([id, entry]) => [id, entry.definition]),
    ),
    customLabels: Object.fromEntries(
      Object.entries(customValueSourceCatalog).map(([id, entry]) => [id, entry.label]),
    ),
  }

  for (const field of kindDef ? stepFieldKeysFromHandler(kindDef.handler) : []) {
    const raw = step[field]
    if (typeof raw === "string" && raw.trim()) {
      parts.push(`${formatValueSourcePreview({ type: "stepField", field })}: ${raw.trim()}`)
    }
  }

  for (const slotName of requiredBindingSlotNames(step.kind, stepTypeCatalog)) {
    const source = step.bindings?.[slotName]
    if (source) {
      parts.push(`@${slotName}: ${formatValueSourcePreview(source, previewOptions)}`)
    }
  }
  return parts.join(" · ")
}

export function newStep(
  _index: number,
  rootTable: string,
  entityId: string,
  kind: AuthoredSyncFlowStep["kind"] = "auditCheck",
  stepTypeCatalog?: StepTypeCatalogLookup | null,
  existingSteps: readonly AuthoredSyncFlowStep[] = [],
): AuthoredSyncFlowStep {
  const kindDef = stepTypeCatalog?.get(kind)
  const identity = deriveStepIdentityFromAction(kind, stepTypeCatalog ?? null, undefined, existingSteps)
  return normalizeStep(
    {
      ...identity,
      description: "",
      bindings: kindDef ? defaultStepBindings({ kind }, entityId, kindDef) : {},
    },
    rootTable,
    entityId,
    stepTypeCatalog,
  )
}

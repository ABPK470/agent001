/**
 * Allowed entity types for a sync Action — same list Publish validates.
 */

import type { JSX } from "react"
import { FilterToggles } from "../../components/FilterSheet"
import {
  normalizeSyncFlowKindEntityTypes,
  SYNC_FLOW_KIND_ENTITY_TYPES,
  type SyncFlowKindEntityType,
} from "../../types"
import { HELP_TEXT } from "./chrome"

const ENTITY_TYPE_LABELS: Record<SyncFlowKindEntityType, string> = {
  any: "Any",
  contract: "Contract",
  dataset: "Dataset",
  rule: "Rule",
  content: "Content",
  pipelineActivity: "Pipeline activity",
  gateMetadata: "Gate metadata",
}

export const ACTION_ENTITY_TYPE_OPTIONS = SYNC_FLOW_KIND_ENTITY_TYPES.map((value) => ({
  value,
  label: ENTITY_TYPE_LABELS[value],
}))

export function ActionEntityTypesField({
  value,
  onChange,
}: {
  value: readonly SyncFlowKindEntityType[] | undefined
  onChange: (entityTypes: SyncFlowKindEntityType[]) => void
}): JSX.Element {
  const selected = normalizeSyncFlowKindEntityTypes(value ?? ["any"])

  return (
    <div className="space-y-2">
      <FilterToggles
        options={ACTION_ENTITY_TYPE_OPTIONS}
        values={selected}
        onChange={(next) => onChange(normalizeSyncFlowKindEntityTypes(next))}
      />
      <p className={HELP_TEXT}>
        Publish refuses a flow when this action is used on an entity type that is not selected.
        Choose <span className="text-text-muted">Any</span> for every entity type.
      </p>
    </div>
  )
}

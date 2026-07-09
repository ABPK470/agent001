import type { SyncEntityType, SyncPlan } from "../../types"
import { ENTITY_TYPES } from "./constants"
import type { SearchHit } from "./types"

/** Operator selection — `entity-id` is the committed pick from search; `searchDraft` is in-progress typing only. */
export interface SyncSelection {
  source: string
  target: string
  entityType: SyncEntityType
  /** Trimmed `envSyncForm.entityId` — empty until the user picks a search hit. */
  committedEntityId: string
  force: boolean
  searchMode: "id" | "name"
  enabledOptionalTables: readonly string[]
}

/** Preview API input — committed id wins; draft allows direct ID entry in ID mode only. */
export function previewEntityRef(committedEntityId: string, searchDraft: string): string {
  return committedEntityId || searchDraft.trim()
}

/** True when preview/sync actions are allowed for the current search state. */
export function isPreviewEntityReady(
  selection: SyncSelection,
  searchDraft: string,
  options: { searchLoading: boolean }
): boolean {
  if (options.searchLoading) return false
  if (selection.committedEntityId) return true
  if (selection.searchMode === "name") return false
  const draft = searchDraft.trim()
  return draft.length > 0 && /^\d+$/.test(draft)
}

export function formatSearchHitLabel(hit: Pick<SearchHit, "id" | "name">): string {
  return hit.name ? `${hit.name} (#${hit.id})` : String(hit.id)
}

export function formatPlanEntityLabel(plan: SyncPlan): string {
  const entityRef = `${plan.entity.type ?? plan.executionContract.definitionId}#${plan.entity.id}`
  return plan.entity.displayName ? `${plan.entity.displayName} (${entityRef})` : entityRef
}

export function getPlanEntityType(plan: SyncPlan): SyncEntityType | null {
  const raw = plan.executionContract.definitionId ?? plan.entity.type
  return isSyncEntityType(raw) ? raw : null
}

/** True when a persisted plan belongs to the current operator selection. */
export function planMatchesSelection(plan: SyncPlan, selection: SyncSelection): boolean {
  if (!selection.committedEntityId) return false
  const planEntityType = getPlanEntityType(plan)
  return (
    plan.source === selection.source &&
    plan.target === selection.target &&
    planEntityType === selection.entityType &&
    String(plan.entity.id) === selection.committedEntityId
  )
}

function isSyncEntityType(value: string): value is SyncEntityType {
  return ENTITY_TYPES.includes(value as SyncEntityType)
}

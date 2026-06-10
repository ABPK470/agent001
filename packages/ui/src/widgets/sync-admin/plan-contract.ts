import type { SyncPlan } from "../../types"

export interface SyncPlanStepView {
  id: string
  phase: string
  kind?: string
  title: string
  description: string
}

/** Read execution steps from current or legacy compiled contract shapes. */
export function readExecutionContractSteps(
  contract: NonNullable<SyncPlan["executionContract"]>
): SyncPlanStepView[] {
  const flowSteps = (contract as { flow?: { steps?: SyncPlanStepView[] } }).flow?.steps
  if (Array.isArray(flowSteps)) return flowSteps
  const legacySteps = (contract as { steps?: SyncPlanStepView[] }).steps
  return Array.isArray(legacySteps) ? legacySteps : []
}

export function readExecutionContractVersion(
  contract: NonNullable<SyncPlan["executionContract"]>
): string {
  const published = (contract as { definitionPublishedVersion?: string }).definitionPublishedVersion
  if (typeof published === "string" && published.length > 0) return published
  const legacy = (contract as { definitionVersion?: string }).definitionVersion
  return typeof legacy === "string" && legacy.length > 0 ? legacy : "—"
}

export function readAllowedSchemas(
  contract: NonNullable<SyncPlan["executionContract"]>
): string[] {
  const schemas = (contract as { allowedSchemas?: string[] }).allowedSchemas
  return Array.isArray(schemas) ? schemas : []
}

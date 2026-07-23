/**
 * Resolve execution steps from a flow reference — the only supported path.
 *
 * Entities reference a flow id; steps live on the flow definition in sync metadata.
 */

import type { AuthoredSyncFlowStep } from "@mia/shared-types"

import {
  getSyncDefinitionFlowTemplateSteps,
  hasSyncDefinitionFlowTemplate,
  type SyncDefinitionFlowTemplateCatalog,
} from "./sync-definition-flow-templates.js"

export function resolveFlowSteps(
  flowPresetId: string,
  catalog: SyncDefinitionFlowTemplateCatalog,
): AuthoredSyncFlowStep[] {
  if (!flowPresetId.trim()) {
    throw new Error("flow reference is required")
  }
  if (!hasSyncDefinitionFlowTemplate(catalog, flowPresetId)) {
    throw new Error(
      `Unknown flow "${flowPresetId}". Define it under Sync metadata → Flows, then reference it from the entity.`,
    )
  }
  return getSyncDefinitionFlowTemplateSteps(
    catalog,
    flowPresetId as Parameters<typeof getSyncDefinitionFlowTemplateSteps>[1],
  ).map((step) => ({ ...step }))
}

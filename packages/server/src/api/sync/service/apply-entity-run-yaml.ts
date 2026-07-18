/**
 * Validate entity tip flowId and keep derived sync_definition_configs cache in sync.
 * Tip SoT is EntityDefinition.flowId; the configs table is a publish helper only.
 */

import { hasSyncDefinitionFlowTemplate } from "@mia/sync"

import * as db from "../../../infra/persistence/sqlite.js"
import { loadAuthoringFlowCatalog, upsertSyncDefinitionConfig } from "./definitions.js"

export function validateEntityFlowId(
  projectRoot: string,
  flowId: string,
  tenantId = "_default",
): string | null {
  const trimmed = flowId.trim()
  if (!trimmed) return "flowId is required"
  if (db.getSyncFlow(tenantId, trimmed)) return null
  const catalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  if (!hasSyncDefinitionFlowTemplate(catalog, trimmed)) {
    return `unknown flowId "${trimmed}"`
  }
  return null
}

/** @deprecated Use validateEntityFlowId */
export function validateEntityRunYaml(
  projectRoot: string,
  run: { template: string },
  tenantId = "_default",
): string | null {
  return validateEntityFlowId(projectRoot, run.template, tenantId)
}

export function syncDerivedConfigFromFlowId(
  projectRoot: string,
  tenantId: string,
  entityId: string,
  flowId: string,
  actor: string,
): void {
  upsertSyncDefinitionConfig(projectRoot, {
    tenant_id: tenantId,
    entity_id: entityId,
    flow_preset: flowId,
    execution_steps_json: "[]",
    service_profile_ref: "default",
    environment_policy_ref: "default",
    ownership_team: "sync-platform",
    ownership_owner: null,
    review_status: "legacy-review-required",
    ownership_notes_json: JSON.stringify(["Derived from entity.flowId."]),
    updated_at: new Date().toISOString(),
    updated_by: actor,
  })
}

/** @deprecated Use syncDerivedConfigFromFlowId */
export function applyEntityRunYaml(
  projectRoot: string,
  tenantId: string,
  entityId: string,
  run: { template: string },
  actor: string,
): void {
  syncDerivedConfigFromFlowId(projectRoot, tenantId, entityId, run.template, actor)
}

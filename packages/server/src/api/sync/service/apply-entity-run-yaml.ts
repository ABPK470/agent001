import {
  hasSyncDefinitionFlowTemplate,
} from "@mia/sync"

import * as db from "../../../infra/persistence/sqlite.js"
import type { EntityRunYaml } from "../types/entity-yaml.js"
import { loadAuthoringFlowCatalog, upsertSyncDefinitionConfig } from "./definitions.js"

export function validateEntityRunYaml(
  projectRoot: string,
  run: EntityRunYaml,
  tenantId = "_default",
): string | null {
  if (run.steps && run.steps.length > 0) {
    return "run.steps is not supported — define steps on the flow in Sync metadata → Flows"
  }
  if (db.getSyncRunPreset(tenantId, run.template)) return null
  const catalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  if (!hasSyncDefinitionFlowTemplate(catalog, run.template)) {
    return `unknown run.template "${run.template}"`
  }
  return null
}

export function applyEntityRunYaml(
  projectRoot: string,
  tenantId: string,
  entityId: string,
  run: EntityRunYaml,
  actor: string
): void {
  const existing = db.getSyncDefinitionConfig(tenantId, entityId)
  upsertSyncDefinitionConfig(projectRoot, {
    tenant_id: tenantId,
    entity_id: entityId,
    flow_preset: run.template,
    execution_steps_json: "[]",
    service_profile_ref: run.service,
    environment_policy_ref: run.environment,
    ownership_team: existing?.ownership_team ?? "sync-platform",
    ownership_owner: existing?.ownership_owner ?? null,
    review_status: existing?.review_status ?? "legacy-review-required",
    ownership_notes_json:
      existing?.ownership_notes_json ?? JSON.stringify(["Managed via entity registry YAML."]),
    updated_at: new Date().toISOString(),
    updated_by: actor,
  })
}

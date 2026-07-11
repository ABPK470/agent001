/**
 * Deploy artifact (AuthoredSyncDefinition) export — format A.
 *
 * Compiles EntityDefinition + sync admin config into the same JSON shape as
 * `deploy/sync/artifacts/entities/*.json`.
 */

import type { AuthoredSyncDefinition } from "@mia/shared-types"
import {
  compileAuthoredSyncDefinition,
  type EntityDefinition,
  type SyncDefinitionConfigInput,
  type SyncDefinitionFlowTemplateCatalog,
} from "@mia/sync"

import type { DbSyncDefinitionConfig } from "../../../platform/persistence/sqlite.js"

export function syncConfigInputFromDb(row: DbSyncDefinitionConfig): SyncDefinitionConfigInput {
  return {
    flow_preset: row.flow_preset,
    execution_steps_json: row.execution_steps_json,
    service_profile_ref: row.service_profile_ref,
    environment_policy_ref: row.environment_policy_ref,
    ownership_team: row.ownership_team,
    ownership_owner: row.ownership_owner,
    review_status: row.review_status,
    ownership_notes_json: row.ownership_notes_json,
  }
}

export function entityToAuthoredSyncDefinition(
  entity: EntityDefinition,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
  config: SyncDefinitionConfigInput | null,
  options: { sourceArtifact?: string | null } = {},
): AuthoredSyncDefinition {
  const sourceArtifact =
    options.sourceArtifact ?? `deploy/sync/artifacts/entities/${entity.id}.json`
  return compileAuthoredSyncDefinition(entity, {
    flowTemplateCatalog,
    config: config ?? undefined,
    sourceArtifact,
  })
}

/** Stable JSON for git diff — matches bundled entity artifact formatting. */
export function formatAuthoredSyncJson(authored: AuthoredSyncDefinition): string {
  return `${JSON.stringify(authored, null, 2)}\n`
}

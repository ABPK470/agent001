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
import {
  assertAuthoredExportRoundTrip,
  assertEntityExportable,
} from "../application/assert-entity-export.js"

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
  assertEntityExportable(entity)
  const sourceArtifact =
    options.sourceArtifact ?? `deploy/sync/artifacts/entities/${entity.id}.json`
  const authored = compileAuthoredSyncDefinition(entity, {
    flowTemplateCatalog,
    config: config ?? undefined,
    sourceArtifact,
  })
  assertAuthoredExportRoundTrip(entity, authored)
  return authored
}

/** Stable JSON for git diff — matches bundled entity artifact formatting. */
export function formatAuthoredSyncJson(authored: AuthoredSyncDefinition): string {
  return `${JSON.stringify(authored, null, 2)}\n`
}

export interface ParseAuthoredSyncResult {
  ok: boolean
  authored: AuthoredSyncDefinition | null
  error: string | null
}

export function parseAuthoredSyncJson(text: string): ParseAuthoredSyncResult[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return [{ ok: false, authored: null, error: `json-parse-error: ${(error as Error).message}` }]
  }

  const docs = Array.isArray(raw) ? raw : [raw]
  if (docs.length === 0) {
    return [{ ok: false, authored: null, error: "json document contains no artifacts" }]
  }
  return docs.map((entry) => shapeAuthoredSync(entry))
}

function shapeAuthoredSync(raw: unknown): ParseAuthoredSyncResult {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, authored: null, error: "document is not a JSON object" }
  }
  const doc = raw as Record<string, unknown>
  const required = ["id", "rootTable", "idColumn", "metadata", "executionFlow", "bindings", "strategy"]
  for (const key of required) {
    if (!(key in doc)) return { ok: false, authored: null, error: `missing required field "${key}"` }
  }
  const metadata = doc["metadata"]
  if (metadata === null || typeof metadata !== "object") {
    return { ok: false, authored: null, error: "metadata must be an object" }
  }
  const tables = (metadata as Record<string, unknown>)["tables"]
  if (!Array.isArray(tables) || tables.length === 0) {
    return { ok: false, authored: null, error: "metadata.tables must be a non-empty array" }
  }
  const executionFlow = doc["executionFlow"]
  if (executionFlow === null || typeof executionFlow !== "object") {
    return { ok: false, authored: null, error: "executionFlow must be an object" }
  }
  const steps = (executionFlow as Record<string, unknown>)["steps"]
  if (!Array.isArray(steps)) {
    return { ok: false, authored: null, error: "executionFlow.steps must be an array" }
  }
  return { ok: true, authored: raw as AuthoredSyncDefinition, error: null }
}

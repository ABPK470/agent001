/**
 * Compose a PublishedSyncDefinition from entity-registry + admin config.
 *
 * Single publish-path compiler — server bootstrap calls this at publish time.
 */

import type { AuthoredSyncFlowStep, PublishedSyncDefinition } from "@mia/shared-types"

import { orderEntityTables } from "./entity-registry/order.js"
import { projectTablePredicate } from "./entity-registry/project-predicate.js"
import type { EntityDefinition } from "./entity-registry/types.js"
import {
  defaultSyncDefinitionFlowTemplateId,
  getSyncDefinitionFlowTemplateSteps,
  type SyncDefinitionFlowTemplateCatalog
} from "./sync-definition-flow-templates.js"

export interface SyncDefinitionConfigInput {
  flow_preset: string
  execution_steps_json: string
  service_profile_ref: string
  environment_policy_ref: string
  ownership_team: string
  ownership_owner: string | null
  review_status: "legacy-review-required" | "reviewed"
  ownership_notes_json: string
}

function resolveExecutionSteps(
  config: SyncDefinitionConfigInput,
  entityId: string,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog
): AuthoredSyncFlowStep[] {
  try {
    const parsed = JSON.parse(config.execution_steps_json) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as AuthoredSyncFlowStep[]
  } catch {
    // fall through to preset-derived default
  }
  const flowTemplateId = defaultSyncDefinitionFlowTemplateId(entityId, flowTemplateCatalog)
  return getSyncDefinitionFlowTemplateSteps(flowTemplateCatalog, flowTemplateId)
}

export function composePublishedSyncDefinition(
  entity: EntityDefinition,
  config: SyncDefinitionConfigInput,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
  publishedAt: string,
  publishedVersion: string
): PublishedSyncDefinition {
  const executionSteps = resolveExecutionSteps(config, entity.id, flowTemplateCatalog)
  const orderedTables = orderEntityTables(entity)
  const executionOrder = orderedTables.map((table) => table.name)
  const reverseOrder = entity.reverseOrder.length > 0 ? entity.reverseOrder : [...executionOrder].reverse()

  return {
    schemaVersion: 1,
    id: entity.id,
    displayName: entity.displayName,
    description: entity.description,
    rootTable: entity.rootTable,
    idColumn: entity.idColumn,
    labelColumn: entity.labelColumn,
    selfJoinColumn: entity.selfJoinColumn,
    legacy: {
      pipelineId: entity.provenance.kind === "legacy-migration" ? entity.provenance.legacyPipelineId : null,
      entrySproc: entity.legacyEntrySproc ?? null
    },
    governance: {
      freezeWindowIds: entity.policies.freezeWindowIds,
      riskMultiplier: entity.policies.riskMultiplier
    },
    strategy: {
      strategyId: entity.scd2.strategyId,
      strategyVersion: entity.scd2.strategyVersion
    },
    bindings: {
      serviceProfileRef: config.service_profile_ref,
      environmentPolicyRef: config.environment_policy_ref
    },
    ownership: {
      team: config.ownership_team,
      owner: config.ownership_owner,
      reviewStatus: config.review_status,
      notes: JSON.parse(config.ownership_notes_json) as string[]
    },
    metadata: {
      tables: entity.tables.map((table) => ({
        name: table.name,
        scopeColumn: table.scope?.kind === "rootPk" ? table.scope.column : (table.scopeColumn ?? null),
        predicate: projectTablePredicate(entity, table),
        source: table.source ?? "manual",
        verified: Boolean(table.verified),
        groundedByPipeline: Boolean(table.groundedByPipeline),
        enabledByDefault: table.enabledByDefault ?? true,
        userControllable: table.userControllable ?? false,
        ...(table.note ? { note: table.note } : {})
      })),
      executionOrder,
      reverseOrder,
      discrepancies: entity.discrepancies.map((note) => ({
        table: entity.rootTable,
        kind: "drift" as const,
        note
      }))
    },
    executionFlow: {
      steps: executionSteps
    },
    provenance: {
      kind: entity.provenance.kind === "legacy-migration" ? "legacy-migration" : "manual",
      sourceArtifact: `entity-registry:${entity.tenantId}/${entity.id}`,
      sourceVersion: String(entity.version)
    },
    publishedAt,
    publishedVersion
  }
}

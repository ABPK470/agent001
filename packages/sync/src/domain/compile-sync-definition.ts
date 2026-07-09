/**
 * Single sync-definition compiler.
 *
 * Entity registry + admin config → authored or published definition.
 * All paths (scaffold, publish, runtime) share one metadata builder.
 */

import type { AuthoredSyncDefinition, AuthoredSyncFlowStep, PublishedSyncDefinition } from "@mia/shared-types"

import { normalizeEntityDefinition } from "./entity-registry/normalize-table-scope.js"
import { orderEntityTables } from "./entity-registry/order.js"
import { projectTablePredicate } from "./entity-registry/project-predicate.js"
import type { EntityDefinition } from "./entity-registry/types.js"
import type { FlowCatalog } from "./flow-catalog.js"
import { normalizeAuthoredSyncFlowSteps } from "./normalize-flow-step.js"
import {
  defaultSyncDefinitionFlowTemplateId,
  getSyncDefinitionFlowTemplateSteps,
  hasSyncDefinitionFlowTemplate,
  type SyncDefinitionFlowTemplateCatalog,
} from "./sync-definition-flow-templates.js"
import { resolveFlowSteps } from "./resolve-flow-steps.js"

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

export interface CompileAuthoredOptions {
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog
  config?: Partial<SyncDefinitionConfigInput>
  serviceProfileRef?: string
  environmentPolicyRef?: string
  sourceArtifact?: string | null
  ownershipNotes?: string[]
}

function defaultConfig(entityId: string, catalog: SyncDefinitionFlowTemplateCatalog): SyncDefinitionConfigInput {
  const flowTemplateId = defaultSyncDefinitionFlowTemplateId(entityId, catalog)
  return {
    flow_preset: flowTemplateId,
    execution_steps_json: JSON.stringify(getSyncDefinitionFlowTemplateSteps(catalog, flowTemplateId)),
    service_profile_ref: "default",
    environment_policy_ref: "default",
    ownership_team: "sync-platform",
    ownership_owner: null,
    review_status: "legacy-review-required",
    ownership_notes_json: JSON.stringify(["Managed via entity registry + sync admin."])
  }
}

function resolveExecutionSteps(
  config: SyncDefinitionConfigInput,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
  entity: EntityDefinition,
  flowCatalog?: FlowCatalog,
): AuthoredSyncFlowStep[] {
  const steps = resolveFlowSteps(config.flow_preset, flowTemplateCatalog)
  return flowCatalog
    ? normalizeAuthoredSyncFlowSteps(
        steps,
        { entityId: entity.id, rootTable: entity.rootTable },
        flowCatalog,
      )
    : steps
}

function buildDefinitionCore(
  entity: EntityDefinition,
  config: SyncDefinitionConfigInput,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
  provenance: AuthoredSyncDefinition["provenance"],
  flowCatalog?: FlowCatalog,
): AuthoredSyncDefinition {
  const normalized = normalizeEntityDefinition(entity)
  const executionSteps = resolveExecutionSteps(config, flowTemplateCatalog, entity, flowCatalog)
  const orderedTables = orderEntityTables(normalized)
  const executionOrder = orderedTables.map((table) => table.name)
  const reverseOrder =
    (normalized.reverseOrder?.length ?? 0) > 0 ? normalized.reverseOrder! : [...executionOrder].reverse()

  return {
    schemaVersion: 1,
    id: normalized.id,
    displayName: normalized.displayName,
    description: normalized.description,
    rootTable: normalized.rootTable,
    idColumn: normalized.idColumn,
    labelColumn: normalized.labelColumn,
    selfJoinColumn: normalized.selfJoinColumn,
    legacy: {
      pipelineId: normalized.provenance.kind === "legacy-migration" ? normalized.provenance.legacyPipelineId : null,
      entrySproc: normalized.legacyEntrySproc ?? null
    },
    governance: {
      freezeWindowIds: normalized.policies.freezeWindowIds,
    },
    strategy: {
      strategyId: normalized.scd2.strategyId,
      strategyVersion: normalized.scd2.strategyVersion
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
      tables: normalized.tables.map((table) => ({
        name: table.name,
        scopeColumn: table.scope?.kind === "rootPk" ? table.scope.column : (table.scopeColumn ?? null),
        predicate: projectTablePredicate(normalized, table),
        source: table.source ?? "manual",
        verified: Boolean(table.verified),
        groundedByPipeline: Boolean(table.groundedByPipeline),
        enabledByDefault: table.enabledByDefault ?? true,
        userControllable: table.userControllable ?? false,
        ...(table.note ? { note: table.note } : {})
      })),
      executionOrder,
      reverseOrder,
      discrepancies: (normalized.discrepancies ?? []).map((note) => ({
        table: normalized.rootTable,
        kind: "drift" as const,
        note
      }))
    },
    executionFlow: { steps: executionSteps },
    provenance
  }
}

export function compileAuthoredSyncDefinition(
  entity: EntityDefinition,
  options: CompileAuthoredOptions
): AuthoredSyncDefinition {
  const base = defaultConfig(entity.id, options.flowTemplateCatalog)
  const config: SyncDefinitionConfigInput = {
    ...base,
    ...options.config,
    service_profile_ref: options.serviceProfileRef ?? options.config?.service_profile_ref ?? base.service_profile_ref,
    environment_policy_ref:
      options.environmentPolicyRef ?? options.config?.environment_policy_ref ?? base.environment_policy_ref,
    ownership_notes_json: JSON.stringify(
      options.ownershipNotes ??
        (options.config?.ownership_notes_json
          ? (JSON.parse(options.config.ownership_notes_json) as string[])
          : JSON.parse(base.ownership_notes_json))
    )
  }
  return buildDefinitionCore(entity, config, options.flowTemplateCatalog, {
    kind: entity.provenance.kind === "legacy-migration" ? "legacy-migration" : "manual",
    sourceArtifact: options.sourceArtifact ?? null,
    sourceVersion: entity.version === undefined ? null : String(entity.version)
  })
}

export function compilePublishedSyncDefinition(
  entity: EntityDefinition,
  config: SyncDefinitionConfigInput,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
  flowCatalog: FlowCatalog,
  publishedAt: string,
  publishedVersion: string,
): PublishedSyncDefinition {
  const authored = buildDefinitionCore(entity, config, flowTemplateCatalog, {
    kind: entity.provenance.kind === "legacy-migration" ? "legacy-migration" : "manual",
    sourceArtifact: `entity-registry:${entity.tenantId}/${entity.id}`,
    sourceVersion: String(entity.version),
  }, flowCatalog)
  const catalog = flowCatalog.snapForSteps(authored.executionFlow.steps)
  return {
    ...authored,
    executionFlow: { steps: authored.executionFlow.steps, catalog },
    publishedAt,
    publishedVersion,
  }
}

/** @deprecated Use compilePublishedSyncDefinition */
export const composePublishedSyncDefinition = compilePublishedSyncDefinition

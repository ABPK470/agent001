import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
    AuthoredSyncDefinition,
    AuthoredSyncFlowKind,
    AuthoredSyncFlowPhase,
    EntityRegistrySyncDefinitionStatusItem,
    EntityRegistrySyncDefinitionStatusLayer,
    EntityRegistrySyncDefinitionStatusResponse,
    EntityRegistrySyncFlowPreset,
} from "@mia/shared-types"
import type { EntityDefinition } from "@mia/sync"

const SYNC_DEFINITIONS_DIR = "sync-definitions/entities"
const PUBLISHED_BUNDLE_PATH = "sync-definitions/published/definitions.bundle.json"
const COMPATIBILITY_EXPORT_PATH = "deploy/mssql/sync-recipes.json"

const FLOW_PRESETS: Record<EntityRegistrySyncFlowPreset, AuthoredSyncDefinition["executionFlow"]["steps"]> = {
  contract: [
    step("audit-check", "pre-transaction", "auditCheck", "Audit check", "Validate target state before contract sync."),
    step("target-lock", "pre-transaction", "targetLock", "Target lock", "Lock the target contract deployment window."),
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected contract scope."),
    step("pipeline-register", "post-metadata", "pipelineRegister", "Pipeline register", "Register affected pipelines with the target agent service."),
    step("contract-deploy", "post-metadata", "contractDeploy", "Contract deploy", "Run the contract deployment sequence on the target environment."),
  ],
  dataset: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected dataset scope."),
    step("dataset-deploy", "post-metadata", "datasetDeploy", "Dataset deploy", "Deploy the dataset using the target ETL service."),
    step("sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the dataset sync date after deployment."),
  ],
  rule: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected rule scope."),
    step("dataset-deploy", "post-metadata", "datasetDeploy", "Dataset deploy", "Deploy datasets required by the rule on the target ETL service."),
    step("rules-deploy", "post-metadata", "rulesDeploy", "Rules deploy", "Deploy the rule package on the target ETL service."),
    step("handle-dependencies", "post-metadata", "handleDependencies", "Handle dependencies", "Refresh direct dependency state after rule deployment."),
    step("sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the rule sync date."),
    step("deploy-date", "post-metadata", "deployDate", "Deploy date", "Stamp the rule deploy date."),
  ],
  pipelineActivity: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected pipeline activity scope."),
    step("pipeline-register", "post-metadata", "pipelineRegister", "Pipeline register", "Register the target pipeline with the agent service."),
  ],
  gateMetadata: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected gate metadata scope."),
    step("meta-refresh", "post-metadata", "metaRefresh", "Meta refresh", "Refresh target gate metadata."),
    step("pipeline-start", "post-metadata", "pipelineStart", "Pipeline start", "Start the downstream gate refresh pipeline."),
  ],
  content: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected content scope."),
    step("handle-dependencies", "post-metadata", "handleDependencies", "Handle dependencies", "Refresh downstream content dependency state."),
  ],
  "metadata-only": [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected entity scope."),
  ],
}

const COMPATIBILITY_LAYERS: EntityRegistrySyncDefinitionStatusLayer[] = [
  {
    id: "compatibility-recipe-export",
    title: "Recipe-shaped compatibility export",
    runtimeAuthority: false,
    status: "migration",
    description: "deploy/mssql/sync-recipes.json and /api/sync/recipes still exist for compatibility, but they are derived from published definitions and are not runtime authority.",
  },
  {
    id: "entity-registry-projector",
    title: "Entity-registry recipe projector",
    runtimeAuthority: false,
    status: "cleanup-required",
    description: "The entity-registry projector remains in tree for migration and comparison flows; authors should treat repo definitions as the only runtime source of truth.",
  },
  {
    id: "entity-registry-yaml-bootstrap",
    title: "Entity-registry YAML bootstrap",
    runtimeAuthority: false,
    status: "cleanup-required",
    description: "Manual YAML reseed still exists as a migration helper. New structural changes should go through draft export into repo definitions rather than relying on bootstrap state.",
  },
]

export interface BuildSyncDefinitionDraftOptions {
  flowPreset?: EntityRegistrySyncFlowPreset
  serviceProfileRef?: string
  environmentPolicyRef?: string
}

export function buildSyncDefinitionDraft(
  entity: EntityDefinition,
  options: BuildSyncDefinitionDraftOptions = {},
): { flowPreset: EntityRegistrySyncFlowPreset; draft: AuthoredSyncDefinition; warnings: string[] } {
  const flowPreset = options.flowPreset ?? defaultFlowPreset(entity.id)
  const warnings = collectDraftWarnings(entity, flowPreset)
  const tables = [...entity.tables]
    .sort((left, right) => left.executionOrder - right.executionOrder)
    .map((table) => ({
      name: table.name,
      scopeColumn: table.scopeColumn ?? (table.scope.kind === "rootPk" ? table.scope.column : null),
      predicate: projectPredicate(entity, table),
      source: table.source ?? "manual",
      verified: table.verified,
      groundedByPipeline: table.groundedByPipeline ?? false,
      enabledByDefault: table.enabledByDefault ?? true,
      userControllable: table.userControllable ?? false,
      ...(table.note ? { note: table.note } : {}),
    }))
  const executionOrder = tables.map((table) => table.name)

  return {
    flowPreset,
    warnings,
    draft: {
      schemaVersion: 1,
      id: entity.id,
      displayName: entity.displayName,
      description: entity.description && entity.description.trim().length > 0
        ? entity.description
        : `${entity.displayName} sync definition scaffolded from Entity Registry draft.`,
      rootTable: entity.rootTable,
      idColumn: entity.idColumn,
      labelColumn: entity.labelColumn,
      selfJoinColumn: entity.selfJoinColumn,
      legacy: {
        pipelineId: entity.provenance.kind === "legacy-migration" ? entity.provenance.legacyPipelineId : null,
        entrySproc: entity.legacyEntrySproc,
      },
      governance: {
        approvalPolicyId: entity.policies.approvalPolicyId,
        freezeWindowIds: [...entity.policies.freezeWindowIds],
        riskMultiplier: entity.policies.riskMultiplier,
      },
      strategy: {
        strategyId: entity.scd2.strategyId,
        strategyVersion: entity.scd2.strategyVersion,
      },
      bindings: {
        serviceProfileRef: options.serviceProfileRef ?? "default",
        environmentPolicyRef: options.environmentPolicyRef ?? "default",
      },
      ownership: {
        team: "sync-platform",
        owner: null,
        reviewStatus: entity.provenance.kind === "legacy-migration" ? "legacy-review-required" : "reviewed",
        notes: entity.provenance.kind === "legacy-migration"
          ? ["Generated from an Entity Registry draft that still carries legacy provenance."]
          : ["Generated from an Entity Registry draft."],
      },
      metadata: {
        tables,
        executionOrder,
        reverseOrder: entity.reverseOrder.length > 0 ? [...entity.reverseOrder] : [...executionOrder].reverse(),
        discrepancies: entity.discrepancies.map((note) => ({ table: entity.rootTable, kind: "drift", note })),
      },
      executionFlow: {
        steps: FLOW_PRESETS[flowPreset],
      },
      provenance: {
        kind: entity.provenance.kind === "legacy-migration" ? "legacy-migration" : "manual",
        sourceArtifact: entity.provenance.kind === "legacy-migration" ? "entity-registry" : "entity-registry",
        sourceVersion: entity.versionLabel ?? String(entity.version),
      },
    },
  }
}

export function buildSyncDefinitionAuthoringStatus(projectRoot: string): EntityRegistrySyncDefinitionStatusResponse {
  const definitions = loadRepoDefinitions(projectRoot)
  return {
    runtimeAuthority: {
      sourceDirectory: SYNC_DEFINITIONS_DIR,
      publishedBundlePath: PUBLISHED_BUNDLE_PATH,
      compatibilityExportPath: COMPATIBILITY_EXPORT_PATH,
    },
    draftExport: {
      route: "/api/entity-registry/entities/:id/export-sync-definition",
      defaultOutputDirectory: SYNC_DEFINITIONS_DIR,
      supportedFlowPresets: Object.keys(FLOW_PRESETS) as EntityRegistrySyncFlowPreset[],
    },
    compatibilityLayers: COMPATIBILITY_LAYERS,
    definitions,
  }
}

export function findSyncDefinitionStatus(
  projectRoot: string,
  entityId: string,
): EntityRegistrySyncDefinitionStatusItem | null {
  return buildSyncDefinitionAuthoringStatus(projectRoot).definitions.find((entry) => entry.id === entityId) ?? null
}

function loadRepoDefinitions(projectRoot: string): EntityRegistrySyncDefinitionStatusItem[] {
  const dir = resolve(projectRoot, SYNC_DEFINITIONS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = resolve(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as AuthoredSyncDefinition
        return [toStatusItem(parsed)]
      } catch (error) {
        console.warn("[entity-registry] failed to read sync definition status:", error instanceof Error ? error.message : error)
        return []
      }
    })
}

function toStatusItem(definition: AuthoredSyncDefinition): EntityRegistrySyncDefinitionStatusItem {
  const unverifiedTableCount = definition.metadata.tables.filter((table) => table.verified === false).length
  const cleanupWarnings = [
    ...(definition.ownership.reviewStatus !== "reviewed"
      ? [`Ownership review is still pending for team ${definition.ownership.team}.`]
      : []),
    ...(definition.provenance.kind === "legacy-migration"
      ? ["Definition was bootstrapped from legacy data and still needs deliberate review, ownership, and provenance cleanup."]
      : []),
    ...(unverifiedTableCount > 0
      ? [`${unverifiedTableCount} table(s) are still marked unverified in the authored definition.`]
      : []),
  ]
  return {
    id: definition.id,
    displayName: definition.displayName,
    definitionPath: `${SYNC_DEFINITIONS_DIR}/${definition.id}.json`,
    provenanceKind: definition.provenance.kind,
    ownershipTeam: definition.ownership.team,
    ownershipOwner: definition.ownership.owner,
    reviewStatus: definition.ownership.reviewStatus,
    sourceArtifact: definition.provenance.sourceArtifact ?? null,
    sourceVersion: definition.provenance.sourceVersion ?? null,
    unverifiedTableCount,
    cleanupWarnings,
  }
}

function collectDraftWarnings(entity: EntityDefinition, flowPreset: EntityRegistrySyncFlowPreset): string[] {
  const warnings: string[] = []
  const unverifiedTableCount = entity.tables.filter((table) => table.verified === false).length
  if (entity.provenance.kind === "legacy-migration") {
    warnings.push("Entity Registry definition still carries legacy-migration provenance; assign deliberate ownership before publishing the repo definition.")
  }
  warnings.push("Assign an explicit owner and set ownership.reviewStatus to reviewed once the repo definition has been deliberately curated.")
  if (unverifiedTableCount > 0) {
    warnings.push(`${unverifiedTableCount} table(s) are still marked unverified in the draft source and should be reviewed before publish.`)
  }
  if (flowPreset === "metadata-only") {
    warnings.push("Using the metadata-only flow preset. Add the intended post-metadata execution steps before compile/publish.")
  }
  return warnings
}

function defaultFlowPreset(entityId: string): EntityRegistrySyncFlowPreset {
  return entityId in FLOW_PRESETS ? entityId as EntityRegistrySyncFlowPreset : "metadata-only"
}

function projectPredicate(entity: EntityDefinition, table: EntityDefinition["tables"][number]): string {
  const hasSelfJoin = entity.selfJoinColumn !== null && entity.selfJoinColumn.trim() !== ""
  switch (table.scope.kind) {
    case "rootPk": {
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `${quoteIdentifier(table.scope.column)}${op}`
    }
    case "sql":
      return table.scope.predicate
    case "fkPath": {
      if (table.scope.through.length === 0) return "1 = 0 -- fkPath with no hops"
      const aliases = table.scope.through.map((_, index) => `h${index}`)
      const joins: string[] = []
      for (let index = 0; index < table.scope.through.length; index++) {
        const hop = table.scope.through[index]!
        const alias = aliases[index]!
        if (index === 0) {
          joins.push(`FROM ${hop.table} AS ${alias}`)
        } else {
          const previousAlias = aliases[index - 1]!
          const previousHop = table.scope.through[index - 1]!
          joins.push(`JOIN ${hop.table} AS ${alias} ON ${alias}.${quoteIdentifier(hop.toColumn)} = ${previousAlias}.${quoteIdentifier(previousHop.fromColumn)}`)
        }
      }
      const firstHop = table.scope.through[0]!
      const lastHop = table.scope.through[table.scope.through.length - 1]!
      const lastAlias = aliases[aliases.length - 1]!
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `EXISTS (SELECT 1 ${joins.join(" ")} WHERE ${aliases[0]!}.${quoteIdentifier(firstHop.toColumn)} = ${table.name}.${quoteIdentifier(firstHop.toColumn)} AND ${lastAlias}.${quoteIdentifier(lastHop.fromColumn)}${op})`
    }
  }
}

function quoteIdentifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `[${identifier}]`
}

function step(
  id: string,
  phase: AuthoredSyncFlowPhase,
  kind: AuthoredSyncFlowKind,
  title: string,
  description: string,
) {
  return { id, phase, kind, title, description }
}
import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

import type { AuthoredSyncDefinition, EntityRegistrySyncFlowTemplateId } from "@mia/shared-types"
import { parseAllDocuments } from "yaml"

import { orderEntityTables } from "./entity-registry/order.js"
import type { EntityDefinition } from "./entity-registry/types.js"
import {
  defaultSyncDefinitionFlowTemplateId,
  getSyncDefinitionFlowTemplateSteps,
  hasSyncDefinitionFlowTemplate,
  loadSyncDefinitionFlowTemplateCatalog,
  type SyncDefinitionFlowTemplateCatalog
} from "./sync-definition-flow-templates.js"

export interface SyncDefinitionScaffoldOptions {
  projectRoot?: string
  sourceArtifact?: string | null
  flowTemplateId?: EntityRegistrySyncFlowTemplateId | null
  serviceProfileRef?: string
  environmentPolicyRef?: string
  flowTemplateCatalog?: SyncDefinitionFlowTemplateCatalog
}

export function loadEntityDefinitionsFromDocument(inputPath: string): EntityDefinition[] {
  const text = readFileSync(inputPath, "utf-8")
  return parseAllDocuments(text, { strict: true })
    .filter((document) => document.contents !== null)
    .map((document) => document.toJSON() as EntityDefinition)
}

export function selectEntityDefinition(docs: EntityDefinition[], entityId?: string | null): EntityDefinition {
  const items = docs.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
  if (entityId) {
    const match = items.find((entry) => entry.id === entityId)
    if (!match) throw new Error(`Entity \"${entityId}\" not found in scaffold input.`)
    return match
  }
  if (items.length !== 1) {
    throw new Error(`Input contains ${items.length} entities; choose one with --entity <id>.`)
  }
  return items[0] as EntityDefinition
}

export function scaffoldSyncDefinition(
  entity: EntityDefinition,
  options: SyncDefinitionScaffoldOptions = {}
): AuthoredSyncDefinition {
  const flowTemplateCatalog = resolveFlowTemplateCatalog(options)
  const flowTemplateId =
    options.flowTemplateId ?? defaultSyncDefinitionFlowTemplateId(entity.id, flowTemplateCatalog)
  if (!hasSyncDefinitionFlowTemplate(flowTemplateCatalog, flowTemplateId)) {
    throw new Error(`Unknown flow template "${flowTemplateId}".`)
  }

  const tables = orderEntityTables({
    rootTable: entity.rootTable,
    tables: Array.isArray(entity.tables) ? entity.tables : []
  }).map((table) => projectMetadataTable(entity, table))
  const executionOrder = tables.map((table) => table.name)
  const reverseOrder =
    Array.isArray(entity.reverseOrder) && entity.reverseOrder.length > 0
      ? entity.reverseOrder.map(String)
      : [...executionOrder].reverse()

  return {
    schemaVersion: 1,
    id: String(entity.id),
    displayName: String(entity.displayName ?? entity.id),
    description:
      typeof entity.description === "string" && entity.description.trim().length > 0
        ? entity.description
        : `${String(entity.displayName ?? entity.id)} sync definition scaffolded from entity-registry data.`,
    rootTable: String(entity.rootTable),
    idColumn: String(entity.idColumn),
    labelColumn: typeof entity.labelColumn === "string" ? entity.labelColumn : null,
    selfJoinColumn: typeof entity.selfJoinColumn === "string" ? entity.selfJoinColumn : null,
    legacy: {
      pipelineId: extractLegacyPipelineId(entity.provenance),
      entrySproc: typeof entity.legacyEntrySproc === "string" ? entity.legacyEntrySproc : null
    },
    governance: {
      freezeWindowIds: Array.isArray(entity.policies?.freezeWindowIds)
        ? entity.policies.freezeWindowIds.map(String)
        : [],
      riskMultiplier: Number(entity.policies?.riskMultiplier ?? 1)
    },
    strategy: {
      strategyId: String(entity.scd2?.strategyId ?? "mymi-scd2"),
      strategyVersion: entity.scd2?.strategyVersion ?? "latest"
    },
    bindings: {
      serviceProfileRef: options.serviceProfileRef ?? "default",
      environmentPolicyRef: options.environmentPolicyRef ?? "default"
    },
    ownership: {
      team: "sync-platform",
      owner: null,
      reviewStatus: "legacy-review-required",
      notes: [
        "Scaffolded from Entity Registry data.",
        "Assign an explicit owner and complete review before compile/publish."
      ]
    },
    metadata: {
      tables,
      executionOrder,
      reverseOrder,
      discrepancies: Array.isArray(entity.discrepancies)
        ? entity.discrepancies.map((item) => ({
            table: entity.rootTable,
            kind: "drift" as const,
            note: String(item)
          }))
        : []
    },
    executionFlow: {
      steps: getSyncDefinitionFlowTemplateSteps(flowTemplateCatalog, flowTemplateId)
    },
    provenance: {
      kind: isLegacyMigrationProvenance(entity.provenance) ? "legacy-migration" : "manual",
      sourceArtifact: normalizeSourceArtifact(options.projectRoot, options.sourceArtifact),
      sourceVersion: entity.version === undefined ? null : String(entity.version)
    }
  }
}

function resolveFlowTemplateCatalog(
  options: SyncDefinitionScaffoldOptions
): SyncDefinitionFlowTemplateCatalog {
  if (options.flowTemplateCatalog) return options.flowTemplateCatalog
  if (!options.projectRoot)
    throw new Error("projectRoot is required when flowTemplateCatalog is not provided.")
  return loadSyncDefinitionFlowTemplateCatalog(options.projectRoot)
}

function normalizeSourceArtifact(
  projectRoot: string | undefined,
  sourceArtifact: string | null | undefined
): string | null {
  if (!sourceArtifact) return null
  if (!projectRoot) return sourceArtifact
  return relative(resolve(projectRoot), resolve(sourceArtifact))
}

function projectMetadataTable(
  entity: EntityDefinition,
  table: EntityDefinition["tables"][number]
): AuthoredSyncDefinition["metadata"]["tables"][number] {
  const scopeColumn =
    typeof table.scopeColumn === "string"
      ? table.scopeColumn
      : table.scope?.kind === "rootPk"
        ? table.scope.column
        : null
  const projected: AuthoredSyncDefinition["metadata"]["tables"][number] = {
    name: String(table.name),
    scopeColumn,
    predicate: projectPredicate(entity, table),
    source: typeof table.source === "string" ? table.source : "manual",
    verified: Boolean(table.verified),
    groundedByPipeline: typeof table.groundedByPipeline === "boolean" ? table.groundedByPipeline : false,
    enabledByDefault: typeof table.enabledByDefault === "boolean" ? table.enabledByDefault : true,
    userControllable: typeof table.userControllable === "boolean" ? table.userControllable : false
  }
  if (typeof table.note === "string" && table.note.trim().length > 0) projected.note = table.note
  return projected
}

function projectPredicate(entity: EntityDefinition, table: EntityDefinition["tables"][number]): string {
  const scope = table.scope
  if (!scope || typeof scope !== "object" || typeof scope.kind !== "string") {
    throw new Error(`Table ${String(table.name)} is missing a valid scope definition.`)
  }
  const hasSelfJoin = typeof entity.selfJoinColumn === "string" && entity.selfJoinColumn.trim().length > 0
  switch (scope.kind) {
    case "rootPk": {
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `${quoteIdentifier(scope.column)}${op}`
    }
    case "sql":
      return String(scope.predicate)
    case "fkPath": {
      const through = Array.isArray(scope.through) ? scope.through : []
      if (through.length === 0) throw new Error(`Table ${String(table.name)} has fkPath scope with no hops.`)
      const aliases = through.map((_, index) => `h${index}`)
      const joins: string[] = []
      for (let index = 0; index < through.length; index++) {
        const hop = through[index]
        const alias = aliases[index]
        if (index === 0) {
          joins.push(`FROM ${hop.table} AS ${alias}`)
        } else {
          const previousAlias = aliases[index - 1]
          const previousHop = through[index - 1]
          joins.push(
            `JOIN ${hop.table} AS ${alias} ON ${alias}.${quoteIdentifier(hop.toColumn)} = ${previousAlias}.${quoteIdentifier(previousHop.fromColumn)}`
          )
        }
      }
      const firstHop = through[0]
      const lastHop = through[through.length - 1]
      const lastAlias = aliases[aliases.length - 1]
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `EXISTS (SELECT 1 ${joins.join(" ")} WHERE ${aliases[0]}.${quoteIdentifier(firstHop.toColumn)} = ${quoteRootRef(table.name, firstHop.toColumn)} AND ${lastAlias}.${quoteIdentifier(lastHop.fromColumn)}${op})`
    }
    default:
      throw new Error(`Unsupported scope kind for table ${String(table.name)}.`)
  }
}

function quoteIdentifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `[${identifier}]`
}

function quoteRootRef(tableName: string, column: string): string {
  return `${tableName}.${quoteIdentifier(column)}`
}

function extractLegacyPipelineId(provenance: EntityDefinition["provenance"]): number | null {
  return isLegacyMigrationProvenance(provenance) && Number.isInteger(provenance.legacyPipelineId)
    ? provenance.legacyPipelineId
    : null
}

function isLegacyMigrationProvenance(
  provenance: EntityDefinition["provenance"] | undefined
): provenance is Extract<EntityDefinition["provenance"], { kind: "legacy-migration" }> {
  return provenance?.kind === "legacy-migration"
}

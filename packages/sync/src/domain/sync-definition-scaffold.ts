import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

import type { AuthoredSyncDefinition, EntityRegistrySyncFlowTemplateId } from "@mia/shared-types"
import { parseAllDocuments } from "yaml"

import { compileAuthoredSyncDefinition } from "./compile-sync-definition.js"
import type { EntityDefinition } from "./entity-registry/types.js"
import {
  defaultSyncDefinitionFlowTemplateId,
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

  const definition = compileAuthoredSyncDefinition(entity, {
    flowTemplateCatalog,
    serviceProfileRef: options.serviceProfileRef,
    environmentPolicyRef: options.environmentPolicyRef,
    sourceArtifact: normalizeSourceArtifact(options.projectRoot, options.sourceArtifact),
    ownershipNotes: [
      "Scaffolded from Entity Registry data.",
      "Assign an explicit owner and complete review before publish."
    ],
    config: {
      flow_preset: flowTemplateId,
      execution_steps_json: JSON.stringify(
        flowTemplateCatalog.flowTemplates[flowTemplateId].steps
      ),
      service_profile_ref: options.serviceProfileRef ?? "default",
      environment_policy_ref: options.environmentPolicyRef ?? "default",
      ownership_team: "sync-platform",
      ownership_owner: null,
      review_status: "legacy-review-required",
      ownership_notes_json: JSON.stringify([
        "Scaffolded from Entity Registry data.",
        "Assign an explicit owner and complete review before publish."
      ])
    }
  })

  if (
    typeof entity.description === "string" &&
    entity.description.trim().length > 0 &&
    definition.description !== entity.description
  ) {
    definition.description = entity.description
  }

  return definition
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

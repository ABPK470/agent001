import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
  AuthoredSyncDefinition,
  EntityRegistrySyncFlowTemplateId,
  SyncDefinitionRuntimeOptions
} from "@mia/shared-types"

import {
  DEFAULT_SYNC_METADATA_PATH,
  loadSyncMetadataArtifact,
  syncMetadataFlowTemplateCatalog
} from "./load-sync-metadata-artifact.js"

export interface SyncDefinitionFlowTemplate {
  label: string
  description: string
  steps: AuthoredSyncDefinition["executionFlow"]["steps"]
}

/** Raw shape parsed from disk/metadata — only `version` and `flowTemplates` are read. */
interface FlowTemplateCatalogInput {
  version?: unknown
  flowTemplates?: Record<string, unknown>
}

export interface SyncDefinitionFlowTemplateCatalog {
  version: 1
  flowTemplates: Record<EntityRegistrySyncFlowTemplateId, SyncDefinitionFlowTemplate>
}

export const DEFAULT_SYNC_DEFINITION_FLOW_TEMPLATES_PATH = "deploy/sync/artifacts/flow-templates.json"
/** Prefer {@link DEFAULT_SYNC_METADATA_PATH} — flow-templates.json is a derived view of sync-metadata.flows. */

const KNOWN_FLOW_TEMPLATE_IDS: EntityRegistrySyncFlowTemplateId[] = [
  "contract",
  "dataset",
  "rule",
  "pipelineActivity",
  "gateMetadata",
  "content",
  "metadataOnly"
]

export function loadSyncDefinitionFlowTemplateCatalog(
  projectRoot: string,
  relPath = DEFAULT_SYNC_DEFINITION_FLOW_TEMPLATES_PATH
): SyncDefinitionFlowTemplateCatalog {
  const metadataPath = resolve(projectRoot, DEFAULT_SYNC_METADATA_PATH)
  if (existsSync(metadataPath)) {
    return loadFlowTemplateCatalogFromMetadata(projectRoot)
  }

  const path = resolve(projectRoot, relPath)
  if (!existsSync(path)) {
    throw new Error(
      `Sync definition flow template catalog not found at ${relPath} or ${DEFAULT_SYNC_METADATA_PATH}.`
    )
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as FlowTemplateCatalogInput
  return parseFlowTemplateCatalog(parsed, relPath)
}

function loadFlowTemplateCatalogFromMetadata(projectRoot: string): SyncDefinitionFlowTemplateCatalog {
  const metadata = loadSyncMetadataArtifact(projectRoot)
  const raw = syncMetadataFlowTemplateCatalog(metadata)
  return parseFlowTemplateCatalog(raw, DEFAULT_SYNC_METADATA_PATH)
}

function parseFlowTemplateCatalog(
  parsed: FlowTemplateCatalogInput,
  sourceLabel: string
): SyncDefinitionFlowTemplateCatalog {
  if (parsed.version !== 1) {
    throw new Error(`Unsupported sync definition flow template catalog version: ${String(parsed.version)}`)
  }
  if (!parsed.flowTemplates || typeof parsed.flowTemplates !== "object") {
    throw new Error(`Sync definition flow template catalog at ${sourceLabel} is missing flowTemplates.`)
  }

  const flowTemplates = Object.fromEntries(
    KNOWN_FLOW_TEMPLATE_IDS.map((templateId) => {
      const raw = parsed.flowTemplates?.[templateId]
      if (!raw || typeof raw !== "object")
        throw new Error(`Sync definition flow template catalog at ${sourceLabel} is missing template ${templateId}.`)
      const template = raw as Partial<SyncDefinitionFlowTemplate>
      if (typeof template.label !== "string" || template.label.trim() === "")
        throw new Error(`Template ${templateId} is missing label.`)
      if (typeof template.description !== "string")
        throw new Error(`Template ${templateId} is missing description.`)
      if (!Array.isArray(template.steps)) throw new Error(`Template ${templateId} is missing steps.`)
      return [
        templateId,
        {
          label: template.label,
          description: template.description,
          steps: template.steps as AuthoredSyncDefinition["executionFlow"]["steps"]
        }
      ]
    })
  ) as Record<EntityRegistrySyncFlowTemplateId, SyncDefinitionFlowTemplate>

  return {
    version: 1,
    flowTemplates
  }
}

export function hasSyncDefinitionFlowTemplate(
  catalog: SyncDefinitionFlowTemplateCatalog,
  flowTemplateId: string
): flowTemplateId is EntityRegistrySyncFlowTemplateId {
  return flowTemplateId in catalog.flowTemplates
}

export function defaultSyncDefinitionFlowTemplateId(
  entityId: string,
  catalog: SyncDefinitionFlowTemplateCatalog
): EntityRegistrySyncFlowTemplateId {
  return hasSyncDefinitionFlowTemplate(catalog, entityId) ? entityId : "metadataOnly"
}

export function buildSyncDefinitionRuntimeFlowOptions(
  catalog: SyncDefinitionFlowTemplateCatalog
): SyncDefinitionRuntimeOptions["flowTemplates"] {
  return (Object.keys(catalog.flowTemplates) as EntityRegistrySyncFlowTemplateId[]).map((id) => ({
    id,
    label: catalog.flowTemplates[id].label,
    description: catalog.flowTemplates[id].description
  }))
}

export function buildSyncDefinitionFlowTemplateSteps(
  catalog: SyncDefinitionFlowTemplateCatalog
): SyncDefinitionRuntimeOptions["flowTemplateSteps"] {
  return Object.fromEntries(
    (Object.keys(catalog.flowTemplates) as EntityRegistrySyncFlowTemplateId[]).map((id) => [
      id,
      catalog.flowTemplates[id].steps
    ])
  ) as SyncDefinitionRuntimeOptions["flowTemplateSteps"]
}

export function getSyncDefinitionFlowTemplateSteps(
  catalog: SyncDefinitionFlowTemplateCatalog,
  flowTemplateId: EntityRegistrySyncFlowTemplateId
): AuthoredSyncDefinition["executionFlow"]["steps"] {
  return catalog.flowTemplates[flowTemplateId].steps
}

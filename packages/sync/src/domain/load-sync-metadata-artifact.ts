/**
 * Load deploy-owned sync metadata artifact (phases, step types, flows).
 *
 * Authority: deploy/sync/artifacts/sync-metadata.json → SQLite → runtime snapshot.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
  AuthoredSyncFlowStep,
  CustomValueSourceDefinition,
  SyncFlowKindDefinition,
  SyncFlowPhaseDefinition,
} from "@mia/shared-types"

export const DEFAULT_SYNC_METADATA_PATH = "deploy/sync/artifacts/sync-metadata.json"

export interface SyncMetadataPhase {
  id: string
  label: string
  sortOrder: number
  definition: SyncFlowPhaseDefinition
}

export interface SyncMetadataStepType {
  id: string
  label: string
  definition: SyncFlowKindDefinition
}

export interface SyncMetadataFlow {
  label: string
  description: string
  steps: AuthoredSyncFlowStep[]
}

export interface SyncMetadataCustomValueSource {
  id: string
  label: string
  definition: CustomValueSourceDefinition
}

export interface SyncMetadataArtifact {
  version: 1
  _comment?: string
  phases: SyncMetadataPhase[]
  stepTypes: SyncMetadataStepType[]
  customValueSources?: SyncMetadataCustomValueSource[]
  flows: Record<string, SyncMetadataFlow>
}

export function loadSyncMetadataArtifact(
  projectRoot: string,
  relPath = DEFAULT_SYNC_METADATA_PATH,
): SyncMetadataArtifact {
  const path = resolve(projectRoot, relPath)
  if (!existsSync(path)) {
    throw new Error(`Sync metadata artifact not found at ${relPath}.`)
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SyncMetadataArtifact>
  if (parsed.version !== 1) {
    throw new Error(`Unsupported sync metadata artifact version: ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    throw new Error(`Sync metadata artifact at ${relPath} is missing phases.`)
  }
  if (!Array.isArray(parsed.stepTypes) || parsed.stepTypes.length === 0) {
    throw new Error(`Sync metadata artifact at ${relPath} is missing stepTypes.`)
  }
  if (!parsed.flows || typeof parsed.flows !== "object") {
    throw new Error(`Sync metadata artifact at ${relPath} is missing flows.`)
  }

  for (const phase of parsed.phases) {
    if (!phase?.id || !phase.label || typeof phase.sortOrder !== "number" || !phase.definition) {
      throw new Error(`Invalid phase entry in sync metadata artifact at ${relPath}.`)
    }
  }
  for (const stepType of parsed.stepTypes) {
    if (!stepType?.id || !stepType.label || !stepType.definition?.handler) {
      throw new Error(`Invalid step type "${stepType?.id ?? "?"}" in sync metadata artifact at ${relPath}.`)
    }
  }

  for (const source of parsed.customValueSources ?? []) {
    if (!source?.id || !source.label || !source.definition?.query) {
      throw new Error(
        `Invalid custom value source "${source?.id ?? "?"}" in sync metadata artifact at ${relPath}.`,
      )
    }
  }

  return {
    ...(parsed as SyncMetadataArtifact),
    customValueSources: parsed.customValueSources ?? [],
  }
}

export function syncMetadataFlowTemplateCatalog(metadata: SyncMetadataArtifact) {
  return {
    version: 1 as const,
    _comment: metadata._comment,
    flowTemplates: metadata.flows,
  }
}

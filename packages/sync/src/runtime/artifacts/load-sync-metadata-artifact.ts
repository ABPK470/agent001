/**
 * Load deploy-owned sync metadata artifact (phases, actions, flows, value sources).
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

export interface SyncMetadataAction {
  id: string
  label: string
  definition: SyncFlowKindDefinition
}

/** @deprecated Use SyncMetadataAction */
export type SyncMetadataStepType = SyncMetadataAction

export interface SyncMetadataFlow {
  label: string
  description: string
  steps: AuthoredSyncFlowStep[]
}

export interface SyncMetadataValueSource {
  id: string
  label: string
  definition: CustomValueSourceDefinition
}

/** @deprecated Use SyncMetadataValueSource */
export type SyncMetadataCustomValueSource = SyncMetadataValueSource

export interface SyncMetadataArtifact {
  version: 1
  _comment?: string
  phases: SyncMetadataPhase[]
  actions: SyncMetadataAction[]
  valueSources?: SyncMetadataValueSource[]
  flows: Record<string, SyncMetadataFlow>
}

type RawSyncMetadataArtifact = Partial<SyncMetadataArtifact> & {
  /** @deprecated Prefer `actions` */
  stepTypes?: SyncMetadataAction[]
  /** @deprecated Prefer `valueSources` */
  customValueSources?: SyncMetadataValueSource[]
}

function readActions(parsed: RawSyncMetadataArtifact): SyncMetadataAction[] | undefined {
  if (Array.isArray(parsed.actions)) return parsed.actions
  if (Array.isArray(parsed.stepTypes)) return parsed.stepTypes
  return undefined
}

function readValueSources(parsed: RawSyncMetadataArtifact): SyncMetadataValueSource[] {
  if (Array.isArray(parsed.valueSources)) return parsed.valueSources
  if (Array.isArray(parsed.customValueSources)) return parsed.customValueSources
  return []
}

export function loadSyncMetadataArtifact(
  projectRoot: string,
  relPath = DEFAULT_SYNC_METADATA_PATH,
): SyncMetadataArtifact {
  const path = resolve(projectRoot, relPath)
  if (!existsSync(path)) {
    throw new Error(`Sync metadata artifact not found at ${relPath}.`)
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as RawSyncMetadataArtifact
  if (parsed.version !== 1) {
    throw new Error(`Unsupported sync metadata artifact version: ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    throw new Error(`Sync metadata artifact at ${relPath} is missing phases.`)
  }
  const actions = readActions(parsed)
  if (!actions || actions.length === 0) {
    throw new Error(`Sync metadata artifact at ${relPath} is missing actions.`)
  }
  if (!parsed.flows || typeof parsed.flows !== "object") {
    throw new Error(`Sync metadata artifact at ${relPath} is missing flows.`)
  }

  for (const phase of parsed.phases) {
    if (!phase?.id || !phase.label || typeof phase.sortOrder !== "number" || !phase.definition) {
      throw new Error(`Invalid phase entry in sync metadata artifact at ${relPath}.`)
    }
  }
  for (const action of actions) {
    if (!action?.id || !action.label || !action.definition?.handler) {
      throw new Error(`Invalid action "${action?.id ?? "?"}" in sync metadata artifact at ${relPath}.`)
    }
  }

  const valueSources = readValueSources(parsed)
  for (const source of valueSources) {
    if (!source?.id || !source.label || !source.definition) {
      throw new Error(
        `Invalid value source "${source?.id ?? "?"}" in sync metadata artifact at ${relPath}.`,
      )
    }
    const resolver = (source.definition as { resolver?: unknown }).resolver
    if (!resolver || typeof resolver !== "object" || !("kind" in resolver)) {
      throw new Error(
        `Invalid value source "${source.id}" in sync metadata artifact at ${relPath}: missing resolver.`,
      )
    }
  }

  return {
    version: 1,
    _comment: parsed._comment,
    phases: parsed.phases,
    actions,
    valueSources,
    flows: parsed.flows,
  }
}

export function syncMetadataFlowTemplateCatalog(metadata: SyncMetadataArtifact) {
  return {
    version: 1 as const,
    _comment: metadata._comment,
    flowTemplates: metadata.flows,
  }
}

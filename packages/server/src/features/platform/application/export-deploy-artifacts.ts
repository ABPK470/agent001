/**
 * Export SQLite catalog state to a user-chosen snapshot folder (never overwrites repo seeds).
 *
 * Ground truth flow:
 *   artifact (git) → seed SQLite → operator edits in UI → export snapshot → review → commit manually
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import type { EntityDefinition, Scd2Strategy, SyncEnvironment } from "@mia/sync"
import { buildFlowCatalog } from "@mia/sync"

import type { EntityRegistryExportDocument } from "../../sync/domain/entity-yaml.js"
import { buildEntityRegistryExportDocument, entityRunYamlFromConfig } from "../../sync/domain/entity-yaml.js"
import * as db from "../../../platform/persistence/sqlite.js"

const DEFAULT_TENANT = "_default"

export const EXPORT_FOLDER_PREFIX = "mia-sync-export"

export interface DeployCatalogSnapshot {
  exportedAt: string
  tenantId: string
  syncMetadata: Record<string, unknown>
  strategies: Record<string, unknown>
  environments: Record<string, unknown>
  entityRegistry: EntityRegistryExportDocument | null
  entityIds: string[]
}

export interface BuildDeployCatalogSnapshotOptions {
  tenantId?: string
  includeRetiredEntities?: boolean
}

export interface WriteDeployCatalogSnapshotOptions extends BuildDeployCatalogSnapshotOptions {
  /** Parent directory — a timestamped subfolder is created here. */
  outputParentDir: string
  /** When true, also create `{folder}.zip` if the `zip` CLI is available. */
  zip?: boolean
  /** Remove the folder after a successful zip. */
  zipOnly?: boolean
}

export interface DeployCatalogExportResult {
  folderPath: string
  folderName: string
  zipPath: string | null
  files: string[]
  snapshot: DeployCatalogSnapshot
}

export function defaultExportParentDir(): string {
  return join(homedir(), "Downloads")
}

export function exportTimestampFolderName(exportedAt = new Date()): string {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, "-")
  return `${EXPORT_FOLDER_PREFIX}-${stamp}`
}

function exportSyncMetadataDocument(tenantId: string) {
  const phases = db.listSyncRunPhases(tenantId).map((row) => ({
    id: row.id,
    label: row.label,
    sortOrder: row.sort_order,
    definition: db.mapPhaseDefinition(row),
  }))

  const stepTypes = db.listSyncRunKinds(tenantId).map((row) => ({
    id: row.id,
    label: row.label,
    definition: db.mapKindDefinition(row),
  }))

  const customValueSources = db.listSyncRunBindingSources(tenantId).map((row) => ({
    id: row.id,
    label: row.label,
    definition: db.mapCustomValueSourceDefinition(row),
  }))

  const flows = Object.fromEntries(
    db.listSyncRunPresets(tenantId).map((row) => [
      row.id,
      {
        label: row.label,
        description: row.description,
        steps: db.parsePresetSteps(row.steps_json),
      },
    ]),
  )

  buildFlowCatalog(
    db.listSyncRunPhases(tenantId),
    db.listSyncRunKinds(tenantId),
    db.listSyncRunBindingSources(tenantId),
    db.listSyncRunPresets(tenantId),
  )

  return {
    version: 1 as const,
    _comment:
      "SQLite snapshot — phases, step types (actions), wiring (value sources), and flows. Not a repo seed overwrite.",
    phases,
    stepTypes,
    customValueSources,
    flows,
  }
}

function exportStrategiesDocument(tenantId: string) {
  const strategies = db.listAvailableStrategies(tenantId) as Scd2Strategy[]

  return {
    version: 1 as const,
    _comment: "SQLite snapshot — SCD2 strategies available to the tenant (shipped + custom).",
    strategies,
  }
}

function exportEnvironmentsDocument() {
  const environments = db.listSyncEnvironments().map((row) => {
    const body = JSON.parse(row.body_json) as SyncEnvironment
    return {
      name: body.name,
      displayName: body.displayName,
      color: body.color,
      role: body.role,
      ringOrder: body.ringOrder,
      agentServiceBaseUrl: body.agentServiceBaseUrl,
      etlServiceBaseUrl: body.etlServiceBaseUrl,
      gateServiceBaseUrl: body.gateServiceBaseUrl,
      syncAllowlist: body.syncAllowlist ?? [],
      allowedSyncTargets: body.allowedSyncTargets ?? [],
      defaultAccessMode: body.defaultAccessMode,
      allowedOperations: body.allowedOperations,
      denyDml: body.denyDml,
      denyDdl: body.denyDdl,
      approvalRequiredOperations: body.approvalRequiredOperations,
    }
  })

  return {
    version: 1 as const,
    _comment: "SQLite snapshot — sync environments.",
    environments,
  }
}

function exportEntityRegistryDocument(tenantId: string, includeRetired: boolean): {
  document: EntityRegistryExportDocument | null
  entityIds: string[]
} {
  const definitions = db.listEntityDefinitions(tenantId, { includeRetired }) as EntityDefinition[]
  const runs = new Map(
    definitions
      .map((def) => {
        const config = db.getSyncDefinitionConfig(tenantId, def.id)
        return config ? ([def.id, entityRunYamlFromConfig(config)] as const) : null
      })
      .filter((entry): entry is readonly [string, ReturnType<typeof entityRunYamlFromConfig>] => entry !== null),
  )

  return {
    document: definitions.length > 0 ? buildEntityRegistryExportDocument(definitions, runs) : null,
    entityIds: definitions.map((def) => def.id),
  }
}

export function buildDeployCatalogSnapshot(
  options: BuildDeployCatalogSnapshotOptions = {},
): DeployCatalogSnapshot {
  const tenantId = options.tenantId ?? DEFAULT_TENANT
  const exportedAt = new Date().toISOString()
  const entities = exportEntityRegistryDocument(tenantId, options.includeRetiredEntities ?? false)

  return {
    exportedAt,
    tenantId,
    syncMetadata: exportSyncMetadataDocument(tenantId),
    strategies: exportStrategiesDocument(tenantId),
    environments: exportEnvironmentsDocument(),
    entityRegistry: entities.document,
    entityIds: entities.entityIds,
  }
}

function writeJsonFile(dir: string, name: string, doc: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf-8")
  return name
}

function tryZipDirectory(folderPath: string, folderName: string): string | null {
  const parent = resolve(folderPath, "..")
  const zipPath = join(parent, `${folderName}.zip`)
  const result = spawnSync("zip", ["-r", zipPath, folderName], {
    cwd: parent,
    encoding: "utf-8",
  })
  if (result.status !== 0) return null
  return zipPath
}

export function writeDeployCatalogSnapshot(
  options: WriteDeployCatalogSnapshotOptions,
): DeployCatalogExportResult {
  const snapshot = buildDeployCatalogSnapshot(options)
  const folderName = exportTimestampFolderName(new Date(snapshot.exportedAt))
  const folderPath = resolve(options.outputParentDir, folderName)
  mkdirSync(folderPath, { recursive: true })

  const files = [
    writeJsonFile(folderPath, "manifest.json", {
      exportedAt: snapshot.exportedAt,
      tenantId: snapshot.tenantId,
      entityCount: snapshot.entityIds.length,
      entityIds: snapshot.entityIds,
      files: [
        "sync-metadata.json",
        "strategies.json",
        "sync-environments.json",
        "entity-registry.json",
      ],
    }),
    writeJsonFile(folderPath, "sync-metadata.json", snapshot.syncMetadata),
    writeJsonFile(folderPath, "strategies.json", snapshot.strategies),
    writeJsonFile(folderPath, "sync-environments.json", snapshot.environments),
  ]

  if (snapshot.entityRegistry) {
    files.push(writeJsonFile(folderPath, "entity-registry.json", snapshot.entityRegistry))
  }

  let zipPath: string | null = null
  if (options.zip) {
    zipPath = tryZipDirectory(folderPath, folderName)
    if (zipPath && options.zipOnly) {
      rmSync(folderPath, { recursive: true, force: true })
    }
  }

  return { folderPath, folderName, zipPath, files, snapshot }
}

/** @deprecated Use buildDeployCatalogSnapshot + writeDeployCatalogSnapshot */
export function exportDeployArtifactsFromSqlite(
  options: {
    tenantId?: string
    projectRoot?: string
    include?: {
      syncMetadata?: boolean
      strategies?: boolean
      environments?: boolean
    }
  } = {},
) {
  void options.projectRoot
  void options.include
  const snapshot = buildDeployCatalogSnapshot({ tenantId: options.tenantId })
  return {
    paths: {},
    syncMetadata: snapshot.syncMetadata,
    strategies: snapshot.strategies,
    environments: snapshot.environments,
    entityRegistry: snapshot.entityRegistry,
    entityIds: snapshot.entityIds,
  }
}

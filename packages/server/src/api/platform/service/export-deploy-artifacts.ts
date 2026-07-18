/**
 * Export SQLite catalog state to a user-chosen snapshot folder (never overwrites repo seeds).
 *
 * Ground truth flow:
 *   artifact (git) → seed SQLite → operator edits in UI → export snapshot → review → commit manually
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { EntityDefinition, Scd2Strategy, SyncEnvironment } from "@mia/sync"

import type { EntityRegistryExportDocument } from "../../sync/types/entity-yaml.js"
import { buildEntityRegistryExportDocument, entityRunYamlFromConfig } from "../../sync/types/entity-yaml.js"
import { assertTenantEntitiesExportable } from "../../sync/service/assert-entity-export.js"
import * as db from "../../../infra/persistence/sqlite.js"

const DEFAULT_TENANT = "_default"

export const EXPORT_FOLDER_PREFIX = "mia-sync-export"

export interface DeployCatalogSnapshot {
  exportedAt: string
  tenantId: string
  syncMetadata: Record<string, unknown>
  flowTemplates: Record<string, unknown>
  strategies: Record<string, unknown>
  environments: Record<string, unknown>
  entityRegistry: EntityRegistryExportDocument | null
  /** @deprecated Legacy zip compat only — new exports leave this null; run bindings live on entities. */
  syncDefinitionConfigs: SyncDefinitionConfigExportDocument | null
  entityIds: string[]
}

export interface SyncDefinitionConfigExportDocument {
  version: 1
  _comment: string
  configs: Array<{
    entityId: string
    flowPreset: string
    serviceProfileRef: string
    environmentPolicyRef: string
    ownershipTeam: string
    ownershipOwner: string | null
    reviewStatus: "legacy-review-required" | "reviewed"
    ownershipNotes: string[]
  }>
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
  const phases = db.listSyncPhases(tenantId).map((row) => ({
    id: row.id,
    label: row.label,
    sortOrder: row.sort_order,
    definition: db.mapPhaseDefinition(row),
  }))

  const actions = db.listSyncActions(tenantId).map((row) => ({
    id: row.id,
    label: row.label,
    definition: db.mapKindDefinition(row),
  }))

  const valueSources = db.listSyncValueSources(tenantId).map((row) => ({
    id: row.id,
    label: row.label,
    definition: db.mapValueSourceDefinition(row),
  }))

  const flows = Object.fromEntries(
    db.listSyncFlows(tenantId).map((row) => [
      row.id,
      {
        label: row.label,
        description: row.description,
        steps: db.parseFlowSteps(row.steps_json),
      },
    ]),
  )

  return {
    version: 1 as const,
    _comment:
      "SQLite snapshot — phases, actions, value sources, and flows. Not a repo seed overwrite.",
    phases,
    actions,
    valueSources,
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
      connectorId: body.connectorId ?? null,
      displayName: body.displayName,
      color: body.color,
      role: body.role,
      ringOrder: body.ringOrder,
      agentServiceBaseUrl: body.agentServiceBaseUrl,
      etlServiceBaseUrl: body.etlServiceBaseUrl,
      gateServiceBaseUrl: body.gateServiceBaseUrl,
      serviceUrls: body.serviceUrls,
      allowedSyncEnvironments: body.allowedSyncEnvironments ?? [],
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

function exportFlowTemplatesDocument(syncMetadata: Record<string, unknown>) {
  return {
    version: 1 as const,
    _comment:
      typeof syncMetadata._comment === "string"
        ? syncMetadata._comment
        : "Derived view of sync-metadata.flows",
    flowTemplates: syncMetadata.flows ?? {},
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
  assertTenantEntitiesExportable(tenantId, {
    includeRetired: options.includeRetiredEntities ?? false,
  })
  const exportedAt = new Date().toISOString()
  const entities = exportEntityRegistryDocument(tenantId, options.includeRetiredEntities ?? false)
  const syncMetadata = exportSyncMetadataDocument(tenantId)

  return {
    exportedAt,
    tenantId,
    syncMetadata,
    flowTemplates: exportFlowTemplatesDocument(syncMetadata),
    strategies: exportStrategiesDocument(tenantId),
    environments: exportEnvironmentsDocument(),
    entityRegistry: entities.document,
    syncDefinitionConfigs: null,
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
  const artifactsDir = join(folderPath, "artifacts")
  mkdirSync(artifactsDir, { recursive: true })

  const artifactFiles = [
    "sync-metadata.json",
    "strategies.json",
    "flow-templates.json",
    ...(snapshot.entityRegistry ? ["entity-registry.json"] : []),
  ]

  const files = [
    writeJsonFile(folderPath, "manifest.json", {
      exportedAt: snapshot.exportedAt,
      tenantId: snapshot.tenantId,
      entityCount: snapshot.entityIds.length,
      entityIds: snapshot.entityIds,
      layout: "deploy/sync mirror",
      files: ["sync-environments.json", ...artifactFiles.map((name) => `artifacts/${name}`)],
    }),
    writeJsonFile(folderPath, "sync-environments.json", snapshot.environments),
    writeJsonFile(artifactsDir, "sync-metadata.json", snapshot.syncMetadata),
    writeJsonFile(artifactsDir, "strategies.json", snapshot.strategies),
    writeJsonFile(artifactsDir, "flow-templates.json", snapshot.flowTemplates),
  ]

  if (snapshot.entityRegistry) {
    files.push(writeJsonFile(artifactsDir, "entity-registry.json", snapshot.entityRegistry))
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

export function exportDeployCatalogZipBuffer(
  options: BuildDeployCatalogSnapshotOptions = {},
): { buffer: Buffer; filename: string; snapshot: DeployCatalogSnapshot } {
  const parent = mkdtempSync(join(tmpdir(), "mia-export-"))
  try {
    const result = writeDeployCatalogSnapshot({
      ...options,
      outputParentDir: parent,
      zip: true,
      zipOnly: true,
    })
    if (!result.zipPath) {
      throw new Error("Zip export is unavailable on this host (install the `zip` CLI).")
    }
    const buffer = readFileSync(result.zipPath)
    return { buffer, filename: `${result.folderName}.zip`, snapshot: result.snapshot }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
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
    flowTemplates: snapshot.flowTemplates,
    strategies: snapshot.strategies,
    environments: snapshot.environments,
    entityRegistry: snapshot.entityRegistry,
    entityIds: snapshot.entityIds,
  }
}

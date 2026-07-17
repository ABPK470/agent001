/**
 * Export SQLite state as deploy/sync git layout (format A).
 *
 * Produces artifacts/entities/*.json compiled from the entity registry,
 * plus sync-metadata, strategies, flow-templates, and sync-environments.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { EntityDefinition } from "@mia/sync"

import * as db from "../../../infra/persistence/sqlite.js"
import { loadAuthoringFlowCatalog } from "../../sync/service/definitions.js"
import {
  entityToAuthoredSyncDefinition,
  formatAuthoredSyncJson,
  syncConfigInputFromDb,
} from "../../sync/types/authored-sync-document.js"
import {
  buildDeployCatalogSnapshot,
  type BuildDeployCatalogSnapshotOptions,
} from "./export-deploy-artifacts.js"

const DEFAULT_TENANT = "_default"
export const DEPLOY_GIT_EXPORT_PREFIX = "mia-deploy-artifacts"

export interface DeployGitExportResult {
  folderPath: string
  folderName: string
  zipPath: string | null
  files: string[]
  entityIds: string[]
}

export interface WriteDeployGitExportOptions extends BuildDeployCatalogSnapshotOptions {
  outputParentDir: string
  projectRoot: string
  zip?: boolean
  zipOnly?: boolean
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

function exportAuthoredEntityFiles(
  projectRoot: string,
  tenantId: string,
  entitiesDir: string,
  entityIds: string[],
): string[] {
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const files: string[] = []

  for (const entityId of entityIds) {
    const def = db.getEntityDefinition(tenantId, entityId, { includeRetired: true }) as EntityDefinition | null
    if (!def) continue
    const configRow = db.getSyncDefinitionConfig(tenantId, entityId)
    const authored = entityToAuthoredSyncDefinition(
      def,
      flowTemplateCatalog,
      configRow ? syncConfigInputFromDb(configRow) : null,
    )
    const name = `${entityId}.json`
    writeFileSync(join(entitiesDir, name), formatAuthoredSyncJson(authored), "utf-8")
    files.push(`artifacts/entities/${name}`)
  }

  return files
}

export function writeDeployGitExport(options: WriteDeployGitExportOptions): DeployGitExportResult {
  const tenantId = options.tenantId ?? DEFAULT_TENANT
  const snapshot = buildDeployCatalogSnapshot({
    tenantId,
    includeRetiredEntities: options.includeRetiredEntities,
  })

  const folderName = `${DEPLOY_GIT_EXPORT_PREFIX}-${snapshot.exportedAt.replace(/[:.]/g, "-")}`
  const folderPath = resolve(options.outputParentDir, folderName)
  const artifactsDir = join(folderPath, "artifacts")
  const entitiesDir = join(artifactsDir, "entities")
  mkdirSync(entitiesDir, { recursive: true })

  const entityFiles = exportAuthoredEntityFiles(
    options.projectRoot,
    tenantId,
    entitiesDir,
    snapshot.entityIds,
  )

  const artifactFiles = [
    "sync-metadata.json",
    "strategies.json",
    "flow-templates.json",
    ...entityFiles.map((path) => path.replace(/^artifacts\//, "")),
  ]

  const files = [
    writeJsonFile(folderPath, "manifest.json", {
      exportedAt: snapshot.exportedAt,
      tenantId: snapshot.tenantId,
      kind: "deploy-git-layout",
      entityCount: snapshot.entityIds.length,
      entityIds: snapshot.entityIds,
      layout: "deploy/sync",
      files: ["sync-environments.json", ...artifactFiles.map((name) => `artifacts/${name}`)],
    }),
    writeJsonFile(folderPath, "sync-environments.json", snapshot.environments),
    writeJsonFile(artifactsDir, "sync-metadata.json", snapshot.syncMetadata),
    writeJsonFile(artifactsDir, "strategies.json", snapshot.strategies),
    writeJsonFile(artifactsDir, "flow-templates.json", snapshot.flowTemplates),
    ...entityFiles,
  ]

  let zipPath: string | null = null
  if (options.zip) {
    zipPath = tryZipDirectory(folderPath, folderName)
    if (zipPath && options.zipOnly) {
      rmSync(folderPath, { recursive: true, force: true })
    }
  }

  return {
    folderPath,
    folderName,
    zipPath,
    files,
    entityIds: snapshot.entityIds,
  }
}

export function exportDeployGitZipBuffer(
  projectRoot: string,
  options: BuildDeployCatalogSnapshotOptions = {},
): { buffer: Buffer; filename: string; entityIds: string[] } {
  const parent = mkdtempSync(join(tmpdir(), "mia-deploy-export-"))
  try {
    const result = writeDeployGitExport({
      ...options,
      projectRoot,
      outputParentDir: parent,
      zip: true,
      zipOnly: true,
    })
    if (!result.zipPath) {
      throw new Error("Zip export is unavailable on this host (install the `zip` CLI).")
    }
    return {
      buffer: readFileSync(result.zipPath),
      filename: `${result.folderName}.zip`,
      entityIds: result.entityIds,
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

export { defaultExportParentDir } from "./export-deploy-artifacts.js"

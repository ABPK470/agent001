/**
 * Export SQLite catalog state back to deploy/sync artifacts (BYO-JSON round-trip).
 *
 * Ground truth flow:
 *   artifact (git) → seed SQLite → operator edits in UI → export → review → commit
 */

import type { Scd2Strategy, SyncEnvironment } from "@mia/sync"
import { buildFlowCatalog } from "@mia/sync"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import * as db from "../../../platform/persistence/sqlite.js"

const DEFAULT_TENANT = "_default"

export interface ExportDeployArtifactsOptions {
  tenantId?: string
  /** When set, write files under this project root. Otherwise return JSON only. */
  projectRoot?: string
  include?: {
    syncMetadata?: boolean
    strategies?: boolean
    environments?: boolean
  }
}

export interface ExportDeployArtifactsResult {
  paths: Partial<{
    syncMetadata: string
    strategies: string
    environments: string
  }>
  syncMetadata?: Record<string, unknown>
  strategies?: Record<string, unknown>
  environments?: Record<string, unknown>
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

  // Validate catalog coherence before export.
  buildFlowCatalog(
    db.listSyncRunPhases(tenantId),
    db.listSyncRunKinds(tenantId),
    db.listSyncRunBindingSources(tenantId),
    db.listSyncRunPresets(tenantId),
  )

  return {
    version: 1 as const,
    _comment:
      "Exported from SQLite — phases, step types (actions), wiring (value sources), and flows. Review before commit.",
    phases,
    stepTypes,
    customValueSources,
    flows,
  }
}

function exportStrategiesDocument(tenantId: string) {
  const strategies = db.listAvailableStrategies(tenantId).filter(
    (strategy) => strategy.provenance?.kind === "bundled",
  ) as Scd2Strategy[]

  return {
    version: 1 as const,
    _comment:
      "Exported shipped SCD2 strategy presets from SQLite. Custom tenant strategies are omitted — export those via Entity Registry.",
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
    _comment: "Exported sync environments from SQLite. Review before commit.",
    environments,
  }
}

function writeJson(projectRoot: string, relPath: string, doc: unknown): string {
  const path = resolve(projectRoot, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf-8")
  return relPath
}

export function exportDeployArtifactsFromSqlite(
  options: ExportDeployArtifactsOptions = {},
): ExportDeployArtifactsResult {
  const tenantId = options.tenantId ?? DEFAULT_TENANT
  const include = {
    syncMetadata: true,
    strategies: true,
    environments: true,
    ...options.include,
  }
  const result: ExportDeployArtifactsResult = { paths: {} }

  if (include.syncMetadata) {
    result.syncMetadata = exportSyncMetadataDocument(tenantId)
    if (options.projectRoot) {
      result.paths.syncMetadata = writeJson(
        options.projectRoot,
        "deploy/sync/artifacts/sync-metadata.json",
        result.syncMetadata,
      )
    }
  }

  if (include.strategies) {
    result.strategies = exportStrategiesDocument(tenantId)
    if (options.projectRoot) {
      result.paths.strategies = writeJson(
        options.projectRoot,
        "deploy/sync/artifacts/strategies.json",
        result.strategies,
      )
    }
  }

  if (include.environments) {
    result.environments = exportEnvironmentsDocument()
    if (options.projectRoot) {
      result.paths.environments = writeJson(
        options.projectRoot,
        "deploy/sync/sync-environments.json",
        result.environments,
      )
    }
  }

  return result
}

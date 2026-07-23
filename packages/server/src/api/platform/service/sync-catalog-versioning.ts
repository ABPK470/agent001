import { parseBoundaryJson } from "../../../internal/parse-json.js"

/**
 * Sync catalog versioning — full-configuration snapshots in SQLite.
 *
 * SQLite is SOT; each mutation appends a version row. Export always reflects live DB.
 */

import type { AgentHost } from "@mia/agent"
import { EventType } from "@mia/shared-enums"

import { broadcast } from "../../../infra/events/broadcaster.js"
import * as db from "../../../infra/persistence/sqlite.js"
import { rebuildLiveSyncEnvironments } from "../../sync/state/live-environments.js"
import {
  applyDeployCatalogSnapshot,
  normalizeCatalogSnapshotPayload,
  parseCatalogZipBuffer,
  type CatalogImportResult,
} from "./import-deploy-artifacts.js"
import {
  diffDeployCatalogSnapshots,
  type DeployCatalogSnapshotDiff,
} from "./diff-deploy-catalog-snapshots.js"
import {
  buildDeployCatalogSnapshot,
  type DeployCatalogSnapshot,
} from "./export-deploy-artifacts.js"

const DEFAULT_TENANT = "_default"

export interface SyncCatalogVersionCommitResult {
  tenantId: string
  version: number
  reason: string
}

export function commitSyncCatalogVersion(args: {
  tenantId?: string
  reason: string
  actor: string
}): SyncCatalogVersionCommitResult {
  const tenantId = args.tenantId ?? DEFAULT_TENANT
  const snapshot = buildDeployCatalogSnapshot({ tenantId })
  const version = db.appendSyncCatalogVersion({
    tenantId,
    snapshotJson: JSON.stringify(snapshot),
    reason: args.reason,
    actor: args.actor,
  })
  broadcast({
    type: EventType.SyncCatalogVersionCommitted,
    data: {
      tenantId,
      version,
      reason: args.reason,
      actor: args.actor,
    },
  })
  return { tenantId, version, reason: args.reason }
}

export function ensureInitialSyncCatalogVersion(actor = "system"): SyncCatalogVersionCommitResult | null {
  if (db.countSyncCatalogVersions(DEFAULT_TENANT) > 0) return null
  return commitSyncCatalogVersion({ reason: "seed:initial", actor })
}

export function listSyncCatalogVersions(tenantId = DEFAULT_TENANT, limit = 50) {
  return db.listSyncCatalogVersionSummaries(tenantId, limit)
}

export function getActiveSyncCatalogVersion(tenantId = DEFAULT_TENANT): number | null {
  return db.getActiveSyncCatalogVersion(tenantId)
}

export interface SyncCatalogVersionDetailSummary {
  exportedAt: string
  tenantId: string
  entityIds: string[]
  entityCount: number
  configCount: number
  strategyCount: number
  environmentCount: number
  flowCount: number
  stepTypeCount: number
  customValueSourceCount: number
  entities: Array<{ id: string; displayName: string; rootTable: string }>
}

export interface SyncCatalogVersionDetail {
  tenantId: string
  version: number
  reason: string
  createdBy: string
  createdAt: string
  isActive: boolean
  summary: SyncCatalogVersionDetailSummary
}

function countRecordKeys(value: unknown): number {
  if (!value || typeof value !== "object") return 0
  const record = value as Record<string, unknown>
  if (Array.isArray(record.items)) return record.items.length
  if (Array.isArray(record.environments)) return record.environments.length
  if (Array.isArray(record.strategies)) return record.strategies.length
  if (Array.isArray(record.flows)) return record.flows.length
  if (Array.isArray(record.actions)) return record.actions.length
  if (Array.isArray(record.stepTypes)) return record.stepTypes.length
  if (Array.isArray(record.valueSources)) return record.valueSources.length
  if (Array.isArray(record.customValueSources)) return record.customValueSources.length
  return Object.keys(record).filter((key) => !key.startsWith("_") && key !== "version").length
}

export function summarizeDeployCatalogSnapshot(
  snapshot: DeployCatalogSnapshot,
): SyncCatalogVersionDetailSummary {
  const entities = (snapshot.entityRegistry?.entities ?? []).map((row) => {
    const record = row as Record<string, unknown>
    return {
      id: String(record.id ?? ""),
      displayName: String(record.displayName ?? record.id ?? ""),
      rootTable: String(record.rootTable ?? ""),
    }
  }).filter((row) => row.id.length > 0)

  const syncMetadata = snapshot.syncMetadata as Record<string, unknown>
  return {
    exportedAt: snapshot.exportedAt,
    tenantId: snapshot.tenantId,
    entityIds: snapshot.entityIds.length > 0 ? [...snapshot.entityIds] : entities.map((e) => e.id),
    entityCount: entities.length || snapshot.entityIds.length,
    configCount:
      snapshot.syncDefinitionConfigs?.configs.length ??
      (snapshot.entityRegistry?.entities ?? []).filter((entry) => {
        const flowId = (entry as { flowId?: string }).flowId
        return typeof flowId === "string" && flowId.trim().length > 0
      }).length,
    strategyCount: countRecordKeys(snapshot.strategies),
    environmentCount: countRecordKeys(snapshot.environments),
    flowCount: countRecordKeys(syncMetadata.flows),
    stepTypeCount: countRecordKeys(syncMetadata.actions ?? syncMetadata.stepTypes),
    customValueSourceCount: countRecordKeys(syncMetadata.valueSources ?? syncMetadata.customValueSources),
    entities,
  }
}

export function getSyncCatalogVersionDetail(
  version: number,
  tenantId = DEFAULT_TENANT,
): SyncCatalogVersionDetail | null {
  const row = db.getSyncCatalogVersionRow(tenantId, version)
  if (!row) return null
  const activeVersion = getActiveSyncCatalogVersion(tenantId)
  const snapshot = parseBoundaryJson(row.snapshot_json) as DeployCatalogSnapshot
  return {
    tenantId: row.tenant_id,
    version: row.version,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    isActive: row.version === activeVersion,
    summary: summarizeDeployCatalogSnapshot(snapshot),
  }
}

export function getSyncCatalogVersionDiff(args: {
  version: number
  against?: "previous" | "active" | number
  tenantId?: string
}): DeployCatalogSnapshotDiff | null {
  const tenantId = args.tenantId ?? DEFAULT_TENANT
  const toRow = db.getSyncCatalogVersionRow(tenantId, args.version)
  if (!toRow) return null

  const against = args.against ?? "previous"
  let fromVersion: number | null = null
  let againstKind: "previous" | "active" | "version" = "previous"

  if (against === "previous") {
    fromVersion = args.version > 1 ? args.version - 1 : null
    againstKind = "previous"
  } else if (against === "active") {
    fromVersion = getActiveSyncCatalogVersion(tenantId)
    againstKind = "active"
  } else {
    fromVersion = against
    againstKind = "version"
  }

  if (fromVersion === args.version) {
    return diffDeployCatalogSnapshots({
      from: parseBoundaryJson(toRow.snapshot_json) as DeployCatalogSnapshot,
      to: parseBoundaryJson(toRow.snapshot_json) as DeployCatalogSnapshot,
      fromVersion,
      toVersion: args.version,
      against: againstKind,
    })
  }

  let fromSnapshot: DeployCatalogSnapshot | null = null
  if (fromVersion != null) {
    const fromRow = db.getSyncCatalogVersionRow(tenantId, fromVersion)
    if (!fromRow) {
      if (againstKind === "previous") {
        fromSnapshot = null
        fromVersion = null
      } else {
        return null
      }
    } else {
      fromSnapshot = parseBoundaryJson(fromRow.snapshot_json) as DeployCatalogSnapshot
    }
  }

  return diffDeployCatalogSnapshots({
    from: fromSnapshot,
    to: parseBoundaryJson(toRow.snapshot_json) as DeployCatalogSnapshot,
    fromVersion,
    toVersion: args.version,
    against: againstKind,
  })
}

export function rollbackSyncCatalogVersion(args: {
  tenantId?: string
  targetVersion: number
  actor: string
  projectRoot?: string
  host?: AgentHost
}): { importResult: CatalogImportResult; version: SyncCatalogVersionCommitResult } {
  const tenantId = args.tenantId ?? DEFAULT_TENANT
  const row = db.getSyncCatalogVersionRow(tenantId, args.targetVersion)
  if (!row) throw new Error(`Unknown catalog version ${args.targetVersion}`)

  const snapshot = parseBoundaryJson(row.snapshot_json) as DeployCatalogSnapshot
  const importResult = applyDeployCatalogSnapshot({
    snapshot,
    actor: args.actor,
    projectRoot: args.projectRoot,
  })
  if (!importResult.ok) {
    throw new Error(importResult.errors.join("; ") || "Rollback apply failed")
  }

  if (args.host) rebuildLiveSyncEnvironments(args.host)

  const version = commitSyncCatalogVersion({
    tenantId,
    reason: `rollback:from:${args.targetVersion}`,
    actor: args.actor,
  })

  return { importResult, version }
}

export function importSyncCatalogBundle(args: {
  zipBase64?: string
  snapshot?: DeployCatalogSnapshot
  body?: Record<string, unknown>
  dryRun?: boolean
  reason: string
  actor: string
  projectRoot?: string
  host?: AgentHost
}): { preview: CatalogImportResult; version?: SyncCatalogVersionCommitResult } {
  let snapshot: DeployCatalogSnapshot
  if (args.snapshot) {
    snapshot = args.snapshot
  } else if (args.zipBase64) {
    const buffer = Buffer.from(args.zipBase64, "base64")
    snapshot = parseCatalogZipBuffer(buffer)
  } else if (args.body) {
    snapshot = normalizeCatalogSnapshotPayload(args.body)
  } else {
    throw new Error("Provide snapshot, zipBase64, or catalog bundle fields")
  }

  const preview = applyDeployCatalogSnapshot({
    snapshot,
    actor: args.actor,
    projectRoot: args.projectRoot,
    dryRun: args.dryRun ?? false,
  })

  if (args.dryRun || !preview.ok) {
    return { preview }
  }

  if (args.host) rebuildLiveSyncEnvironments(args.host)

  const version = commitSyncCatalogVersion({
    tenantId: snapshot.tenantId || DEFAULT_TENANT,
    reason: args.reason.trim() || "import",
    actor: args.actor,
  })

  return { preview, version }
}

/** Call after any catalog mutation that should be versioned. */
export function recordSyncCatalogChange(args: {
  reason: string
  actor: string
  tenantId?: string
}): SyncCatalogVersionCommitResult {
  return commitSyncCatalogVersion(args)
}

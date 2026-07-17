/**
 * Sync catalog versioning — full-configuration snapshots in SQLite.
 *
 * SQLite is SOT; each mutation appends a version row. Export always reflects live DB.
 */

import type { AgentHost } from "@mia/agent"

import * as db from "../../../infra/persistence/sqlite.js"
import { rebuildLiveSyncEnvironments } from "../../sync/state/live-environments.js"
import {
  applyDeployCatalogSnapshot,
  normalizeCatalogSnapshotPayload,
  parseCatalogZipBuffer,
  type CatalogImportResult,
} from "./import-deploy-artifacts.js"
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

  const snapshot = JSON.parse(row.snapshot_json) as DeployCatalogSnapshot
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

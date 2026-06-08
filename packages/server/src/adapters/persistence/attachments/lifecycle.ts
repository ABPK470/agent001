/**
 * Attachment lifecycle policy — retention TTLs and per-owner quotas.
 *
 * Defaults are conservative and overridable via environment variables so
 * operators can tune for their deployment without code changes:
 *
 *   MIA_ATTACHMENT_RETENTION_RUN_DAYS              (default 30)
 *   MIA_ATTACHMENT_RETENTION_SESSION_DAYS          (default 7)
 *   MIA_ATTACHMENT_RETENTION_WORKSPACE_ASSET_DAYS  (default 365)
 *   MIA_ATTACHMENT_OWNER_QUOTA_BYTES               (default 256 MiB)
 *
 * Retention is enforced as a soft delete in `pruneExpiredAttachments`,
 * which the server invokes at startup (alongside the existing run/event
 * pruning) so a long-running deployment doesn't accumulate stale rows.
 * Quota enforcement happens at upload time and is a hard rejection so
 * the user gets immediate feedback rather than a silent purge later.
 */

import { getDb } from "../db-connection.js"
import { AttachmentScope } from "../../../enums/attachments.js"
import { auditAttachmentsPruned } from "./audit.js"

const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024

export interface RetentionPolicy {
  runDays: number
  sessionDays: number
  workspaceAssetDays: number
  ownerQuotaBytes: number
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function getRetentionPolicy(): RetentionPolicy {
  return {
    runDays: envInt("MIA_ATTACHMENT_RETENTION_RUN_DAYS", 30),
    sessionDays: envInt("MIA_ATTACHMENT_RETENTION_SESSION_DAYS", 7),
    workspaceAssetDays: envInt("MIA_ATTACHMENT_RETENTION_WORKSPACE_ASSET_DAYS", 365),
    ownerQuotaBytes: envInt("MIA_ATTACHMENT_OWNER_QUOTA_BYTES", 256 * MIB)
  }
}

/**
 * Compute the ISO retention deadline for a newly uploaded attachment.
 * Returns null when no scope-specific TTL applies (defensive: callers
 * pass a known scope today).
 */
export function computeRetentionUntil(scope: AttachmentScope, now: Date = new Date()): string {
  const policy = getRetentionPolicy()
  const days =
    scope === AttachmentScope.Run
      ? policy.runDays
      : scope === AttachmentScope.Session
        ? policy.sessionDays
        : policy.workspaceAssetDays
  return new Date(now.getTime() + days * DAY_MS).toISOString()
}

export interface OwnerUsage {
  bytesUsed: number
  bytesQuota: number
  bytesRemain: number
}

/**
 * Sum live (non-deleted) attachment bytes for an owner. Used to enforce
 * per-user quota at upload time.
 */
export function getOwnerUsage(ownerUpn: string | null | undefined): OwnerUsage {
  const policy = getRetentionPolicy()
  if (!ownerUpn) {
    return { bytesUsed: 0, bytesQuota: policy.ownerQuotaBytes, bytesRemain: policy.ownerQuotaBytes }
  }
  const row = getDb()
    .prepare(
      `
    SELECT COALESCE(SUM(size_bytes), 0) AS used
    FROM attachments
    WHERE owner_upn = ? AND status != 'deleted'
  `
    )
    .get(ownerUpn) as { used: number }
  const used = Number(row.used ?? 0)
  return {
    bytesUsed: used,
    bytesQuota: policy.ownerQuotaBytes,
    bytesRemain: Math.max(0, policy.ownerQuotaBytes - used)
  }
}

export class QuotaExceededError extends Error {
  readonly bytesUsed: number
  readonly bytesQuota: number
  readonly attemptBytes: number
  constructor(usage: OwnerUsage, attemptBytes: number) {
    super(`attachment quota exceeded: ${usage.bytesUsed} + ${attemptBytes} > ${usage.bytesQuota} bytes`)
    this.name = "QuotaExceededError"
    this.bytesUsed = usage.bytesUsed
    this.bytesQuota = usage.bytesQuota
    this.attemptBytes = attemptBytes
  }
}

/**
 * Throws QuotaExceededError when accepting `incomingBytes` for `ownerUpn`
 * would push them over their quota. Pure DB read — safe to call many
 * times per request.
 */
export function assertOwnerQuota(ownerUpn: string | null | undefined, incomingBytes: number): void {
  if (!ownerUpn) return
  const usage = getOwnerUsage(ownerUpn)
  if (usage.bytesUsed + incomingBytes > usage.bytesQuota) {
    throw new QuotaExceededError(usage, incomingBytes)
  }
}

export interface PruneResult {
  prunedAttachments: number
}

/**
 * Soft-delete attachments whose retention_until has passed. We do not
 * physically remove blob bytes here — content-addressed storage means the
 * same hash may back another live row. A separate (future) GC pass over
 * unreferenced blobs can reclaim disk space.
 */
export function pruneExpiredAttachments(now: Date = new Date()): PruneResult {
  const cutoff = now.toISOString()
  const result = getDb()
    .prepare(
      `
    UPDATE attachments
    SET status = 'deleted'
    WHERE status != 'deleted'
      AND retention_until IS NOT NULL
      AND retention_until <= ?
  `
    )
    .run(cutoff)
  const pruned = { prunedAttachments: result.changes }
  auditAttachmentsPruned(pruned.prunedAttachments)
  return pruned
}

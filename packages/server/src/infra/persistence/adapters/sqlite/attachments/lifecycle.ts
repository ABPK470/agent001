/**
 * Attachment lifecycle policy — retention TTLs and per-owner quotas.
 *
 * Defaults are conservative and overridable via environment variables so
 * operators can tune for their deployment without code changes:
 *
 *   MIA_ATTACHMENT_RETENTION_RUN_DAYS              (default 30)
 *   MIA_ATTACHMENT_RETENTION_USER_DRAFT_DAYS       (default 7; legacy: MIA_ATTACHMENT_RETENTION_SESSION_DAYS)
 *   MIA_ATTACHMENT_RETENTION_WORKSPACE_ASSET_DAYS  (default 365)
 *   MIA_ATTACHMENT_OWNER_QUOTA_BYTES               (default 256 MiB)
 *
 * Retention is enforced as a soft delete in `pruneExpiredAttachments`,
 * which the server invokes at startup (alongside the existing run/event
 * pruning) so a long-running deployment doesn't accumulate stale rows.
 * Quota enforcement happens at upload time and is a hard rejection so
 * the user gets immediate feedback rather than a silent purge later.
 */

import { sql } from "kysely"
import { AttachmentScope } from "../../../../../internal/enums/attachments.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runChangesAsync, runGetAsync } from "../../../schema/execute-async.js"
import { AttachmentStatus } from "./repo.js"
import { auditAttachmentsPruned } from "./audit.js"

const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024

export interface RetentionPolicy {
  runDays: number
  userDraftDays: number
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
    userDraftDays: envInt(
      "MIA_ATTACHMENT_RETENTION_USER_DRAFT_DAYS",
      envInt("MIA_ATTACHMENT_RETENTION_SESSION_DAYS", 7)
    ),
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
      : scope === AttachmentScope.UserDraft
        ? policy.userDraftDays
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
export async function getOwnerUsage(ownerUpn: string | null | undefined): Promise<OwnerUsage> {
  const policy = getRetentionPolicy()
  if (!ownerUpn) {
    return { bytesUsed: 0, bytesQuota: policy.ownerQuotaBytes, bytesRemain: policy.ownerQuotaBytes }
  }
  const compiled = getPlatformDb()
    .selectFrom("attachments")
    .select(sql<number>`coalesce(sum(size_bytes), 0)`.as("used"))
    .where("owner_upn", "=", ownerUpn)
    .where("status", "!=", AttachmentStatus.Deleted)
    .compile()
  const row = await runGetAsync<{ used: number | bigint }>(compiled)
  const used = Number(row?.used ?? 0)
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
export async function assertOwnerQuota(ownerUpn: string | null | undefined, incomingBytes: number): Promise<void> {
  if (!ownerUpn) return
  const usage = await getOwnerUsage(ownerUpn)
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
export async function pruneExpiredAttachments(now: Date = new Date()): Promise<PruneResult> {
  const cutoff = now.toISOString()
  const compiled = getPlatformDb()
    .updateTable("attachments")
    .set({ status: AttachmentStatus.Deleted })
    .where("status", "!=", AttachmentStatus.Deleted)
    .where("retention_until", "is not", null)
    .where("retention_until", "<=", cutoff)
    .compile()
  const pruned = { prunedAttachments: await runChangesAsync(compiled) }
  await auditAttachmentsPruned(pruned.prunedAttachments)
  return pruned
}

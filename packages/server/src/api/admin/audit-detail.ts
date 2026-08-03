/**
 * Admin audit detail envelope — before/after embeds or version-store refs.
 * audit_log stays an event index; never a parallel revision table.
 */

export const AUDIT_DETAIL_MAX_BYTES = 50 * 1024

export type AuditVersionRef = {
  kind: "entity_version" | "strategy_version" | "catalog_version"
  tenantId?: string
  id?: string
  version?: number
  prevVersion?: number
  catalogVersion?: number
  againstCatalogVersion?: number
}

export type AuditDetailEnvelope = Record<string, unknown> & {
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  ref?: AuditVersionRef
  /** Set when full before/after were dropped for size. */
  truncated?: boolean
}

/** Deep-clone plain JSON; drop functions / undefined. */
export function auditSnapshot(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value !== "object") return { value }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  } catch {
    return { error: "unserialisable" }
  }
}

function byteLength(obj: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(obj), "utf8")
  } catch {
    return AUDIT_DETAIL_MAX_BYTES + 1
  }
}

const SAMPLE_STRING_MAX = 200

function tinyScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string" && value.length <= SAMPLE_STRING_MAX) return value
  return undefined
}

function changedKeysOnly(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const b = before ?? {}
  const a = after ?? {}
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const fields: string[] = []
  const samples: Record<string, unknown> = {}
  for (const key of keys) {
    const bv = b[key]
    const av = a[key]
    if (JSON.stringify(bv) === JSON.stringify(av)) continue
    fields.push(key)
    const sample = tinyScalar(av) ?? tinyScalar(bv)
    if (sample !== undefined) samples[key] = sample
  }
  return { fields, ...(Object.keys(samples).length > 0 ? { samples } : {}) }
}

/**
 * Merge sparse base fields with sanitised before/after.
 * If serialised size exceeds 50KB, fall back to changed-keys / sparse only.
 */
export function withBeforeAfter(
  base: Record<string, unknown>,
  before: unknown,
  after: unknown,
): AuditDetailEnvelope {
  const beforeSnap = before === undefined ? undefined : auditSnapshot(before)
  const afterSnap = after === undefined ? undefined : auditSnapshot(after)
  const full: AuditDetailEnvelope = {
    ...base,
    before: beforeSnap === undefined ? undefined : beforeSnap,
    after: afterSnap === undefined ? undefined : afterSnap,
  }
  if (byteLength(full) <= AUDIT_DETAIL_MAX_BYTES) return full

  const keysOnly = changedKeysOnly(beforeSnap, afterSnap)
  const capped: AuditDetailEnvelope = {
    ...base,
    ...keysOnly,
    truncated: true,
  }
  if (byteLength(capped) <= AUDIT_DETAIL_MAX_BYTES) return capped

  // Last resort: sparse base only (never mid-JSON truncate).
  return { ...base, truncated: true }
}

export function withEntityVersionRef(
  base: Record<string, unknown>,
  args: { tenantId: string; id: string; version: number; prevVersion?: number },
): AuditDetailEnvelope {
  return {
    ...base,
    ref: {
      kind: "entity_version",
      tenantId: args.tenantId,
      id: args.id,
      version: args.version,
      ...(args.prevVersion != null ? { prevVersion: args.prevVersion } : {}),
    },
  }
}

export function withStrategyVersionRef(
  base: Record<string, unknown>,
  args: { tenantId: string; id: string; version: number; prevVersion?: number },
): AuditDetailEnvelope {
  return {
    ...base,
    ref: {
      kind: "strategy_version",
      tenantId: args.tenantId,
      id: args.id,
      version: args.version,
      ...(args.prevVersion != null ? { prevVersion: args.prevVersion } : {}),
    },
  }
}

export function withCatalogVersionRef(
  base: Record<string, unknown>,
  args: { catalogVersion: number; againstCatalogVersion?: number; tenantId?: string },
): AuditDetailEnvelope {
  return {
    ...base,
    ref: {
      kind: "catalog_version",
      ...(args.tenantId ? { tenantId: args.tenantId } : {}),
      catalogVersion: args.catalogVersion,
      ...(args.againstCatalogVersion != null
        ? { againstCatalogVersion: args.againstCatalogVersion }
        : {}),
    },
  }
}

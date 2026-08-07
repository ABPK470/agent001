/**
 * In-memory run/plan → owner UPN index for SSE viewing-as (no DB on fanout).
 */

import { sameUpn } from "../internal/upn.js"

export interface RunOwnerIndex {
  rememberRun(runId: string, upn: string | null | undefined): void
  rememberPlan(planId: string, upn: string | null | undefined): void
  lookupRun(runId: string): string | null
  lookupPlan(planId: string): string | null
  forgetRun(runId: string): void
  forgetPlan(planId: string): void
}

function normalizeUpn(upn: string | null | undefined): string | null {
  const t = upn?.trim().toLowerCase()
  return t && t.length > 0 ? t : null
}

export class MemoryRunOwnerIndex implements RunOwnerIndex {
  private readonly runs = new Map<string, string>()
  private readonly plans = new Map<string, string>()

  rememberRun(runId: string, upn: string | null | undefined): void {
    const n = normalizeUpn(upn)
    if (!runId || !n) return
    this.runs.set(runId, n)
  }

  rememberPlan(planId: string, upn: string | null | undefined): void {
    const n = normalizeUpn(upn)
    if (!planId || !n) return
    this.plans.set(planId, n)
  }

  lookupRun(runId: string): string | null {
    return this.runs.get(runId) ?? null
  }

  lookupPlan(planId: string): string | null {
    return this.plans.get(planId) ?? null
  }

  forgetRun(runId: string): void {
    this.runs.delete(runId)
  }

  forgetPlan(planId: string): void {
    this.plans.delete(planId)
  }
}

const _default = new MemoryRunOwnerIndex()

export function rememberRunOwner(runId: string, upn: string | null | undefined): void {
  _default.rememberRun(runId, upn)
}

export function rememberPlanOwner(planId: string, upn: string | null | undefined): void {
  _default.rememberPlan(planId, upn)
}

export function lookupRunOwner(runId: string): string | null {
  return _default.lookupRun(runId)
}

export function lookupPlanOwner(planId: string): string | null {
  return _default.lookupPlan(planId)
}

export function getRunOwnerIndex(): RunOwnerIndex {
  return _default
}

/** Hot-path owner: stamped fields, then memory index — never SQLite. */
export function ownerFromEventDataHot(
  data: Record<string, unknown>,
  index: RunOwnerIndex = _default,
): string | null {
  for (const key of ["actorUpn", "upn", "userUpn", "ownerUpn"] as const) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase()
  }
  const runId = typeof data["runId"] === "string" ? data["runId"] : null
  if (runId) {
    const fromIndex = index.lookupRun(runId)
    if (fromIndex) return fromIndex
  }
  const planId = typeof data["planId"] === "string" ? data["planId"] : null
  if (planId) {
    const fromIndex = index.lookupPlan(planId)
    if (fromIndex) return fromIndex
  }
  return null
}

/**
 * Personal visibility: owner must be known and match Viewing as.
 * Unknown owner is never Personal-visible (no fleet leak).
 */
export function eventMatchesViewingAsHot(
  data: Record<string, unknown>,
  viewingAsUpn: string,
  index?: RunOwnerIndex,
): boolean {
  const owner = ownerFromEventDataHot(data, index)
  if (!owner) return false
  return sameUpn(owner, viewingAsUpn)
}

/**
 * Ensure actorUpn is present on outbound event data when resolvable from
 * stamps or the owner index (mutates a shallow copy).
 */
export function enrichEventDataWithOwner(
  data: Record<string, unknown>,
  index: RunOwnerIndex = _default,
): Record<string, unknown> {
  const existing = ownerFromEventDataHot(data, index)
  if (existing) {
    if (data["actorUpn"] === existing) return data
    return { ...data, actorUpn: existing }
  }
  return data
}

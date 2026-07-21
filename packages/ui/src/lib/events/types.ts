/**
 * Pure event projection — EventAtom → outline / flat log.
 * No React. Catalog owns semantics; ViewSpec owns hierarchy / sticky / roles.
 */

import type { EventFamily, EventPayload } from "@mia/shared-types"

export type EventAtomSource = "sse" | "trace"

export type EventAtom = {
  id: string
  seq: number
  t: number
  source: EventAtomSource
  /** TraceEntry.kind or EventType. */
  type: string
  runId?: string
  payload: EventPayload
}

export type OutlineNodeKind = "scope" | "leaf"

/** How a family/type participates in this view's outline. */
export type ViewOutlineRole = "scope" | "leaf" | "omit"

export type OutlineNode = {
  id: string
  kind: OutlineNodeKind
  family: EventFamily | string
  label: string
  /** Secondary title (e.g. humanized step name). */
  title?: string
  summary?: string
  depth: number
  sticky?: boolean
  severity?: "info" | "warn" | "error"
  children?: OutlineNode[]
  /** Atoms that contributed to this node (bodies bind by id). */
  atomIds: string[]
  /** Merge instance key while open (step:name, call:N, …). */
  nestKey?: string
}

export type ViewSpecNestRule = {
  /** Parent family that may own these children. */
  parentFamily: string
  childFamilies: string[]
}

/**
 * View-local projection rules — Trace / Chat / Timeline disagree here.
 * Catalog stays semantic (family, label, severity, summary, instanceKey).
 */
export type ViewSpec = {
  id: string
  includeFamilies?: string[]
  excludeFamilies?: string[]
  excludeTypes?: string[]
  /**
   * Default outline role by family.
   * Missing family → "leaf" (unless omitted via exclude*).
   */
  roleByFamily?: Partial<Record<string, ViewOutlineRole>>
  /** Override role for an exact wire type / TraceEntry.kind. */
  roleByType?: Record<string, ViewOutlineRole>
  /** Families eligible for VS Code pin overlay in this view. */
  stickyFamilies?: string[]
  /** Exact types eligible for pin (in addition to stickyFamilies). */
  stickyTypes?: string[]
  nest: ViewSpecNestRule[]
  /** Types that close an open merge key after applying (step-end, …). */
  terminalTypes?: string[]
  foldDefault: "expanded" | "collapsed" | "latest"
}

export type FlatLogRow = {
  id: string
  type: string
  label: string
  message: string
  severity: "info" | "warn" | "error"
  t: number
  runId?: string
  payload: EventPayload
}

/** Resolve outline role for a type + family under a ViewSpec. */
export function resolveOutlineRole(
  type: string,
  family: string,
  viewSpec: ViewSpec,
): ViewOutlineRole {
  if (viewSpec.excludeTypes?.includes(type)) return "omit"
  if (viewSpec.excludeFamilies?.includes(family)) return "omit"
  if (viewSpec.includeFamilies && viewSpec.includeFamilies.length > 0) {
    if (!viewSpec.includeFamilies.includes(family)) return "omit"
  }
  const byType = viewSpec.roleByType?.[type]
  if (byType) return byType
  const byFamily = viewSpec.roleByFamily?.[family]
  if (byFamily) return byFamily
  return "leaf"
}

export function isStickyInView(
  type: string,
  family: string,
  viewSpec: ViewSpec,
): boolean {
  if (viewSpec.stickyTypes?.includes(type)) return true
  if (viewSpec.stickyFamilies?.includes(family)) return true
  return false
}

/**
 * Pure event projection — EventAtom → outline / flat log.
 * No React. Widgets supply ViewSpec; catalog owns labels.
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
  /** Merge key while open (step:name, call:N, …). */
  nestKey?: string
}

export type ViewSpecNestRule = {
  /** Parent family that may own these children. */
  parentFamily: string
  childFamilies: string[]
}

export type ViewSpec = {
  id: string
  includeFamilies?: string[]
  excludeTypes?: string[]
  nest: ViewSpecNestRule[]
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

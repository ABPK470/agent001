/**
 * Wire types for the operation log API response.
 * Pipeline → Activity → Event is the three-level tree the UI renders.
 */

import type { EventType } from "@mia/agent"
import { OperationKind, OperationStatus } from "../../../../shared/enums/operations.js"

export { OperationKind, OperationStatus }

export interface OperationEvent {
  type: EventType
  timestamp: string
  data: Record<string, unknown>
}

export interface OperationActivity {
  id: string
  name: string
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  summary?: string
  details?: Record<string, unknown>
  error?: string
  events: OperationEvent[]
  /** Nested detail rows (e.g. per-table work under metadataSync). */
  children?: OperationActivity[]
}

export interface OperationPipeline {
  id: string
  kind: OperationKind
  /** Sync plan id when kind is sync-preview or sync-execute (id is kind-scoped). */
  planId?: string
  title: string
  subtitle?: string
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  activityCount: number
  eventCount: number
  error?: string
  activities: OperationActivity[]
}

export interface ListOperationsOpts {
  limit?: number
  before?: string
  search?: string
  kind?: string
  status?: string
}

export interface EventBucket {
  kind: OperationKind
  key: string
  events: OperationEvent[]
  planId?: string
}

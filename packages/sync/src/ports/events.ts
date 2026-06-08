import type { EventType, SyncOperationType } from "../domain/enums.js"

export interface SyncEvent {
  type: EventType
  data: Record<string, unknown>
}

export type SyncEventSink = (event: SyncEvent) => void

export interface SyncTelemetryContext {
  kind: SyncOperationType
  opId: string
  source?: string
  target?: string
}

export interface SqlEventInput {
  label: string
  connection: string
  sql: string
  durationMs: number
  rowCount?: number
  attempts: number
  error?: string
}

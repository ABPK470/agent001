/**
 * Which event_log types should trigger an Operation Log live refresh.
 * Ignores high-frequency noise (traces, chunks, session ticks, etc.).
 */

import { EventNamespace, EventType, getEventNamespace, isEventType } from "@mia/shared-enums"

const OPERATION_LOG_NAMESPACES: ReadonlySet<EventNamespace> = new Set([
  EventNamespace.Run,
  EventNamespace.Agent,
  EventNamespace.Step,
  EventNamespace.Sync,
  EventNamespace.SyncEnv,
  EventNamespace.Bridge,
])

/** High-volume rows that land in event_log but never become operator pipelines. */
export const OPERATIONS_LIST_EXCLUDE_EVENT_TYPES: readonly string[] = [
  EventType.ApiRequest,
  EventType.SessionPresenceTick,
  EventType.EventsConnected,
  EventType.DebugTrace,
]

export function isOperationLogEvent(type: string): boolean {
  if (!isEventType(type)) return false
  return OPERATION_LOG_NAMESPACES.has(getEventNamespace(type))
}

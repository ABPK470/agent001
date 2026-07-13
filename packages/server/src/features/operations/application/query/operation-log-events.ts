/**
 * Which event_log types should trigger an Operation Log live refresh.
 * Ignores high-frequency noise (traces, chunks, session ticks, etc.).
 */

import { EventNamespace, getEventNamespace, isEventType } from "@mia/shared-enums"

const OPERATION_LOG_NAMESPACES: ReadonlySet<EventNamespace> = new Set([
  EventNamespace.Run,
  EventNamespace.Agent,
  EventNamespace.Step,
  EventNamespace.Sync,
  EventNamespace.SyncEnv,
])

export function isOperationLogEvent(type: string): boolean {
  if (!isEventType(type)) return false
  return OPERATION_LOG_NAMESPACES.has(getEventNamespace(type))
}

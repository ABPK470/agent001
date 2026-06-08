/**
 * Façade — `EventType` + `EventNamespace` and the lifecycle classifier
 * helpers live in `@mia/shared-enums`.
 */
export {
  EventType,
  EVENT_TYPES,
  isEventType,
  EventNamespace,
  getEventNamespace,
  isCompletionEvent,
  isFailureEvent,
  isCancellationEvent,
  isSubStepFailureEvent,
  isTerminalRunEvent,
  isStepEvent,
  isSyncEvent
} from "@mia/shared-enums"

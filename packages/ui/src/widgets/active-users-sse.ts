import { EventType } from "@mia/shared-enums"
import { useEffect, useRef } from "react"
import { useStore } from "../state/store"

/** User aggregates / online status — not paginated run history. */
export function isSummaryRefreshEvent(type: string): boolean {
  return type === EventType.RunQueued
    || type === EventType.RunStarted
    || type === EventType.RunCompleted
    || type === EventType.RunFailed
    || type === EventType.RunCancelled
    || type === EventType.SessionPresenceTick
}

/** Run history may have a new row or terminal status — not presence ticks or step noise. */
export function isHistoryRefreshEvent(type: string): boolean {
  return type === EventType.RunQueued
    || type === EventType.RunCompleted
    || type === EventType.RunFailed
    || type === EventType.RunCancelled
}

export function isActiveRunLiveEvent(type: string): boolean {
  return type === EventType.RunQueued
    || type === EventType.RunStarted
    || type === EventType.RunCompleted
    || type === EventType.RunFailed
    || type === EventType.RunCancelled
}

export function isActiveRunStepEvent(type: string): boolean {
  return type === EventType.StepCompleted || type === EventType.StepFailed
}

export type AdminSseEvent = { type: string; data: Record<string, unknown> }

/** Deliver only newly appended SSE events — no polling, no full-log rescans. */
export function useAdminSseEvents(handler: (event: AdminSseEvent) => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const cursorRef = useRef(0)

  useEffect(() => {
    cursorRef.current = useStore.getState().sseEventLog.length
    return useStore.subscribe((state) => {
      const log = state.sseEventLog
      if (log.length <= cursorRef.current) return
      const batch = log.slice(cursorRef.current)
      cursorRef.current = log.length
      for (const event of batch) {
        handlerRef.current({
          type: String(event.type),
          data: (event.data ?? {}) as Record<string, unknown>,
        })
      }
    })
  }, [])
}

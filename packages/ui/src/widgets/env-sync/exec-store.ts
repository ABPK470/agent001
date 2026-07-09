import { syncExecuteStream } from "../../api"
import type { SyncExecuteProgress } from "../../types"
import { appendCancelledTableEvents } from "./exec-status"
import type { ExecState } from "./types"

let execState: ExecState = { kind: "idle" }
let execPlanId: string | null = null
let execStream: { close: () => void } | null = null
let userCancelled = false
const execListeners = new Set<() => void>()

function notifyExec(): void {
  execListeners.forEach((listener) => listener())
}

function touchRunning(events: SyncExecuteProgress[]): ExecState {
  const prev = execState.kind === "running" ? execState : null
  const now = Date.now()
  return {
    kind: "running",
    events,
    startedAt: prev?.startedAt ?? now,
    lastEventAt: now,
  }
}

export function getExecSnapshot(): ExecState {
  return execState
}

export function getExecPlanId(): string | null {
  return execPlanId
}

export function subscribeExec(cb: () => void): () => void {
  execListeners.add(cb)
  return () => { execListeners.delete(cb) }
}

export function startExecStream(planId: string): void {
  execStream?.close()
  userCancelled = false
  const events: SyncExecuteProgress[] = []
  execState = touchRunning(events)
  execPlanId = planId
  notifyExec()

  execStream = syncExecuteStream(
    planId,
    (event) => {
      if (userCancelled) return
      events.push(event)
      if (event.type === "completed" || event.type === "skipped" || event.type === "failed") {
        execState = {
          kind: "done",
          success: event.type === "completed" || event.type === "skipped",
          skipped: event.type === "skipped",
          events: [...events],
          error: event.type === "failed" ? event.error : undefined,
          message: event.type === "skipped" ? (event.message ?? event.error) : undefined,
        }
        execStream?.close()
        execStream = null
      } else {
        execState = touchRunning([...events])
      }
      notifyExec()
    },
    (error) => {
      if (userCancelled) return
      execState = { kind: "done", success: false, events: [...events], error }
      execStream?.close()
      execStream = null
      notifyExec()
    },
  )
}

/** Stop listening and mark the run cancelled. Closes SSE so the server can abort preflight work. */
export function cancelExec(): void {
  if (execState.kind !== "running") return
  userCancelled = true
  const events = appendCancelledTableEvents(execState.events)
  execStream?.close()
  execStream = null
  execState = { kind: "done", success: false, events, error: "Cancelled by user" }
  notifyExec()
}

export function completeExecFromAgent(planId: string, success: boolean, error?: string): void {
  execState = {
    kind: "done",
    success,
    events: [{ type: success ? "completed" : "failed", error } as SyncExecuteProgress],
    error,
  }
  execPlanId = planId
  notifyExec()
}

export function resetExec(): void {
  userCancelled = false
  execStream?.close()
  execStream = null
  execState = { kind: "idle" }
  execPlanId = null
  notifyExec()
}

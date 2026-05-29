import { syncExecuteStream } from "../../api"
import type { SyncExecuteProgress } from "../../types"
import type { ExecState } from "./types"

let execState: ExecState = { kind: "idle" }
let execPlanId: string | null = null
let execStream: { close: () => void } | null = null
const execListeners = new Set<() => void>()

function notifyExec(): void {
  execListeners.forEach((listener) => listener())
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
  const events: SyncExecuteProgress[] = []
  execState = { kind: "running", events }
  execPlanId = planId
  notifyExec()

  execStream = syncExecuteStream(
    planId,
    (event) => {
      events.push(event)
      if (event.type === "completed" || event.type === "failed") {
        execState = { kind: "done", success: event.type === "completed", events: [...events], error: event.error }
        execStream?.close()
        execStream = null
      } else {
        execState = { kind: "running", events: [...events] }
      }
      notifyExec()
    },
    (error) => {
      execState = { kind: "done", success: false, events: [...events], error }
      execStream?.close()
      execStream = null
      notifyExec()
    },
  )
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
  execStream?.close()
  execStream = null
  execState = { kind: "idle" }
  execPlanId = null
  notifyExec()
}
import { syncExecuteStream, api } from "../../client/index"
import type { SyncExecuteProgress } from "../../types"
import { appendCancelledTableEvents } from "./exec-status"
import { execTerminalSuccess, isTerminalExecEvent } from "./exec-progress"
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

export function startExecStream(
  planId: string,
  opts?: {
    onPolicyApprovalRequired?: (meta: {
      approvalId: string
      reason: string
      policyName?: string
    }) => void
  },
): void {
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
      if (isTerminalExecEvent(event)) {
        execState = {
          kind: "done",
          success: execTerminalSuccess(event),
          skipped: event.type === "skipped",
          events: [...events],
          error: event.type === "failed" ? (event.error ?? event.message) : undefined,
          message: event.type === "skipped" ? (event.message ?? event.error) : event.message,
        }
        execStream?.close()
        execStream = null
      } else {
        execState = touchRunning([...events])
      }
      notifyExec()
    },
    (error, meta) => {
      if (userCancelled) return
      if (meta?.code === "approval_required" && meta.approvalId) {
        execState = { kind: "idle" }
        execPlanId = null
        execStream?.close()
        execStream = null
        notifyExec()
        opts?.onPolicyApprovalRequired?.({
          approvalId: meta.approvalId,
          reason: error,
          policyName: meta.policyName,
        })
        return
      }
      execState = { kind: "done", success: false, events: [...events], error }
      execStream?.close()
      execStream = null
      notifyExec()
    },
  )
}

/** Stop the server execute and mark the run cancelled locally. */
export async function cancelExec(): Promise<void> {
  if (execState.kind !== "running" || !execPlanId) return
  userCancelled = true
  const planId = execPlanId
  const events = appendCancelledTableEvents(execState.events)
  try {
    await api.cancelSyncExecute(planId)
  } catch (err: unknown) { console.error("[mia]", err) }
  execStream?.close()
  execStream = null
  execState = { kind: "done", success: false, events, error: "Cancelled by user" }
  notifyExec()
}

export function completeExecFromAgent(planId: string, success: boolean, error?: string): void {
  if (execState.kind === "running" && execPlanId === planId) {
    execState = {
      kind: "done",
      success,
      events: execState.events,
      error: success ? undefined : error,
    }
    execStream?.close()
    execStream = null
    notifyExec()
    return
  }
  if (execState.kind === "done" && execState.events.length > 1) {
    execPlanId = planId
    notifyExec()
    return
  }
  execState = {
    kind: "done",
    success,
    events: [{ type: success ? "completed" : "failed", error, message: error } as SyncExecuteProgress],
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

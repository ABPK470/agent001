/**
 * In-process cancellation registry for long-running server operations.
 *
 * Each operation registers an AbortController at start; callers poll
 * `signal` or use `throwIfCancelled`. HTTP cancel routes call
 * `cancelOperation(kind, id)` which aborts and unregisters.
 */

export interface RegisteredOperation {
  kind: string
  id: string
  label: string
  controller: AbortController
  startedAt: number
}

const active = new Map<string, RegisteredOperation>()

function key(kind: string, id: string): string {
  return `${kind}:${id}`
}

export function registerOperation(kind: string, id: string, label: string): AbortSignal {
  const k = key(kind, id)
  active.get(k)?.controller.abort(new Error("Superseded by a new operation"))
  const controller = new AbortController()
  active.set(k, { kind, id, label, controller, startedAt: Date.now() })
  return controller.signal
}

export function cancelOperation(kind: string, id: string, reason = "Cancelled by user"): boolean {
  const op = active.get(key(kind, id))
  if (!op) return false
  op.controller.abort(new Error(reason))
  active.delete(key(kind, id))
  return true
}

export function unregisterOperation(kind: string, id: string): void {
  active.delete(key(kind, id))
}

export function getOperationSignal(kind: string, id: string): AbortSignal | undefined {
  return active.get(key(kind, id))?.controller.signal
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled")
  }
}

export function listActiveOperations(kind?: string): RegisteredOperation[] {
  const ops = [...active.values()]
  return kind ? ops.filter((o) => o.kind === kind) : ops
}

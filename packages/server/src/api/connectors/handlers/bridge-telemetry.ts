/**
 * Bridge HTTP-route telemetry helpers (throttle + error preview).
 * Spec labels live in @mia/shared-types (`summarizeBridge*Spec`).
 */

/** Cap error rows for event payloads (Pipelines detail). */
export function errorsPreview(
  errors: readonly { row: number; message: string }[],
  cap = 5,
): { row: number; message: string }[] {
  return errors.slice(0, cap).map((e) => ({
    row: e.row,
    message: e.message.length > 200 ? `${e.message.slice(0, 199)}…` : e.message,
  }))
}

/** Throttle mid-move progress emits (wall clock + row stride). */
export function createBridgeProgressThrottle(opts?: {
  minIntervalMs?: number
  minRows?: number
}): (rowsRead: number, emit: () => void) => void {
  const minIntervalMs = opts?.minIntervalMs ?? 750
  const minRows = opts?.minRows ?? 500
  let lastAt = 0
  let lastRows = 0
  return (rowsRead, emit) => {
    const now = Date.now()
    if (now - lastAt < minIntervalMs && rowsRead - lastRows < minRows) return
    lastAt = now
    lastRows = rowsRead
    emit()
  }
}

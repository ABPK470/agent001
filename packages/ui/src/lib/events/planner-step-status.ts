/**
 * Planner step-end status vocabulary.
 *
 * Pipeline emits PipelineStatus ("completed" | "failed" | …). Older traces
 * and some fixtures still use "pass" / "success" / "fail".
 */

const SUCCESS = new Set(["completed", "pass", "success"])
const FAILURE = new Set(["failed", "fail", "error"])

export function isPlannerStepSuccessStatus(status: string | undefined): boolean {
  return status != null && SUCCESS.has(status)
}

export function isPlannerStepFailureStatus(status: string | undefined): boolean {
  return status != null && FAILURE.has(status)
}

/** Settled detail for a finished step row — duration on success, reason otherwise. */
export function plannerStepEndDetail(opts: {
  status: string | undefined
  error?: string
  durationMs?: number
  formatMs: (ms: number) => string
}): string | undefined {
  if (isPlannerStepSuccessStatus(opts.status)) {
    return opts.durationMs != null ? opts.formatMs(opts.durationMs) : undefined
  }
  if (opts.error) return opts.error
  if (opts.status === "skipped") return "skipped"
  return "needs work"
}

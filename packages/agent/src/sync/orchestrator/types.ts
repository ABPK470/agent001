/**
 * Public types for the sync orchestrator submodules.
 *
 * Defined in a leaf module to avoid import cycles between
 * `execute.ts` (consumer) and the helpers it composes.
 *
 * @module
 */

export interface ExecuteProgress {
  type: "started" | "step" | "table-started" | "table-progress" | "table-done" | "completed" | "failed"
  table?: string
  step?: string
  rowsApplied?: number
  rowsTotal?: number
  message?: string
  error?: string
}

export interface ExecuteOptions {
  confirm: boolean
  /** Optional progress callback (used by SSE route). */
  onProgress?: (p: ExecuteProgress) => void
  /** Identity of the user requesting execute (for safety rails / audit). */
  userUpn?: string | null
}

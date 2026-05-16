/**
 * Public types for the sync orchestrator submodules.
 *
 * Defined in a leaf module to avoid import cycles between
 * `execute.ts` (consumer) and the helpers it composes.
 *
 * @module
 */

import { SyncProgressKind } from "../../domain/enums/sync.js"

export interface ExecuteProgress {
  type: SyncProgressKind
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
  /**
   * Bypass the entity-registry freeze-window soft block. Off by default;
   * the UI surfaces an explicit "override freeze window" affordance that
   * passes this through. Audited.
   */
  overrideFreezeWindow?: boolean
}

/**
 * UI re-export of platform run-action capabilities.
 * Prefer importing from `@mia/shared-types` in new code; this module keeps
 * existing widget imports stable.
 */

export {
  canCancelRun,
  canConfirmRollback,
  canResumeRun,
  canRollbackRun,
  isLiveRunStatus,
  isRunCapabilityActionAllowed,
  isTerminalFailureStatus,
  isTerminalRunStatus,
  rollbackAvailableFromPreview,
} from "@mia/shared-types"

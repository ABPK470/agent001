import { isCancelRaceFailureError } from "../../lib/events/trace-terminal"
import { isTerminalFailureStatus } from "../../lib/run-actions"
import { RunStatus } from "../../enums"

/** True when this turn ended by user cancel (or cancel-race failure), not resume-superseded. */
export function isCancelTerminalRun(input: {
  status: string
  error?: string | null
  supersededByResume: boolean
}): boolean {
  if (input.supersededByResume) return false
  if (input.status === RunStatus.WaitingForApproval) return false
  if (input.status === RunStatus.Cancelled) return true
  return Boolean(input.error)
    && isCancelRaceFailureError(input.error)
    && isTerminalFailureStatus(input.status)
}

/** Offer in-place edit + rerun on a cancelled own goal (not via the composer pill). */
export function canOfferEditCancelledGoal(input: {
  isOwnGoal: boolean
  readOnly: boolean
  threadBusy: boolean
  isCancelTerminal: boolean
}): boolean {
  return input.isOwnGoal
    && !input.readOnly
    && !input.threadBusy
    && input.isCancelTerminal
}

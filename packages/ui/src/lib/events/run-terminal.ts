/**
 * Run lifecycle → in-flight span settlement.
 *
 * Chat and Trace both project open tool/work spans. When the run is
 * terminal, those spans are no longer in flight — seal them to the
 * run's outcome. One dialect for both surfaces.
 */

import { RunStatus } from "../../enums"
import { isTerminalRunStatus } from "../run-actions"

/** Settle open spans to this status, or null if the run is still live. */
export function terminalSpanStatus(
  runStatus: string | null | undefined,
): "done" | "error" | null {
  if (!runStatus || !isTerminalRunStatus(runStatus)) return null
  // Cancelled (incl. approval deny) is not a tool failure.
  return runStatus === RunStatus.Completed || runStatus === RunStatus.Cancelled
    ? "done"
    : "error"
}

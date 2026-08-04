/**
 * Trace adapters for shared tool execution formatting.
 */

export type { ToolExecStatus as TraceExecStatus } from "../../lib/tool-execution"
export {
  buildExecSummary,
  execErrorCode,
  execOutputPreview,
  execStatusVerb,
  formatExecInput,
  humanizeToolName,
  resolveExecStatus,
} from "../../lib/tool-execution"

import type { ToolExecStatus } from "../../lib/tool-execution"
import type { TraceToolCall } from "./build-trace-dag"

export function statusFromToolCall(tool: TraceToolCall): ToolExecStatus {
  if (tool.status === "error") return "error"
  if (tool.status === "running") return "running"
  if (tool.status === "proposed") return "proposed"
  if (tool.resultText) return "done"
  return "running"
}

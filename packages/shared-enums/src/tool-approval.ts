/**
 * Operator grant duration when approving a blocked tool step.
 *
 *   instance — this call only (tool + args); consumed after one successful use
 *   run      — this tool for the rest of the resume chain; cleared when the leaf ends
 */

export const ToolApprovalGrantScope = {
  Instance: "instance",
  Run: "run",
} as const

export type ToolApprovalGrantScope =
  (typeof ToolApprovalGrantScope)[keyof typeof ToolApprovalGrantScope]

export const TOOL_APPROVAL_GRANT_SCOPES = Object.values(ToolApprovalGrantScope)

export function isToolApprovalGrantScope(value: unknown): value is ToolApprovalGrantScope {
  return (
    typeof value === "string"
    && (TOOL_APPROVAL_GRANT_SCOPES as readonly string[]).includes(value)
  )
}

/** Wire default — preserves pre-scope approve behavior. */
export function normalizeToolApprovalGrantScope(value: unknown): ToolApprovalGrantScope {
  return isToolApprovalGrantScope(value) ? value : ToolApprovalGrantScope.Instance
}

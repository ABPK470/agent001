/**
 * Tool-call permission checks against the available tool set.
 *
 * @module
 */

export type ToolCallAction = "processed" | "skip" | "end_round" | "abort_round" | "abort_loop"

export interface ToolCallPermissionResult {
  readonly action: ToolCallAction
  readonly errorResult?: string
}

export function checkToolCallPermission(
  toolName: string,
  availableTools: ReadonlySet<string>,
): ToolCallPermissionResult {
  if (!availableTools.has(toolName)) {
    return {
      action: "skip",
      errorResult: JSON.stringify({
        error: `Tool "${toolName}" is not available. Available: ${[...availableTools].join(", ")}`,
      }),
    }
  }
  return { action: "processed" }
}

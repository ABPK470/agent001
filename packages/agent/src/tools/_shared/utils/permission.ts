import { ToolCallAction } from "../../../domain/enums/delegation.js"
/**
 * Tool-call permission checks against the available tool set.
 *
 * @module
 */

export type { ToolCallAction }

export interface ToolCallPermissionResult {
  readonly action: ToolCallAction
  readonly errorResult?: string
}

export function checkToolCallPermission(
  toolName: string,
  availableTools: ReadonlySet<string>
): ToolCallPermissionResult {
  if (!availableTools.has(toolName)) {
    return {
      action: ToolCallAction.Skip,
      errorResult: JSON.stringify({
        error: `Tool "${toolName}" is not available. Available: ${[...availableTools].join(", ")}`
      })
    }
  }
  return { action: ToolCallAction.Processed }
}

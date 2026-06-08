/**
 * Argument parsing & repair for tool calls.
 *
 * @module
 */

import { MAX_TOOL_CALL_ARGUMENT_CHARS } from "../../../domain/agent-constants.js"

/** Max chars of raw preview kept when tool-call args are truncated. */
export const MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS = 4_000

export type ParseToolCallArgsResult =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

/**
 * Parse and validate tool call JSON arguments.
 * Returns structured success/error so caller can feed error back to LLM.
 */
export function parseToolCallArguments(rawArguments: unknown): ParseToolCallArgsResult {
  if (typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)) {
    return { ok: true, args: rawArguments as Record<string, unknown> }
  }
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "Tool arguments must be a JSON object, not a primitive or array." }
      }
      return { ok: true, args: parsed as Record<string, unknown> }
    } catch (parseErr) {
      return {
        ok: false,
        error:
          `Invalid tool arguments: ${(parseErr as Error).message}. ` +
          "Break your work into smaller pieces if output was truncated."
      }
    }
  }
  return { ok: false, error: "Tool arguments must be a JSON object." }
}

/**
 * Truncate oversized tool call arguments for replay in message history.
 */
export function sanitizeToolCallArgumentsForReplay(raw: string): string {
  if (raw.length <= MAX_TOOL_CALL_ARGUMENT_CHARS) return raw
  const preview = raw.slice(0, MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS) + "..."
  return JSON.stringify({
    __truncatedToolCallArgs: true,
    originalChars: raw.length,
    preview
  })
}

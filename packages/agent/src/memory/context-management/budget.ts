import type { Message } from "../../domain/types/agent-types.js"
import { estimateTokensFromMessages } from "../tokens.js"

/** Max token budget for the request body. */
export const MAX_CONTEXT_TOKENS = 64000

/** Token estimate for a message array. */
export function estimateTokens(messages: Message[], model?: string): number {
  return estimateTokensFromMessages(messages, model)
}

/** Extract file path from tool call arguments. */
export function extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "file", "filename"]) {
    if (typeof args[key] === "string") return args[key] as string
  }
  if (toolName === "write_file" && typeof args.path === "string") return args.path as string
  if (toolName === "read_file" && typeof args.path === "string") return args.path as string
  return null
}

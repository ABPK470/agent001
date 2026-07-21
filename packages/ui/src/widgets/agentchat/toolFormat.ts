/**
 * AgentChat expanded step I/O formatting — copilot-cli style args + output.
 */

import { toolCallDetailPreview } from "@mia/shared-types"

export function formatToolArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ""
  return entries
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=null`
      if (typeof v === "string") return `${k}=${JSON.stringify(v)}`
      if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`
      try {
        return `${k}=${JSON.stringify(v)}`
      } catch {
        return `${k}=[unserialisable]`
      }
    })
    .join(" ")
}

export function formatToolOutput(
  output: Record<string, unknown>,
  error: string | null,
): string {
  if (error) return error
  if (!output || Object.keys(output).length === 0) return ""
  const result = output["result"]
  if (typeof result === "string") return result
  if (typeof result === "number" || typeof result === "boolean") return String(result)
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(result ?? "")
  }
}

export function getToolDetail(
  tool: string,
  input: Record<string, unknown>,
): string | null {
  return toolCallDetailPreview(tool, input)
}

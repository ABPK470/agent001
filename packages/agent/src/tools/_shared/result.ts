/**
 * Tool result parsing and failure detection utilities.
 *
 * Shared between recovery hints (recovery.ts) and tool execution (tool-utils.ts).
 * Provides consistent failure detection across the agent's tool loop.
 *
 * @module
 */

import type { ToolResultEnvelope } from "../../domain/types/agent-types.js"

// ============================================================================
// Types
// ============================================================================

/** Record of a single tool call with its result — used for recovery analysis. */
export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  result: string
  isError: boolean
  outcome?: ToolResultEnvelope
}

// ============================================================================
// Failure detection
// ============================================================================

/** Check if a tool call result represents a failure. */
export function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true
  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return isLikelyFailureText(result)
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true
    if (typeof obj.error === "object" && obj.error !== null && !Array.isArray(obj.error)) {
      const nested = obj.error as Record<string, unknown>
      if (typeof nested.message === "string" && nested.message.trim().length > 0) return true
      if (typeof nested.code === "string" && nested.code.trim().length > 0) return true
    }
    if (obj.timedOut === true) return true
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true
    if (typeof obj.stderr === "string" && /(?:error|fatal|failed)/i.test(obj.stderr)) return true
  } catch {
    return isLikelyFailureText(result)
  }
  return false
}

function isLikelyFailureText(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.startsWith("error") ||
    lower.includes("error executing tool") ||
    lower.includes("tool not found:") ||
    lower.includes("command not found") ||
    lower.includes("no such file") ||
    lower.includes("write rejected") ||
    lower.includes("written with errors") ||
    lower.includes("written with issues") ||
    lower.includes("issues detected")
  )
}

// ============================================================================
// Result parsing
// ============================================================================

/** Parse JSON tool result, return null if not a valid JSON object. */
export function parseToolResultObject(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract the most useful failure text from a tool result. */
export function extractToolFailureText(record: ToolCallRecord): string {
  const parsed = parseToolResultObject(record.result)
  if (!parsed) return record.result

  const pieces: string[] = []
  const append = (v: unknown): void => {
    if (typeof v !== "string") return
    const trimmed = v.trim()
    if (trimmed.length === 0 || pieces.includes(trimmed)) return
    pieces.push(trimmed)
  }

  if (typeof parsed.error === "string") append(parsed.error)
  if (typeof parsed.error === "object" && parsed.error !== null && !Array.isArray(parsed.error)) {
    const e = parsed.error as Record<string, unknown>
    append(e.message)
    append(e.code)
  }
  if (typeof parsed.stderr === "string") append(parsed.stderr)
  if (typeof parsed.stdout === "string" && (parsed.timedOut === true || pieces.length > 0)) {
    append(parsed.stdout)
  }
  if (parsed.timedOut === true) pieces.unshift("Tool timed out before completing.")

  return pieces.length > 0 ? pieces.join("\n") : record.result
}

// ============================================================================
// Semantic key for dedup
// ============================================================================

/**
 * Build a semantic key for tool call dedup.
 * Used for detecting semantically equivalent repeated calls.
 */
export function buildSemanticToolCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${normalizeSemanticValue(args)}`
}

function normalizeSemanticValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(normalizeSemanticValue).join(",")}]`
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${k}:${normalizeSemanticValue(obj[k])}`).join(",")}}`
  }
  return String(value)
}

// ============================================================================
// Tool result envelope handling
// ============================================================================

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as ToolResultEnvelope).ok === "boolean" &&
    typeof (value as ToolResultEnvelope).summary === "string"
  )
}

function formatToolResultEnvelope(outcome: ToolResultEnvelope): string {
  const details = outcome.details?.filter(Boolean) ?? []
  if (details.length === 0) return outcome.summary
  return `${outcome.summary}\n${details.map((detail) => `  - ${detail}`).join("\n")}`
}

/**
 * Normalize a tool execution return value (string or ToolResultEnvelope)
 * into a consistent { result, outcome } shape.
 */
export function normalizeToolExecutionOutput(value: string | ToolResultEnvelope): {
  result: string
  outcome?: ToolResultEnvelope
} {
  if (typeof value === "string") return { result: value }
  if (isToolResultEnvelope(value)) {
    return { result: formatToolResultEnvelope(value), outcome: value }
  }
  return { result: JSON.stringify({ error: "Tool returned unsupported payload type" }) }
}

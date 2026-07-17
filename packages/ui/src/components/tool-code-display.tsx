/**
 * Tool trace code display — pipe-table parsing, tool arg extraction, step I/O.
 * Separated from CodeBlock.tsx so CodeBlock stays a lightweight import.
 */

import {
  presentToolCallFromFormatted,
  stripRuntimeToolArgs,
  type ToolCallArtifact,
} from "@mia/shared-types"
import { C } from "../theme/tokens"
import { CodeBlock } from "./CodeBlock"
import { DataTable } from "./DataTable"
import { JsonViewer } from "./JsonViewer"

export { stripRuntimeToolArgs as sanitizeToolArgs }

export function parseToolArgsFormatted(argsFormatted: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsFormatted) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return stripRuntimeToolArgs(parsed as Record<string, unknown>)
  } catch {
    return null
  }
}

export function formatToolInputDisplay(toolName: string, argsFormatted: string): string {
  return presentToolCallFromFormatted(toolName, argsFormatted).display
}

export function extractToolCode(
  toolName: string,
  args: Record<string, unknown> | string,
): ToolCallArtifact | null {
  if (typeof args === "string") {
    return presentToolCallFromFormatted(toolName, args).artifact
  }
  return presentToolCallFromFormatted(toolName, JSON.stringify(args)).artifact
}

export interface ParsedTable {
  rowCount: number | null
  headers: string[]
  rows: string[][]
  truncated: boolean
}

export function parsePipeTable(text: string): ParsedTable | null {
  const normalised = text.replace(/\\n/g, "\n")
  const lines = normalised.split("\n").map((l) => l.trimEnd())
  if (lines.length < 2) return null

  let idx = 0
  let rowCount: number | null = null

  const countMatch = lines[0]?.match(/^\((\d+) rows?\)$/)
  if (countMatch) {
    rowCount = parseInt(countMatch[1], 10)
    idx = 1
  }

  const headerLine = lines[idx]
  if (!headerLine || !headerLine.includes(" | ")) return null
  const splitRow = (line: string): string[] =>
    line
      .split(/(?<!\\) \| /)
      .map((c) => c.trim().replace(/\\\|/g, "|"))
  const headers = splitRow(headerLine)
  idx++

  if (lines[idx] && /^[-+\s]+$/.test(lines[idx])) idx++

  let truncated = false
  const rows: string[][] = []
  while (idx < lines.length) {
    const line = lines[idx++]
    if (!line.trim()) continue
    if (line.startsWith("... (") || line.includes("(output truncated)") || line.startsWith("--- Result set")) {
      truncated = true
      continue
    }
    const cells = splitRow(line)
    if (cells.length !== headers.length) continue
    rows.push(cells)
  }

  if (rows.length === 0 && rowCount !== 0) return null

  return { rowCount, headers, rows, truncated }
}

export function ToolResultTable({
  text,
  maxHeight = 300,
}: {
  text: string
  maxHeight?: number
}) {
  const parsed = parsePipeTable(text)

  if (!parsed) {
    const display = text.replace(/\\n/g, "\n")
    return (
      <pre
        className="code-pre px-3 py-2.5 overflow-auto rounded-lg"
        style={{
          background: C.base,
          maxHeight,
          border: `1px solid ${C.border}`,
        }}
      >
        {display}
      </pre>
    )
  }

  const { rowCount, headers, rows, truncated } = parsed
  return (
    <DataTable
      headers={headers}
      rows={rows}
      totalRowsHint={rowCount}
      truncated={truncated}
      maxHeight={maxHeight}
    />
  )
}

export function ToolStepInput({
  toolName,
  input,
  maxHeight = 220,
}: {
  toolName: string
  input: Record<string, unknown>
  maxHeight?: number
}) {
  const extracted = extractToolCode(toolName, input)
  if (extracted) {
    const otherArgs = Object.fromEntries(
      Object.entries(input).filter(([k]) => k !== extracted.field),
    )
    return (
      <div className="space-y-1.5">
        {Object.keys(otherArgs).length > 0 && (
          <JsonViewer value={otherArgs} label="args" defaultExpandDepth={2} maxHeight={160} />
        )}
        <CodeBlock code={extracted.code} lang={extracted.lang} maxHeight={maxHeight} />
      </div>
    )
  }
  return (
    <JsonViewer value={input} label="input" defaultExpandDepth={2} maxHeight={maxHeight} />
  )
}

export function ToolStepOutput({
  output,
  maxHeight = 300,
}: {
  output: Record<string, unknown>
  maxHeight?: number
}) {
  const resultStr = typeof output.result === "string" ? output.result : null
  const durationMs = typeof output.durationMs === "number" ? output.durationMs : null
  const attempts = typeof output.attempts === "number" ? output.attempts : null

  const META_FIELDS = new Set(["result", "durationMs", "attempts"])
  const otherFields = Object.entries(output).filter(([k]) => !META_FIELDS.has(k))

  return (
    <div className="space-y-1.5">
      {(durationMs !== null || attempts !== null) && (
        <div className="flex items-center gap-2 flex-wrap">
          {durationMs !== null && (
            <span
              className="text-xs font-mono px-1.5 py-0.5 rounded"
              style={{ background: C.elevated, color: C.dim }}
            >
              {durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`}
            </span>
          )}
          {attempts !== null && attempts > 1 && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: `${C.warning}19`, color: C.warning }}
            >
              {attempts} attempts
            </span>
          )}
        </div>
      )}

      {resultStr !== null ? (
        <ToolResultTable text={resultStr} maxHeight={maxHeight} />
      ) : otherFields.length > 0 ? (
        <JsonViewer
          value={Object.fromEntries(otherFields)}
          label="output"
          defaultExpandDepth={2}
          maxHeight={maxHeight}
        />
      ) : null}
    </div>
  )
}

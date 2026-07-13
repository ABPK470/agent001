/**
 * CodeBlock — formatted code display with language badge, copy button,
 * and basic SQL keyword highlighting.
 *
 * Also exports `extractToolCode` — extracts the primary code artifact from tool
 * call arguments so callers can display SQL queries, shell commands, and file
 * contents in a readable block rather than raw escaped JSON.
 */

import {
  presentToolCallFromFormatted,
  stripRuntimeToolArgs,
  type ToolCallArtifact,
} from "@mia/shared-types"
import { Check, Copy } from "lucide-react"
import { useState, type ReactNode } from "react"
import { C } from "../widgets/ioe/constants"
import { DataTable } from "./DataTable"
import { JsonViewer } from "./JsonViewer"
import { tokenizeSql, type SqlToken } from "./sql-highlight"

function SqlHighlight({ code }: { code: string }) {
  const toks = tokenizeSql(code)
  const els: ReactNode[] = toks.map((tok: SqlToken, i: number) => {
    if (tok.k === "kw") return <span key={i} style={{ color: C.accent }}>{tok.t}</span>
    if (tok.k === "str") return <span key={i} style={{ color: C.success }}>{tok.t}</span>
    if (tok.k === "cmt") return <span key={i} style={{ color: C.dim, fontStyle: "italic" }}>{tok.t}</span>
    if (tok.k === "num") return <span key={i} style={{ color: C.peach }}>{tok.t}</span>
    if (tok.k === "ident") return <span key={i} style={{ color: C.textSecondary }}>{tok.t}</span>
    return <span key={i} style={{ color: C.textSecondary }}>{tok.t}</span>
  })
  return <>{els}</>
}

// ── Language label map ───────────────────────────────────────────

const LANG_LABEL: Record<string, string> = {
  sql:        "SQL",
  sh:         "Shell",
  bash:       "Shell",
  zsh:        "Shell",
  js:         "JavaScript",
  jsx:        "JSX",
  ts:         "TypeScript",
  tsx:        "TSX",
  python:     "Python",
  json:       "JSON",
  html:       "HTML",
  css:        "CSS",
  scss:       "SCSS",
  md:         "Markdown",
  markdown:   "Markdown",
  text:       "",
  auto:       "",
  "":         "",
}

// ── CodeBlock component ──────────────────────────────────────────

export function CodeBlock({
  code,
  lang = "text",
  maxHeight = 256,
}: {
  code: string
  lang?: string
  maxHeight?: number
}) {
  const [copied, setCopied] = useState(false)
  const label = LANG_LABEL[lang] ?? lang.toUpperCase()

  function copy() {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-1"
        style={{ borderBottom: `1px solid ${C.border}` }}
      >
        <span
          className="text-xs font-mono uppercase tracking-widest"
          style={{ color: C.dim }}
        >
          {label || "code"}
        </span>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs cursor-pointer transition-colors hover:bg-overlay-2"
          style={{ color: copied ? C.success : C.dim }}
          onClick={copy}
          title="Copy to clipboard"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Code body */}
      <pre
        className="code-pre px-3 py-2.5 overflow-auto"
        style={{ maxHeight }}
      >
        {lang === "sql" ? <SqlHighlight code={code} /> : code}
      </pre>
    </div>
  )
}

// ── Tool arg extraction (delegates to @mia/shared-types) ─────────

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

/** Human-readable tool input for the trace expand panel. */
export function formatToolInputDisplay(toolName: string, argsFormatted: string): string {
  return presentToolCallFromFormatted(toolName, argsFormatted).display
}

/**
 * Extract the primary code artifact from tool call arguments.
 * Accepts either a parsed args object or persisted argsFormatted JSON.
 */
export function extractToolCode(
  toolName: string,
  args: Record<string, unknown> | string,
): ToolCallArtifact | null {
  if (typeof args === "string") {
    return presentToolCallFromFormatted(toolName, args).artifact
  }
  return presentToolCallFromFormatted(toolName, JSON.stringify(args)).artifact
}

// ── Pipe-delimited table parser ──────────────────────────────────

/**
 * Parse the pipe-delimited table format produced by `formatResults` in
 * packages/agent/src/tools/mssql/formatter.ts.
 *
 * Expected format (newlines are real \n characters):
 *   (N rows)
 *   col1 | col2 | col3
 *   ---+-+---
 *   val1 | val2 | val3
 *   ...
 */
export interface ParsedTable {
  rowCount: number | null
  headers: string[]
  rows: string[][]
  truncated: boolean
}

export function parsePipeTable(text: string): ParsedTable | null {
  // Normalise: real \n, or literal \n escape sequences
  const normalised = text.replace(/\\n/g, "\n")
  const lines = normalised.split("\n").map(l => l.trimEnd())
  if (lines.length < 2) return null

  let idx = 0
  let rowCount: number | null = null

  // Optional (N rows) first line
  const countMatch = lines[0]?.match(/^\((\d+) rows?\)$/)
  if (countMatch) {
    rowCount = parseInt(countMatch[1], 10)
    idx = 1
  }

  // Header line must contain " | "
  const headerLine = lines[idx]
  if (!headerLine || !headerLine.includes(" | ")) return null
  // Split on unescaped " | " only; cells may contain "\|" (escaped by formatter).
  const splitRow = (line: string): string[] =>
    line
      .split(/(?<!\\) \| /)
      .map((c) => c.trim().replace(/\\\|/g, "|"))
  const headers = splitRow(headerLine)
  idx++

  // Optional separator line (only dashes, plus signs, spaces)
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
    // Drop rows whose cell count doesn't match the header — better to render raw than to corrupt.
    if (cells.length !== headers.length) continue
    rows.push(cells)
  }

  if (rows.length === 0 && rowCount !== 0) return null

  return { rowCount, headers, rows, truncated }
}

// ── ToolResultTable — renders pipe-table via DataTable, or plain pre ────

export function ToolResultTable({
  text,
  maxHeight = 300,
}: {
  text: string
  maxHeight?: number
}) {
  const parsed = parsePipeTable(text)

  if (!parsed) {
    // Not a table — show as plain pre with proper newline handling
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

// ── ToolStepInput — smart step input display ─────────────────────

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
      Object.entries(input).filter(([k]) => k !== extracted.field)
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

// ── ToolStepOutput — smart step output display ───────────────────

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

  // Non-result, non-meta fields to show as JSON
  const META_FIELDS = new Set(["result", "durationMs", "attempts"])
  const otherFields = Object.entries(output).filter(([k]) => !META_FIELDS.has(k))

  return (
    <div className="space-y-1.5">
      {/* Metadata row */}
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

      {/* Main result */}
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

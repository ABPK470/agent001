/**
 * SmartAnswer — intelligent answer renderer.
 *
 * Parses agent response text and renders it with appropriate formatting:
 *   - Markdown tables  → scrollable data table with numeric column detection
 *   - Code blocks      → monospace block with language label
 *   - Headings         → h1/h2/h3 hierarchy
 *   - Bullet lists     → accent dot list
 *   - Ordered lists    → numbered list
 *   - Inline bold/italic/code → rendered inline
 *   - Plain paragraphs → whitespace-preserved text
 */

import { Check, Copy } from "lucide-react"
import React from "react"
import { DataTable } from "./DataTable"
import { InlineDiagram, isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"

// Context that flips inline rendering (e.g. inline `code` chips) to a
// lighter, less-decorated style. Used by the term-chat widget.
const CompactContext = React.createContext(false)

// ── Block types ────────────────────────────────────────────────

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "bullet-list"; items: string[] }
  | { type: "ordered-list"; items: { num: number; text: string }[] }
  | { type: "command"; command: string; before: string; after: string }
  | { type: "hr" }

// ── Structured ordered-list → table heuristic ─────────────────
// Detects "**Name**: detail, detail, detail" items and builds a multi-column
// DataTable.  Each comma-segment becomes its own column with an auto-derived
// header (e.g. "Revenue of 5,593,737.53 ZAR" → header "Revenue (ZAR)",
// cell "5,593,737.53"; "region Gauteng" → header "Region", cell "Gauteng").

function tryConvertOrderedListToTable(
  items: { num: number; text: string }[]
): { headers: string[]; rows: string[][] } | null {
  if (items.length < 2) return null
  const RE = /^\*{0,2}([^:*]+?)\*{0,2}:\s+(.+)$/
  const parsed = items.map((item) => item.text.match(RE))
  if (!parsed.every(Boolean)) return null

  const names = parsed.map((m) => m![1].trim())
  const details = parsed.map((m) => m![2].trim())

  // Split each detail into segments by ", " followed by a letter
  // (commas inside numbers like "1,234" are followed by a digit, so they survive)
  const segmented = details.map((d) => d.split(/,\s+(?=[A-Za-z])/))
  const segCount = segmented[0].length
  const uniform = segmented.every((s) => s.length === segCount)

  if (uniform && segCount > 1) {
    const cols: { header: string; values: string[] }[] = []
    for (let c = 0; c < segCount; c++) {
      const segs = segmented.map((s) => s[c].replace(/\*{2}/g, ""))
      cols.push(extractColumn(segs))
    }
    return {
      headers: ["#", "Name", ...cols.map((c) => c.header)],
      rows: items.map((_, i) => [
        String(items[i].num ?? i + 1),
        names[i],
        ...cols.map((c) => c.values[i]),
      ]),
    }
  }

  // Single segment per row — still try to extract a clean header
  const cleaned = details.map((d) => d.replace(/\*{2}/g, ""))
  const col = extractColumn(cleaned)
  return {
    headers: ["#", "Name", col.header],
    rows: items.map((_, i) => [
      String(items[i].num ?? i + 1),
      names[i],
      col.values[i],
    ]),
  }
}

/**
 * Given an array of same-position segment strings (one per row),
 * derive a column header and per-row cell values.
 */
function extractColumn(segs: string[]): { header: string; values: string[] } {
  // P1: "Label of <number> [UNIT]" — e.g. "Revenue of 225,332,051.63 ZAR"
  const reOf = /^(.+?)\s+of\s+([\d,]+(?:\.\d+)?)\s*([A-Z]{2,5})?\s*$/
  const mOf = segs.map((s) => s.match(reOf))
  if (mOf.every(Boolean)) {
    const label = mOf[0]![1]
    if (mOf.every((m) => m![1] === label)) {
      const unit = mOf[0]![3]
      return {
        header: unit ? `${label} (${unit})` : label,
        values: mOf.map((m) => m![2]),
      }
    }
  }

  // P2: longest common word-prefix where remaining parts differ
  const wordArrays = segs.map((s) => s.split(/\s+/))
  let prefixLen = 0
  for (let w = 0; w < wordArrays[0].length; w++) {
    if (!wordArrays.every((wa) => w < wa.length && wa[w] === wordArrays[0][w])) break
    prefixLen = w + 1
  }

  // If every segment is identical the prefix eats everything — back off to the
  // first uppercase word (likely the data boundary, e.g. "located in | South Africa")
  if (prefixLen === wordArrays[0].length && segs.every((s) => s === segs[0])) {
    for (let w = 0; w < wordArrays[0].length; w++) {
      if (/^[A-Z]/.test(wordArrays[0][w]) && w > 0) {
        prefixLen = w
        break
      }
    }
  }

  if (prefixLen > 0) {
    const prefix = wordArrays[0].slice(0, prefixLen).join(" ")
    const values = segs.map((_, i) => wordArrays[i].slice(prefixLen).join(" "))
    let header = prefix.replace(/\s+(of|in|at|from|by|for|with|is|as|the)$/i, "").trim()
    if (!header) header = prefix
    if (/^located$/i.test(header)) header = "Location"
    else if (/^based$/i.test(header)) header = "Location"
    else header = header.replace(/\b\w/g, (c) => c.toUpperCase())
    return { header, values }
  }

  // Fallback
  return { header: "Details", values: segs }
}

function parseCommandLikeItem(text: string): { name: string; detail: string } | null {
  const trimmed = text.trim().replace(/^`|`$/g, "")
  const match = trimmed.match(/^([a-z][a-z0-9_.-]{2,})(?:\s+(.+))?$/)
  if (!match || !match[2]) return null
  const detail = match[2].trim()
  const looksStructured = /=|\bargs?\b|\btable\s*=|\bcolumn\s*=|\bbetween\s*=|\bquery\s*=|\[[^\]]+\]|"[^"]+"/.test(detail)
  return looksStructured ? { name: match[1], detail } : null
}

function cleanupCommandBoundaryText(text: string, side: "before" | "after"): string {
  let cleaned = text.trim()
  if (!cleaned) return ""

  if (side === "before") {
    cleaned = cleaned.replace(/\s*(\*\*|__|`)+\s*$/g, "")
  } else {
    cleaned = cleaned.replace(/^\s*(\*\*|__|`)+\s*/g, "")
  }

  return cleaned.trim()
}

// ── Parser ─────────────────────────────────────────────────────

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n")
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Skip blank lines between blocks
    if (line.trim() === "") { i++; continue }

    // Horizontal rule — `---`, `***`, `___` (markdown thematic break)
    if (/^\s*(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[*\s]*|_\s*_\s*_[_\s]*)$/.test(line)) {
      blocks.push({ type: "hr" })
      i++
      continue
    }

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      blocks.push({ type: "code", lang, text: codeLines.join("\n") })
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2] })
      i++
      continue
    }

    // Table — lines that start with |
    if (line.trimStart().startsWith("|") && line.includes("|", 1)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i])
        i++
      }
      const isSeparator = (row: string) => /^\|[\s\-|:]+\|$/.test(row.trim())
      const parseRow = (row: string) =>
        row.split("|").slice(1, -1).map((c) => c.trim())
      const dataLines = tableLines.filter((l) => !isSeparator(l))
      if (dataLines.length >= 2) {
        blocks.push({ type: "table", headers: parseRow(dataLines[0]), rows: dataLines.slice(1).map(parseRow) })
      } else if (dataLines.length === 1) {
        blocks.push({ type: "paragraph", lines: [dataLines[0]] })
      }
      continue
    }

    // Bullet list
    if (/^[-*•]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*•]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*•]\s+/, ""))
        i++
      }
      blocks.push({ type: "bullet-list", items })
      continue
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(line)) {
      const items: { num: number; text: string }[] = []
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        const m = lines[i].match(/^(\d+)[.)]\s+(.*)$/)
        items.push({ num: m ? Number(m[1]) : items.length + 1, text: m ? m[2] : lines[i] })
        i++
      }
      blocks.push({ type: "ordered-list", items })
      continue
    }

    // Paragraph — accumulate until blank line or structural element
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^#{1,3}\s/) &&
      !(lines[i].trimStart().startsWith("|") && lines[i].includes("|", 1)) &&
      !/^[-*•]\s/.test(lines[i]) &&
      !/^\d+[.)]\s/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      // Check if any paragraph line contains a command-like inline code: `tool_name key=val ...`
      const joined = paraLines.join("\n")
      const cmdMatch = joined.match(/`(\w+\s+\w+=\S[^`]*)`/)
      if (cmdMatch) {
        const idx = cmdMatch.index!
        const before = cleanupCommandBoundaryText(joined.slice(0, idx), "before")
        const after = cleanupCommandBoundaryText(joined.slice(idx + cmdMatch[0].length), "after")
        blocks.push({ type: "command", command: cmdMatch[1], before, after })
      } else {
        const commandLineIndex = paraLines.findIndex((line) => parseCommandLikeItem(line) !== null)
        if (commandLineIndex >= 0) {
          const before = cleanupCommandBoundaryText(paraLines.slice(0, commandLineIndex).join("\n"), "before")
          const command = paraLines[commandLineIndex].trim().replace(/^`|`$/g, "")
          const after = cleanupCommandBoundaryText(paraLines.slice(commandLineIndex + 1).join("\n"), "after")
          blocks.push({ type: "command", command, before, after })
        } else {
          blocks.push({ type: "paragraph", lines: paraLines })
        }
      }
    }
  }

  return blocks
}

// ── Copyable command block ──────────────────────────────────────

function CommandBlock({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  // Split "tool_name key=val key=val" into name + key=value pairs
  const spaceIdx = text.indexOf(" ")
  const name = spaceIdx > 0 ? text.slice(0, spaceIdx) : text
  const rawParams = spaceIdx > 0 ? text.slice(spaceIdx + 1) : ""
  // Parse key=value pairs
  const params = rawParams
    ? rawParams.split(/\s+/).map((p, i) => {
        const eqIdx = p.indexOf("=")
        if (eqIdx > 0) {
          return (
            <span key={i} className="ml-2">
              <span className="text-text-muted">{p.slice(0, eqIdx)}</span>
              <span className="text-text-muted">=</span>
              <span className="text-accent">{p.slice(eqIdx + 1)}</span>
            </span>
          )
        }
        return <span key={i} className="ml-2 text-text-secondary">{p}</span>
      })
    : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCopy}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleCopy() }}
      className="my-2 rounded-lg overflow-hidden border border-border-subtle cursor-pointer hover:border-accent/30 transition-all group"
      title="Click to copy command"
    >
      <div className="px-3 py-2 font-mono text-base flex items-center gap-2">
        <span className="text-text-muted text-base">❯</span>
        <span className="flex-1 min-w-0 truncate">
          <span className="font-semibold text-text">{name}</span>
          {params}
        </span>
        <span className="text-text-muted text-base opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {copied ? "✓ Copied" : "Copy"}
        </span>
      </div>
    </div>
  )
}

// ── Inline text renderer ────────────────────────────────────────

function InlineText({ text }: { text: string }): React.ReactElement {
  const compact = React.useContext(CompactContext)
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/)
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/)
    const codeMatch = remaining.match(/`([^`]+)`/)

    type M = { idx: number; len: number; node: React.ReactNode }
    const candidates: M[] = []
    if (boldMatch)   candidates.push({ idx: boldMatch.index!,   len: boldMatch[0].length,   node: <strong key={key++} className="font-semibold text-text">{boldMatch[1]}</strong> })
    if (italicMatch) candidates.push({ idx: italicMatch.index!, len: italicMatch[0].length, node: <em key={key++} className="italic">{italicMatch[1]}</em> })
    if (codeMatch)   candidates.push({ idx: codeMatch.index!,   len: codeMatch[0].length,   node: <code key={key++} className={compact ? "font-mono text-[12px] text-text-muted bg-overlay-2 px-1.5 py-0.5 rounded" : "font-mono text-sm bg-accent-soft text-accent px-1.5 py-0.5 rounded border border-accent/25"}>{codeMatch[1]}</code> })

    if (candidates.length === 0) { parts.push(remaining); break }

    const first = candidates.reduce((a, b) => (a.idx <= b.idx ? a : b))
    if (first.idx > 0) parts.push(remaining.slice(0, first.idx))
    parts.push(first.node)
    remaining = remaining.slice(first.idx + first.len)
  }

  return <>{parts}</>
}

// ── Component ──────────────────────────────────────────────────

// Lightweight compact table — used in TermChat. A simple thin border
// frames the whole table (header + body) so it reads as a distinct
// element against the chat background. Header gets a subtle bottom
// rule and a slightly tinted background; rows have a faint hover tint.
// Intentionally minimal — no per-cell borders, no chrome bar, no
// sort/filter UI (that's the heavier DataTable elsewhere).
function CompactTable({
  headers,
  rows,
}: {
  headers: string[]
  rows: string[][]
}) {
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-md ring-1 ring-border-subtle my-1.5">
      <table className="w-full text-[12.5px] leading-6 border-collapse">
        {/* <thead className="bg-overlay-hover/40"> */}
        <thead>
          <tr>
            {headers.map((h, hi) => (
              <th
                key={hi}
                className={[
                  "text-left font-bold text-text-secondary text-[14px] px-3 py-1.5 border-b border-border-subtle whitespace-nowrap",
                  // "text-left font-bold text-text-muted tracking-wide text-[11px] px-3 py-1.5 border-b border-border-subtle whitespace-nowrap",
                  hi < headers.length - 1 ? "border-r border-border-subtle" : "",
                ].join(" ")}
              >
                <InlineText text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={[
                    "px-3 py-1.5 align-top text-text-secondary",
                    ci < row.length - 1 ? "border-r border-border-subtle" : "",
                  ].join(" ")}
                >
                  <InlineText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Lightweight code block — soft tinted panel, no heavy borders or header
// bar unless lang is meaningful. Reads as a distinct snippet against the
// chat background while staying visually quiet. Hovering reveals a copy
// button in the top-right corner.
function CompactCodeBlock({ lang, text }: { lang: string; text: string }) {
  const showLang = Boolean(lang) && lang.toLowerCase() !== "text"
  // `copied` drives visibility (the button stays pinned visible during the
  // success window). `showCheck` lags slightly so the Check icon remains
  // displayed throughout the fade-out — without this, releasing hover at the
  // moment the timer fires causes a one-frame flash of the Copy icon as it
  // fades out.
  const [copied, setCopied] = React.useState(false)
  const [showCheck, setShowCheck] = React.useState(false)
  const timersRef = React.useRef<number[]>([])
  React.useEffect(() => () => {
    timersRef.current.forEach((id) => window.clearTimeout(id))
  }, [])
  const handleCopy = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(text).then(() => {
      timersRef.current.forEach((id) => window.clearTimeout(id))
      timersRef.current = []
      setCopied(true)
      setShowCheck(true)
      // Keep the Check pinned + visible for the success window.
      timersRef.current.push(window.setTimeout(() => setCopied(false), 1400))
      // Hold the Check icon a little longer than the opacity transition so
      // the icon never swaps mid-fade.
      timersRef.current.push(window.setTimeout(() => setShowCheck(false), 1400 + 250))
    }).catch(() => { /* ignore */ })
  }, [text])
  return (
    <div className="group relative rounded-md ring-1 ring-border-subtle my-1.5 overflow-hidden">
      {showLang && (
        <div className="px-3 pt-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-text-muted">
          {lang}
        </div>
      )}
      <pre className="px-3 py-2 text-[13px] leading-relaxed font-mono text-text-muted overflow-x-auto whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
        className={[
          "absolute top-1.5 right-1.5 inline-flex items-center justify-center w-7 h-7 rounded-md",
          "text-text-muted hover:text-text hover:bg-overlay-3",
          "transition-opacity duration-150",
          copied ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        ].join(" ")}
      >
        {showCheck
          ? <Check size={14} className="text-success" />
          : <Copy size={14} />}
      </button>
    </div>
  )
}

export function SmartAnswer({
  text,
  streaming = false,
  compact = false,
}: {
  text: string
  streaming?: boolean
  compact?: boolean
}) {
  const blocks = parseBlocks(text)

  return (
    <CompactContext.Provider value={compact}>
    <div className={[
      compact ? "text-text-secondary text-[13px] leading-6 w-full min-w-0" : "text-text-secondary text-base leading-relaxed w-full min-w-0",
      streaming ? "space-y-2" : "space-y-3",
    ].join(" ")}>
      {blocks.map((block, bi) => {

        if (block.type === "heading") {
          if (block.level === 1) {
            return (
              <div key={bi} className="flex items-center gap-3 pt-1 pb-0.5">
                <span className="h-px flex-1 bg-gradient-to-r from-overlay-3 to-transparent" />
                <p className="text-[13px] font-semibold tracking-[0.12em] uppercase text-text">
                  <InlineText text={block.text} />
                </p>
                <span className="h-px flex-1 bg-gradient-to-l from-overlay-3 to-transparent" />
              </div>
            )
          }
          if (block.level === 2) {
            return (
              <div key={bi} className="flex items-center gap-2 pt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-accent/75 shrink-0" />
                <p className="font-semibold text-text border-b border-border-subtle pb-1 flex-1">
                  <InlineText text={block.text} />
                </p>
              </div>
            )
          }
          return <p key={bi} className="font-medium text-text-secondary"><InlineText text={block.text} /></p>
        }

        if (block.type === "paragraph") {
          return (
            <p key={bi} className="whitespace-pre-wrap">
              <InlineText text={block.lines.join("\n")} />
            </p>
          )
        }

        if (block.type === "hr") {
          return (
            <hr
              key={bi}
              className={compact ? "border-0 h-px bg-overlay-2 my-2" : "border-0 h-px bg-overlay-3 my-3"}
            />
          )
        }

        if (block.type === "command") {
          return (
            <div key={bi}>
              {block.before && <p className="whitespace-pre-wrap mb-1"><InlineText text={block.before} /></p>}
              <CommandBlock text={block.command} />
              {block.after && <p className="whitespace-pre-wrap mt-1"><InlineText text={block.after} /></p>}
            </div>
          )
        }

        if (block.type === "code") {
          if (isDiagramLang(block.lang)) {
            // If the JSON block is incomplete, attempting to render broken JSON
            // produces a DiagramError flash — show a loading pill instead.
            {
              let isComplete = false
              try { JSON.parse(block.text); isComplete = true } catch { /* incomplete JSON */ }
              if (!isComplete) {
                return (
                  <div key={bi} className="rounded-lg border border-border-subtle px-3 py-2 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-pulse shrink-0" />
                    <span className="text-base text-text-muted font-mono">{block.lang} chart rendering…</span>
                  </div>
                )
              }
            }
            return <InlineDiagram key={bi} kind={block.lang} source={block.text} />
          }
          // Defensive: the agent sometimes wraps a chart payload in a generic
          // ```json (or untagged) fence. If the JSON shape is recognisable as
          // a known chart kind, render it as a diagram instead of raw text.
          // tryInferDiagramKind calls JSON.parse internally and returns null on
          // failure, so this path is already safe during streaming.
          const lowerLang = (block.lang ?? "").toLowerCase()
          if (lowerLang === "" || lowerLang === "json" || lowerLang === "json5") {
            const inferred = tryInferDiagramKind(block.text)
            if (inferred) {
              return <InlineDiagram key={bi} kind={inferred} source={block.text} />
            }
          }
          return (
            <div key={bi} className={compact ? "" : "rounded-lg overflow-hidden border border-border-subtle"}>
              {compact ? (
                <CompactCodeBlock lang={block.lang} text={block.text} />
              ) : (
                <>
                  {block.lang && (
                    <div className="px-3 py-1 text-base text-text-muted font-mono border-b border-border-subtle tracking-wide">
                      {block.lang}
                    </div>
                  )}
                  <pre className="px-3 py-2.5 text-base font-mono text-text-secondary overflow-x-auto leading-relaxed">
                    {block.text}
                  </pre>
                </>
              )}
            </div>
          )
        }

        if (block.type === "bullet-list") {
          return (
            <ul key={bi} className="space-y-2">
              {block.items.map((item, ii) => (
                (() => {
                  const commandItem = parseCommandLikeItem(item)
                  if (commandItem) {
                    return (
                      <li key={ii} className="rounded-lg border border-border-subtle bg-overlay-1 overflow-hidden">
                        <div className="flex items-start gap-3 px-3 py-2.5">
                          <span className="mt-0.5 text-text-muted font-mono text-sm shrink-0">›</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-mono text-text text-[13px] font-semibold">{commandItem.name}</span>
                              <span className="text-[12px] text-text-muted font-mono break-all">{commandItem.detail}</span>
                            </div>
                          </div>
                        </div>
                      </li>
                    )
                  }
                  return (
                    <li key={ii} className="flex items-start gap-2.5 rounded-md px-1 py-0.5">
                      <span className="mt-2 w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0" />
                      <span><InlineText text={item} /></span>
                    </li>
                  )
                })()
              ))}
            </ul>
          )
        }

        if (block.type === "ordered-list") {
          const tableData = tryConvertOrderedListToTable(block.items)
          if (tableData) {
            return (
              <div key={bi} className="py-2">
                {compact ? (
                  <CompactTable headers={tableData.headers} rows={tableData.rows} />
                ) : (
                  <DataTable
                    headers={tableData.headers}
                    rows={tableData.rows}
                    renderCell={(v) => <InlineText text={v} />}
                    renderHeader={(v) => <InlineText text={v} />}
                  />
                )}
              </div>
            )
          }
          return (
            <ol key={bi} className="space-y-1.5">
              {block.items.map((item, ii) => (
                <li key={ii} className="flex items-stretch gap-0 rounded-md overflow-hidden border border-border-subtle bg-overlay-1">
                  <span className="shrink-0 flex items-center justify-center w-8 bg-accent-soft text-accent font-bold text-base border-r border-border-subtle">
                    {item.num}
                  </span>
                  <span className="px-3 py-2 text-text text-base font-medium leading-snug">
                    <InlineText text={item.text} />
                  </span>
                </li>
              ))}
            </ol>
          )
        }

        if (block.type === "table") {
          return (
            <div key={bi} className="py-2">
              {compact ? (
                <CompactTable headers={block.headers} rows={block.rows} />
              ) : (
                <DataTable
                  headers={block.headers}
                  rows={block.rows}
                  renderCell={(v) => <InlineText text={v} />}
                  renderHeader={(v) => <InlineText text={v} />}
                />
              )}
            </div>
          )
        }

        return null
      })}
    </div>
    </CompactContext.Provider>
  )
}

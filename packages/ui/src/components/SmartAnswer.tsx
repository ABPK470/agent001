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

import type React from "react";
import { DataTable } from "./DataTable";
import { InlineDiagram, isDiagramLang, tryInferDiagramKind } from "./InlineDiagram";

// ── Block types ────────────────────────────────────────────────

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "bullet-list"; items: string[] }
  | { type: "ordered-list"; items: { num: number; text: string }[] }

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

// ── Parser ─────────────────────────────────────────────────────

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n")
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Skip blank lines between blocks
    if (line.trim() === "") { i++; continue }

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
    if (paraLines.length > 0) blocks.push({ type: "paragraph", lines: paraLines })
  }

  return blocks
}

// ── Inline text renderer ────────────────────────────────────────

function InlineText({ text }: { text: string }): React.ReactElement {
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
    if (codeMatch)   candidates.push({ idx: codeMatch.index!,   len: codeMatch[0].length,   node: <code key={key++} className="font-mono text-[11px] bg-white/[0.08] text-accent px-1 py-0.5 rounded">{codeMatch[1]}</code> })

    if (candidates.length === 0) { parts.push(remaining); break }

    const first = candidates.reduce((a, b) => (a.idx <= b.idx ? a : b))
    if (first.idx > 0) parts.push(remaining.slice(0, first.idx))
    parts.push(first.node)
    remaining = remaining.slice(first.idx + first.len)
  }

  return <>{parts}</>
}

// ── Component ──────────────────────────────────────────────────

export function SmartAnswer({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = parseBlocks(text)

  return (
    <div className="text-text-secondary text-sm leading-relaxed space-y-2.5 w-full min-w-0">
      {blocks.map((block, bi) => {

        if (block.type === "heading") {
          const cls = [
            "text-base font-bold text-text",
            "text-sm font-semibold text-text border-b border-white/[0.06] pb-1",
            "text-sm font-medium text-text-secondary",
          ][block.level - 1] ?? "text-sm font-medium text-text-secondary"
          return <p key={bi} className={cls}><InlineText text={block.text} /></p>
        }

        if (block.type === "paragraph") {
          return (
            <p key={bi} className="whitespace-pre-wrap">
              <InlineText text={block.lines.join("\n")} />
            </p>
          )
        }

        if (block.type === "code") {
          if (isDiagramLang(block.lang)) {
            return <InlineDiagram key={bi} kind={block.lang} source={block.text} />
          }
          // Defensive: the agent sometimes wraps a chart payload in a generic
          // ```json (or untagged) fence. If the JSON shape is recognisable as
          // a known chart kind, render it as a diagram instead of raw text.
          const lowerLang = (block.lang ?? "").toLowerCase()
          if (lowerLang === "" || lowerLang === "json" || lowerLang === "json5") {
            const inferred = tryInferDiagramKind(block.text)
            if (inferred) {
              return <InlineDiagram key={bi} kind={inferred} source={block.text} />
            }
          }
          return (
            <div key={bi} className="rounded-lg overflow-hidden border border-white/[0.08]">
              {block.lang && (
                <div className="px-3 py-1 bg-white/[0.04] text-[11px] text-text-muted font-mono border-b border-white/[0.06] tracking-wide">
                  {block.lang}
                </div>
              )}
              <pre className="px-3 py-2.5 text-[12px] font-mono text-text-secondary overflow-x-auto bg-base leading-relaxed">
                {block.text}
              </pre>
            </div>
          )
        }

        if (block.type === "bullet-list") {
          return (
            <ul key={bi} className="space-y-1.5 pl-1">
              {block.items.map((item, ii) => (
                <li key={ii} className="flex items-start gap-2.5">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0" />
                  <span><InlineText text={item} /></span>
                </li>
              ))}
            </ul>
          )
        }

        if (block.type === "ordered-list") {
          const tableData = tryConvertOrderedListToTable(block.items)
          if (tableData) {
            return (
              <DataTable
                key={bi}
                headers={tableData.headers}
                rows={tableData.rows}
                renderCell={(v) => <InlineText text={v} />}
                renderHeader={(v) => <InlineText text={v} />}
              />
            )
          }
          return (
            <ol key={bi} className="space-y-1.5">
              {block.items.map((item, ii) => (
                <li key={ii} className="flex items-stretch gap-0 rounded-md overflow-hidden border border-white/[0.07] bg-white/[0.025]">
                  <span className="shrink-0 flex items-center justify-center w-8 bg-accent/15 text-accent font-bold text-[11px] border-r border-white/[0.07]">
                    {item.num}
                  </span>
                  <span className="px-3 py-2 text-text text-[13px] font-medium leading-snug">
                    <InlineText text={item.text} />
                  </span>
                </li>
              ))}
            </ol>
          )
        }

        if (block.type === "table") {
          return (
            <DataTable
              key={bi}
              headers={block.headers}
              rows={block.rows}
              renderCell={(v) => <InlineText text={v} />}
              renderHeader={(v) => <InlineText text={v} />}
            />
          )
        }

        return null
      })}
      {streaming && (
        <span className="inline-block w-0.5 h-3.5 bg-accent ml-0.5 animate-pulse align-middle" />
      )}
    </div>
  )
}

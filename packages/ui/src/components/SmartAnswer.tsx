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

// ── Block types ────────────────────────────────────────────────

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "bullet-list"; items: string[] }
  | { type: "ordered-list"; items: { num: number; text: string }[] }

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

// ── Helpers ─────────────────────────────────────────────────────

function isNumericCell(val: string): boolean {
  const stripped = val.replace(/[,%$€£¥\s]/g, "")
  return stripped !== "" && !isNaN(Number(stripped))
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
          const { headers, rows } = block
          // Detect numeric columns — right-align and use tabular nums
          const numericCols = headers.map((_, ci) =>
            rows.length > 0 && rows.every((row) => !row[ci] || isNumericCell(row[ci]))
          )
          return (
            <div key={bi} className="w-full min-w-0 rounded-lg border border-white/[0.08]">
              <div className="overflow-x-auto overflow-y-auto max-h-80">
                <table className="text-[12px] border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                <thead className="sticky top-0 z-10">
                  <tr className="bg-elevated">
                    {headers.map((h, ci) => (
                      <th
                        key={ci}
                        className={`px-3 py-2 font-semibold text-text whitespace-nowrap border-b border-white/[0.08] ${numericCols[ci] ? "text-right" : "text-left"}`}
                      >
                        <InlineText text={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className={`border-b border-white/[0.04] transition-colors ${ri % 2 === 0 ? "" : "bg-white/[0.015]"} hover:bg-accent/[0.05]`}
                    >
                      {headers.map((_, ci) => (
                        <td
                          key={ci}
                          className={`px-3 py-1.5 text-text-secondary ${numericCols[ci] ? "text-right tabular-nums font-mono" : "text-left"}`}
                        >
                          <InlineText text={row[ci] ?? ""} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
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

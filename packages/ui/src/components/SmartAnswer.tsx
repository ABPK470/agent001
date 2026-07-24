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
import type { AnswerBlock } from "./answer-parser"
import { parseAnswerBlocks } from "./answer-parser"
import type { StreamRevealState } from "./answer-stream-reveal"
import { sliceBlockForReveal } from "./answer-stream-reveal"
import { DataTable } from "./DataTable"
import { TableExportActions } from "./TableExportActions"
import type { ChatTableExportSource } from "../lib/chat-table-export"
import { InlineDiagram, isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"
import { StructuredPendingBlock } from "./StreamingBlocks"

// Context that flips inline rendering (e.g. inline `code` chips) to a
// lighter, less-decorated style. Used by the term-chat widget.
const CompactContext = React.createContext(false)

type Block = AnswerBlock

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
    if (codeMatch)   candidates.push({ idx: codeMatch.index!,   len: codeMatch[0].length,   node: <code key={key++} className={compact ? "font-mono text-[15px] text-text-muted bg-overlay-2 px-1.5 py-0.5 rounded" : "font-mono text-sm bg-accent-soft text-accent px-1.5 py-0.5 rounded border border-accent/25"}>{codeMatch[1]}</code> })

    if (candidates.length === 0) { parts.push(remaining); break }

    const first = candidates.reduce((a, b) => (a.idx <= b.idx ? a : b))
    if (first.idx > 0) parts.push(remaining.slice(0, first.idx))
    parts.push(first.node)
    remaining = remaining.slice(first.idx + first.len)
  }

  return <>{parts}</>
}

function StreamingCaret({ compact }: { compact?: boolean }) {
  return (
    <span
      className={[
        "inline-block w-[2px] bg-accent/80 animate-pulse align-middle ml-0.5",
        compact ? "h-[15px]" : "h-[1em]",
      ].join(" ")}
      aria-hidden
    />
  )
}

// ── Component ──────────────────────────────────────────────────

// Lightweight compact table — used in TermChat. Inset border on the wrapper
// (not ring) so home-chat scrollports do not clip the right edge; rings paint
// outside the box and are clipped by overflow scroll containers. Outer chrome
// matches ChartFrame / stream-pending-shell (rounded-lg border).
/** Same outer rhythm as ChartFrame / stream-pending-shell (rounded-lg border). */
export const COMPACT_TABLE_WRAPPER_CLASS =
  "w-full min-w-0 overflow-x-auto rounded-lg border border-border-subtle"

/**
 * Compact markdown table — shared by SmartAnswer and the live stream shell.
 *
 * Layout: full-width bordered table. Copy/CSV/JSON overlay the header's
 * top-right (no permanent gutter) and stay pinned to the visible box so
 * horizontal table scroll never hides them past the edge.
 *
 * Settle is whole-block (stream-diagram-enter on the parent) — never row drip.
 */
export function CompactTable({
  headers,
  rows,
  exportSource,
  exportDisabled = false,
}: {
  headers: string[]
  rows: string[][]
  exportSource?: ChatTableExportSource
  exportDisabled?: boolean
}) {
  const showExport = Boolean(exportSource) && rows.length > 0
  return (
    <div className="group relative my-1.5 w-full min-w-0">
      {showExport && exportSource ? (
        <div className="absolute top-1.5 right-1.5 z-10">
          <TableExportActions
            headers={headers}
            rows={rows}
            source={exportSource}
            disabled={exportDisabled}
            compact
            revealOnHover
            overlayChip
          />
        </div>
      ) : null}
      <div className={COMPACT_TABLE_WRAPPER_CLASS}>
        {/*
          `w-auto min-w-full`: let the table choose its natural column widths
          (so 10-column result sets don't get squished into the viewport) but
          stretch to fill the wrapper when there are only a few short columns.
          When natural width exceeds the wrapper, the outer `overflow-x-auto`
          kicks in and the user can scroll horizontally to see every column.
        */}
        <table className="w-auto min-w-full text-[15px] leading-6 border-collapse">
          <thead>
            <tr>
              {headers.map((h, hi) => (
                <th
                  key={hi}
                  className={[
                    "text-left font-bold text-text-secondary text-[15px] px-3 py-1.5 border-b border-border-subtle whitespace-nowrap",
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
    </div>
  )
}

// Lightweight code block — soft tinted panel, no heavy borders or header
// bar unless lang is meaningful. Reads as a distinct snippet against the
// chat background while staying visually quiet. Hovering reveals a copy
// button in the top-right corner.
//
// Use inset `border` (not `ring`) — same rule as CompactTable. TermChat's
// transcript host is `overflow-x-hidden`; rings paint outside the box and
// the right edge gets clipped (left often survives thanks to `pl-1`).
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
    }).catch((err: unknown) => { console.error("[mia]", err) })
  }, [text])
  return (
    <div className="group relative my-1.5 w-full min-w-0 rounded-md border border-border-subtle overflow-hidden">
      {showLang && (
        <div className="px-3 pt-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-text-muted">
          {lang}
        </div>
      )}
      <pre className="px-3 py-2 text-[15px] leading-relaxed font-mono text-text-muted overflow-x-auto whitespace-pre">
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

function markdownTableIndex(blocks: AnswerBlock[], blockIndex: number): number {
  let index = 0
  for (let i = 0; i < blockIndex; i++) {
    if (blocks[i]?.type === "table") index++
  }
  return index
}

export function SmartAnswer({
  text,
  blocks: blocksIn,
  reveal,
  streaming: _streaming = false,
  compact = false,
  exportRunId,
  enterBlockIndices,
}: {
  text?: string
  blocks?: AnswerBlock[]
  reveal?: StreamRevealState
  /** @deprecated Kept for callers; spacing no longer differs while streaming. */
  streaming?: boolean
  compact?: boolean
  /** When set, markdown tables Export via audited run API. */
  exportRunId?: string
  /**
   * Structured visuals (tables / charts) that just left the pending shell —
   * play the same stream-diagram-enter settle charts use.
   */
  enterBlockIndices?: ReadonlySet<number>
}) {
  void _streaming
  const blocks = blocksIn ?? parseAnswerBlocks(text ?? "")
  /** Export only when the answer is settled — never mid-stream / mid-reveal. */
  const exportSettled = !_streaming && !reveal

  return (
    <CompactContext.Provider value={compact}>
    <div className={[
      compact ? "text-text-secondary text-[15px] leading-6 w-full min-w-0" : "text-text-secondary text-base leading-relaxed w-full min-w-0",
      // Keep live + settled spacing identical — flipping 2↔3 shook the stream.
      "space-y-3",
    ].join(" ")}>
      {blocks.map((block, bi) => {
        if (reveal && bi > reveal.doneCount) return null
        const printing = Boolean(reveal && bi === reveal.doneCount && reveal.partial)
        const settling = Boolean(enterBlockIndices?.has(bi))
        let activeBlock: Block | "diagram-building" = block
        if (printing && reveal?.partial) {
          const sliced = sliceBlockForReveal(block, reveal.partial)
          if (sliced === null) return null
          if (sliced === "diagram-building") {
            return (
              <div key={bi} className="stream-block-appear">
                <StructuredPendingBlock lang={block.type === "code" ? block.lang : "chart"} />
              </div>
            )
          }
          activeBlock = sliced
        } else if (reveal && bi < reveal.doneCount) {
          activeBlock = block
        }

        const wrapClass = reveal ? "stream-block-appear" : ""
        const structuredEnter = printing || settling ? "stream-diagram-enter" : ""
        const b = activeBlock

        if (b.type === "heading") {
          if (b.level === 1) {
            return (
              <div key={bi} className={`flex items-center gap-3 pt-1 pb-0.5 ${wrapClass}`}>
                <span className="h-px flex-1 bg-gradient-to-r from-overlay-3 to-transparent" />
                <p className="text-[15px] font-semibold tracking-[0.12em] uppercase text-text">
                  <InlineText text={b.text} />
                  {printing ? <StreamingCaret compact={compact} /> : null}
                </p>
                <span className="h-px flex-1 bg-gradient-to-l from-overlay-3 to-transparent" />
              </div>
            )
          }
          if (b.level === 2) {
            return (
              <div key={bi} className={`flex items-center gap-2 pt-1 ${wrapClass}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-accent/75 shrink-0" />
                <p className="font-semibold text-text border-b border-border-subtle pb-1 flex-1">
                  <InlineText text={b.text} />
                  {printing ? <StreamingCaret compact={compact} /> : null}
                </p>
              </div>
            )
          }
          return (
            <p key={bi} className={`font-medium text-text-secondary ${wrapClass}`}>
              <InlineText text={b.text} />
              {printing ? <StreamingCaret compact={compact} /> : null}
            </p>
          )
        }

        if (b.type === "paragraph") {
          return (
            <p key={bi} className={`min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${wrapClass}`}>
              <InlineText text={b.lines.join("\n")} />
              {printing ? <StreamingCaret compact={compact} /> : null}
            </p>
          )
        }

        if (b.type === "hr") {
          return (
            <hr
              key={bi}
              className={[compact ? "border-0 h-px bg-overlay-2 my-2" : "border-0 h-px bg-overlay-3 my-3", wrapClass].join(" ")}
            />
          )
        }

        if (b.type === "command") {
          return (
            <div key={bi} className={wrapClass}>
              {b.before && <p className="whitespace-pre-wrap mb-1"><InlineText text={b.before} /></p>}
              <CommandBlock text={b.command} />
              {b.after && <p className="whitespace-pre-wrap mt-1"><InlineText text={b.after} /></p>}
              {printing ? <StreamingCaret compact={compact} /> : null}
            </div>
          )
        }

        if (b.type === "code") {
          if (isDiagramLang(b.lang)) {
            // If the JSON block is incomplete, attempting to render broken JSON
            // produces a DiagramError flash — show a loading pill instead.
            {
              let isComplete = false
              try { JSON.parse(b.text); isComplete = true } catch (err: unknown) { console.error("[mia]", err) }
              if (!isComplete) {
                return <StructuredPendingBlock key={bi} lang={b.lang} />
              }
            }
            return (
              <div key={bi} className={`${wrapClass} ${structuredEnter}`}>
                <InlineDiagram kind={b.lang} source={b.text} />
              </div>
            )
          }
          const lowerLang = (b.lang ?? "").toLowerCase()
          if (lowerLang === "" || lowerLang === "json" || lowerLang === "json5") {
            const inferred = tryInferDiagramKind(b.text)
            if (inferred) {
              return (
                <div key={bi} className={`${wrapClass} ${structuredEnter}`}>
                  <InlineDiagram kind={inferred} source={b.text} />
                </div>
              )
            }
          }
          return (
            <div key={bi} className={[compact ? "" : "rounded-lg overflow-hidden border border-border-subtle", wrapClass].join(" ")}>
              {compact ? (
                <CompactCodeBlock lang={b.lang} text={b.text} />
              ) : (
                <>
                  {b.lang && (
                    <div className="px-3 py-1 text-base text-text-muted font-mono border-b border-border-subtle tracking-wide">
                      {b.lang}
                    </div>
                  )}
                  <pre className="px-3 py-2.5 text-base font-mono text-text-secondary overflow-x-auto leading-relaxed">
                    {b.text}
                  </pre>
                </>
              )}
            </div>
          )
        }

        if (b.type === "bullet-list") {
          return (
            <ul key={bi} className={`space-y-2 ${wrapClass}`}>
              {b.items.map((item, ii) => (
                (() => {
                  const commandItem = parseCommandLikeItem(item)
                  if (commandItem) {
                    return (
                      <li key={ii} className="rounded-lg border border-border-subtle bg-overlay-1 overflow-hidden">
                        <div className="flex items-start gap-3 px-3 py-2.5">
                          <span className="mt-0.5 text-text-muted font-mono text-sm shrink-0">›</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-mono text-text text-[15px] font-semibold">{commandItem.name}</span>
                              <span className="text-[15px] text-text-muted font-mono break-all">{commandItem.detail}</span>
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

        if (b.type === "ordered-list") {
          const tableData = tryConvertOrderedListToTable(b.items)
          if (tableData) {
            const localSource: ChatTableExportSource = { kind: "local", title: "List table" }
            const listTableEntering = printing || settling
            return (
              <div key={bi} className={`${wrapClass} ${structuredEnter}`}>
                {compact ? (
                  <CompactTable
                    headers={tableData.headers}
                    rows={tableData.rows}
                    exportSource={localSource}
                    exportDisabled={!exportSettled || listTableEntering}
                  />
                ) : (
                  <DataTable
                    headers={tableData.headers}
                    rows={tableData.rows}
                    renderCell={(v) => <InlineText text={v} />}
                    renderHeader={(v) => <InlineText text={v} />}
                    exportSource={localSource}
                    exportDisabled={!exportSettled || listTableEntering}
                  />
                )}
              </div>
            )
          }
          return (
            <ol key={bi} className={`space-y-1.5 ${wrapClass}`}>
              {b.items.map((item, ii) => (
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

        if (b.type === "table") {
          const tableEntering = (printing && reveal?.partial?.kind === "table") || settling
          const tableIndex = markdownTableIndex(blocks, bi)
          const exportSource: ChatTableExportSource | undefined = exportRunId
            ? { kind: "run", runId: exportRunId, tableIndex }
            : { kind: "local", title: `Table ${tableIndex + 1}` }
          return (
            <div key={bi} className={`${wrapClass} ${structuredEnter}`}>
              {compact ? (
                <CompactTable
                  headers={b.headers}
                  rows={b.rows}
                  exportSource={exportSource}
                  exportDisabled={!exportSettled || tableEntering}
                />
              ) : (
                <DataTable
                  headers={b.headers}
                  rows={b.rows}
                  renderCell={(v) => <InlineText text={v} />}
                  renderHeader={(v) => <InlineText text={v} />}
                  exportSource={exportSource}
                  exportDisabled={!exportSettled || tableEntering}
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

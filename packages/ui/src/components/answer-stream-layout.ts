/**
 * Streaming answer layout — splits an in-progress agent answer into a
 * committed prefix (fully formed blocks safe to render with SmartAnswer)
 * and a volatile tail. Structured markdown (tables, fences, lists) is held
 * until the block is closed, then rendered as a whole — never char/line drip.
 */

export type StreamingRemainderKind = "none" | "prose" | "fenced" | "table" | "markdown"

export interface StreamingAnswerLayout {
  /** Text that is structurally complete and should render formatted immediately. */
  committed: string
  /** Uncommitted tail — may be empty when the buffer ends on a block boundary. */
  remainder: string
  remainderKind: StreamingRemainderKind
  /** Language tag from an open fenced block, when remainderKind === "fenced". */
  fencedLang?: string
}

function countFenceMarkers(text: string): number {
  let count = 0
  let idx = 0
  while ((idx = text.indexOf("```", idx)) >= 0) {
    count++
    idx += 3
  }
  return count
}

/**
 * Pipe-table lines — including in-progress rows like `|` or `| Ada`.
 * Requiring a second `|` let half-typed rows fall out of the hold path,
 * which briefly committed the table into SmartAnswer then yanked it back
 * (layout shake). Charts/KPIs avoid that because an open fence stays open
 * until the closing ```; tables need the same sticky hold.
 */
function isTableLine(line: string): boolean {
  return line.trimStart().startsWith("|")
}

function isListLine(line: string): boolean {
  const t = line.trimStart()
  return /^([-*•]|\d+[.)])(\s|$)/.test(t)
}

function isBlockquoteLine(line: string): boolean {
  return line.trimStart().startsWith(">")
}

/** Trailing structured markdown that must appear as one unit (not line drip). */
function isHoldableMarkdownLine(line: string): boolean {
  return isTableLine(line) || isListLine(line) || isBlockquoteLine(line)
}

function lastNonEmptyIndex(lines: string[]): number {
  let i = lines.length - 1
  while (i >= 0 && lines[i]!.trim() === "") i--
  return i
}

/**
 * Hold a trailing pipe-table until non-table content follows (or the stream
 * settles). Never commit growing rows into SmartAnswer mid-flight.
 */
function trailingTableLayout(lines: string[]): StreamingAnswerLayout | null {
  const lastNonEmpty = lastNonEmptyIndex(lines)
  if (lastNonEmpty < 0 || !isTableLine(lines[lastNonEmpty]!)) return null

  let tableStart = lastNonEmpty
  while (tableStart >= 0 && isTableLine(lines[tableStart]!)) tableStart--
  tableStart++

  const committedText =
    tableStart === 0 ? "" : lines.slice(0, tableStart).join("\n").replace(/\s+$/, "")
  return {
    committed: committedText,
    remainder: lines.slice(tableStart).join("\n"),
    remainderKind: "table",
  }
}

/**
 * Hold trailing lists / blockquotes until the block closes (non-holdable line
 * or stream settle). Prevents line-by-line markdown formatting.
 */
function trailingMarkdownBlockLayout(lines: string[]): StreamingAnswerLayout | null {
  const lastNonEmpty = lastNonEmptyIndex(lines)
  if (lastNonEmpty < 0 || !isHoldableMarkdownLine(lines[lastNonEmpty]!)) return null
  // Tables have their own pending shell.
  if (isTableLine(lines[lastNonEmpty]!)) return null

  let blockStart = lastNonEmpty
  while (blockStart >= 0 && isHoldableMarkdownLine(lines[blockStart]!)) blockStart--
  blockStart++

  const committedText =
    blockStart === 0 ? "" : lines.slice(0, blockStart).join("\n").replace(/\s+$/, "")
  return {
    committed: committedText,
    remainder: lines.slice(blockStart).join("\n"),
    remainderKind: "markdown",
  }
}

function trailingPartialLineLayout(text: string): StreamingAnswerLayout | null {
  if (!text.includes("\n")) return null

  const lastBreak = text.lastIndexOf("\n")
  const tail = text.slice(lastBreak + 1)

  if (tail.length === 0) {
    // Ends on a newline. If the buffer still ends in a pipe-table, keep holding
    // (same as an open fence) — never commit growing rows on a trailing \n.
    const trimmed = text.replace(/\s+$/, "")
    if (!trimmed) return null
    const lines = trimmed.split("\n")
    const tableLayout = trailingTableLayout(lines)
    if (tableLayout) return tableLayout
    return { committed: trimmed, remainder: "", remainderKind: "none" }
  }

  const before = text.slice(0, lastBreak)
  if (!before.trim()) return null

  // Markdown-shaped in-flight line — hold with the markdown remainder, not prose glyph.
  // Pipe-tables use the same pending path as charts/KPIs (remainderKind "table").
  if (isTableLine(tail)) {
    return {
      committed: before.replace(/\s+$/, ""),
      remainder: tail,
      remainderKind: "table",
    }
  }
  if (isMarkdownShapedLine(tail) || isHoldableMarkdownLine(tail)) {
    return {
      committed: before.replace(/\s+$/, ""),
      remainder: tail,
      remainderKind: "markdown",
    }
  }

  return {
    committed: before.replace(/\s+$/, ""),
    remainder: tail,
    remainderKind: "prose",
  }
}

/** Single-line buffer that is already a complete heading — safe to format immediately. */
function trailingSingleHeadingLayout(text: string): StreamingAnswerLayout | null {
  if (text.includes("\n")) return null
  const t = text.trimEnd()
  if (!/^#{1,3}\s+\S/.test(t)) return null
  return { committed: t, remainder: "", remainderKind: "none" }
}

function trailingProseLayout(text: string): StreamingAnswerLayout | null {
  const lastParaBreak = text.lastIndexOf("\n\n")
  if (lastParaBreak <= 0 || lastParaBreak >= text.length - 1) return null

  const afterBreak = text.slice(lastParaBreak + 2)
  if (!afterBreak) return null
  if (afterBreak.startsWith("```")) return null
  if (isTableLine(afterBreak)) return null
  if (/^#{1,3}\s/.test(afterBreak)) return null
  if (isListLine(afterBreak) || isBlockquoteLine(afterBreak)) return null

  return {
    committed: text.slice(0, lastParaBreak).replace(/\s+$/, ""),
    remainder: afterBreak,
    remainderKind: "prose",
  }
}

/**
 * Within a prose remainder, split complete lines (render as markdown) from the
 * single in-flight line (glyph-settle animation — plain prose only).
 */
export function splitProseRemainder(remainder: string): { renderable: string; inFlight: string } {
  if (!remainder) return { renderable: "", inFlight: "" }
  const nl = remainder.lastIndexOf("\n")
  if (nl < 0) {
    // One line still arriving — format only when it is structurally complete.
    if (/^#{1,3}\s+\S/.test(remainder.trimEnd())) {
      return { renderable: remainder.trimEnd(), inFlight: "" }
    }
    return { renderable: "", inFlight: remainder }
  }
  return {
    renderable: remainder.slice(0, nl).replace(/\s+$/, ""),
    inFlight: remainder.slice(nl + 1),
  }
}

/** Markdown-shaped lines must never go through the ASCII glyph stream. */
export function isMarkdownShapedLine(line: string): boolean {
  const t = line.trimStart()
  if (!t) return false
  return (
    /^#{1,6}(\s|$)/.test(t) ||
    /^([-*•]|\d+[.)])(\s|$)/.test(t) ||
    t.startsWith("|") ||
    t.startsWith("```") ||
    t.startsWith(">") ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)
  )
}

export function splitStreamingAnswer(text: string): StreamingAnswerLayout {
  if (!text) return { committed: "", remainder: "", remainderKind: "none" }

  // Open fenced block — never stream raw fence / JSON characters.
  if (countFenceMarkers(text) % 2 === 1) {
    const openIdx = text.lastIndexOf("```")
    const lineStart = openIdx <= 0 ? 0 : text.lastIndexOf("\n", openIdx - 1) + 1
    const firstLine = text.slice(lineStart).split("\n")[0] ?? ""
    return {
      committed: text.slice(0, lineStart).replace(/\s+$/, ""),
      remainder: text.slice(lineStart),
      remainderKind: "fenced",
      fencedLang: firstLine.slice(3).trim() || "text",
    }
  }

  const lines = text.split("\n")
  const tableLayout = trailingTableLayout(lines)
  if (tableLayout) return tableLayout

  const markdownBlockLayout = trailingMarkdownBlockLayout(lines)
  if (markdownBlockLayout) return markdownBlockLayout

  const proseLayout = trailingProseLayout(text)
  if (proseLayout) return proseLayout

  const partialLineLayout = trailingPartialLineLayout(text)
  if (partialLineLayout) return partialLineLayout

  const singleHeadingLayout = trailingSingleHeadingLayout(text)
  if (singleHeadingLayout) return singleHeadingLayout

  // Single-line markdown still arriving — hold, don't glyph.
  // Tables share the chart/KPI pending path (shimmer "Table").
  if (isTableLine(text)) {
    return { committed: "", remainder: text, remainderKind: "table" }
  }
  if (isMarkdownShapedLine(text) || isHoldableMarkdownLine(text)) {
    return { committed: "", remainder: text, remainderKind: "markdown" }
  }

  return { committed: "", remainder: text, remainderKind: "prose" }
}

export function joinStreamingParts(committed: string, proseTail: string): string {
  if (!committed) return proseTail
  if (!proseTail) return committed
  return `${committed}\n\n${proseTail}`
}

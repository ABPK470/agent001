import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"
import type { AnswerBlock } from "./answer-parser"
import { parseAnswerBlocks } from "./answer-parser"
import { splitStreamingAnswer, splitProseRemainder, isMarkdownShapedLine, type StreamingAnswerLayout } from "./answer-stream-layout"

export const BLOCK_GAP_UNITS = 36
export const UNITS_PER_SECOND = 72
export const CATCHUP_UNITS_THRESHOLD = 220
export const CATCHUP_MULTIPLIER = 2.4

const TABLE_HEADER_UNITS = 48
const TABLE_ROW_UNITS = 54
const DIAGRAM_BUILD_UNITS = 400
const LIST_ITEM_UNITS = 28

export type BlockPartialReveal =
  | { kind: "text"; chars: number }
  | { kind: "table"; rows: number }
  | { kind: "list"; items: number }
  | { kind: "diagram"; phase: "building" | "done" }

export interface StreamRevealState {
  doneCount: number
  partial: BlockPartialReveal | null
}

export interface StreamingSegments {
  blocks: AnswerBlock[]
  layout: StreamingAnswerLayout
}

export function getStreamingSegments(text: string): StreamingSegments {
  const layout = splitStreamingAnswer(text)
  const blocks = layout.committed ? parseAnswerBlocks(layout.committed) : []
  return { blocks, layout }
}

/** Live SSE path — commit only finished blocks; glyph plain prose only. */
export function getLiveStreamingRenderParts(text: string): {
  blocks: AnswerBlock[]
  glyphTail: string
  layout: StreamingAnswerLayout
} {
  const layout = splitStreamingAnswer(text)
  let extraCommitted = ""
  let glyphTail = ""

  if (layout.remainderKind === "prose" && layout.remainder) {
    const split = splitProseRemainder(layout.remainder)
    extraCommitted = split.renderable
    // Hold markdown-shaped tails until the line completes — then SmartAnswer
    // renders them. Only plain prose goes through the ASCII glyph stream.
    glyphTail = isMarkdownShapedLine(split.inFlight) ? "" : split.inFlight
  }
  // fenced | table | markdown → held until whole; no glyph, no partial format.

  const committedAll =
    layout.committed && extraCommitted
      ? `${layout.committed}\n${extraCommitted}`
      : layout.committed || extraCommitted
  const blocks = committedAll ? parseAnswerBlocks(committedAll) : []

  return { blocks, glyphTail, layout }
}

function isDiagramBlock(block: AnswerBlock): boolean {
  if (block.type !== "code") return false
  const lower = (block.lang ?? "").toLowerCase()
  if (isDiagramLang(lower)) return true
  if (lower === "" || lower === "json" || lower === "json5") return tryInferDiagramKind(block.text) !== null
  return false
}

export function blockRevealUnits(block: AnswerBlock): number {
  switch (block.type) {
    case "hr":
      return 14
    case "heading":
      return Math.max(28, block.text.length + 12)
    case "paragraph":
      return Math.max(10, block.lines.join("\n").length)
    case "command":
      return (block.before?.length ?? 0) + block.command.length + (block.after?.length ?? 0) + 36
    case "bullet-list":
      return 16 + block.items.length * LIST_ITEM_UNITS
    case "ordered-list":
      return 16 + block.items.reduce((sum, item) => sum + item.text.length + LIST_ITEM_UNITS, 0)
    case "table":
      return TABLE_HEADER_UNITS + block.rows.length * TABLE_ROW_UNITS
    case "code":
      if (isDiagramBlock(block)) return DIAGRAM_BUILD_UNITS
      return Math.max(36, block.text.length)
  }
}

export function totalBlockUnits(blocks: AnswerBlock[]): number {
  if (blocks.length === 0) return 0
  return blocks.reduce((sum, block, index) => {
    const gap = index > 0 ? BLOCK_GAP_UNITS : 0
    return sum + gap + blockRevealUnits(block)
  }, 0)
}

function partialAt(block: AnswerBlock, unitsIntoBlock: number): BlockPartialReveal {
  switch (block.type) {
    case "table": {
      if (unitsIntoBlock < TABLE_HEADER_UNITS) return { kind: "table", rows: 0 }
      const rowUnits = Math.floor((unitsIntoBlock - TABLE_HEADER_UNITS) / TABLE_ROW_UNITS)
      return { kind: "table", rows: Math.min(block.rows.length, rowUnits) }
    }
    case "bullet-list": {
      const items = Math.min(block.items.length, Math.max(0, Math.floor((unitsIntoBlock - 8) / LIST_ITEM_UNITS)))
      return { kind: "list", items }
    }
    case "ordered-list": {
      let spent = 8
      let count = 0
      for (const item of block.items) {
        const cost = item.text.length + LIST_ITEM_UNITS
        if (spent + cost > unitsIntoBlock) break
        spent += cost
        count++
      }
      return { kind: "list", items: count }
    }
    case "code":
      if (isDiagramBlock(block)) {
        return unitsIntoBlock < DIAGRAM_BUILD_UNITS * 0.82
          ? { kind: "diagram", phase: "building" }
          : { kind: "diagram", phase: "done" }
      }
      return { kind: "text", chars: Math.min(block.text.length, unitsIntoBlock) }
    case "command": {
      const full = `${block.before}\n${block.command}\n${block.after}`
      return { kind: "text", chars: Math.min(full.length, unitsIntoBlock) }
    }
    default: {
      const text =
        block.type === "paragraph"
          ? block.lines.join("\n")
          : block.type === "heading"
            ? block.text
            : ""
      return { kind: "text", chars: Math.min(text.length, unitsIntoBlock) }
    }
  }
}

export function revealFromUnits(blocks: AnswerBlock[], units: number): StreamRevealState {
  let remaining = units
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) {
      if (remaining < BLOCK_GAP_UNITS) return { doneCount: i, partial: null }
      remaining -= BLOCK_GAP_UNITS
    }
    const cost = blockRevealUnits(blocks[i]!)
    if (remaining < cost) {
      return { doneCount: i, partial: partialAt(blocks[i]!, remaining) }
    }
    remaining -= cost
  }
  return { doneCount: blocks.length, partial: null }
}

export function availablePrintUnits(segments: StreamingSegments): number {
  const blockTotal = totalBlockUnits(segments.blocks)
  const prose =
    segments.layout.remainderKind === "prose" && segments.layout.remainder
      ? segments.layout.remainder.length
      : 0
  return blockTotal + prose
}

export function snapProseTail(text: string, chars: number, atEnd: boolean): string {
  const slice = text.slice(0, chars)
  if (!slice || atEnd) return slice
  if (/\s$/.test(slice)) return slice
  const lastWhitespace = slice.search(/\s[^\s]*$/)
  if (lastWhitespace < 0) return slice
  return slice.slice(0, lastWhitespace + 1)
}

export function sliceBlockForReveal(
  block: AnswerBlock,
  partial: BlockPartialReveal,
): AnswerBlock | "diagram-building" | null {
  switch (block.type) {
    case "paragraph": {
      if (partial.kind !== "text") return block
      const full = block.lines.join("\n")
      const sliced = full.slice(0, partial.chars)
      if (!sliced) return null
      return { type: "paragraph", lines: sliced.split("\n") }
    }
    case "heading": {
      if (partial.kind !== "text") return block
      return { type: "heading", level: block.level, text: block.text.slice(0, partial.chars) }
    }
    case "table": {
      if (partial.kind !== "table") return block
      return { type: "table", headers: block.headers, rows: block.rows.slice(0, partial.rows) }
    }
    case "bullet-list": {
      if (partial.kind !== "list") return block
      return { type: "bullet-list", items: block.items.slice(0, partial.items) }
    }
    case "ordered-list": {
      if (partial.kind !== "list") return block
      return { type: "ordered-list", items: block.items.slice(0, partial.items) }
    }
    case "code": {
      if (partial.kind === "diagram" && partial.phase === "building") return "diagram-building"
      if (partial.kind === "text") {
        return { type: "code", lang: block.lang, text: block.text.slice(0, partial.chars) }
      }
      return block
    }
    case "command": {
      if (partial.kind !== "text") return block
      const full = `${block.before}\n${block.command}\n${block.after}`
      const sliced = full.slice(0, partial.chars)
      // Keep command visible once we've reached it in the slice.
      if (sliced.length <= block.before.length) {
        return { type: "command", command: block.command, before: sliced, after: "" }
      }
      return block
    }
    case "hr":
      return block
  }
}

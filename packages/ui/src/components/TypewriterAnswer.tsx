/**
 * TypewriterAnswer — answer reveal for agent responses.
 *
 * Live SSE: finished prose/headings render via SmartAnswer; tables, fences
 * (charts/KPIs/dashboards), and lists hold a quiet pending shell until the
 * whole block is ready — then appear as one unit. Plain prose may glyph-drip.
 * Settled answers render fully via SmartAnswer (no re-type).
 */

import { useMemo, useRef } from "react"
import { getLiveStreamingRenderParts } from "./answer-stream-reveal"
import { GlyphStreamText } from "./GlyphStreamText"
import { SmartAnswer } from "./SmartAnswer"
import { StructuredPendingBlock, TablePendingBlock } from "./StreamingBlocks"

const bodyClass = (compact: boolean) =>
  compact
    ? "text-text-secondary text-[15px] leading-6 w-full min-w-0"
    : "text-text-secondary text-base leading-relaxed w-full min-w-0"

/** Live stream — whole markdown blocks only; never format partial tables/fences/lists. */
function StreamingLiveAnswer({
  text,
  compact,
  exportRunId,
}: {
  text: string
  compact: boolean
  exportRunId?: string
}) {
  const { blocks, glyphTail, layout } = useMemo(() => getLiveStreamingRenderParts(text), [text])

  const hasBlockContent = blocks.length > 0
  const hasGlyphTail = glyphTail.length > 0
  const showFencePending = layout.remainderKind === "fenced" && layout.remainder.length > 0
  const showTablePending = layout.remainderKind === "table" && layout.remainder.length > 0

  return (
    <div className={[bodyClass(compact), "space-y-3"].join(" ")}>
      {hasBlockContent ? (
        <SmartAnswer blocks={blocks} compact={compact} streaming exportRunId={exportRunId} />
      ) : null}
      {hasGlyphTail ? (
        <div className="whitespace-pre-wrap break-words">
          <GlyphStreamText text={glyphTail} />
        </div>
      ) : null}
      {showFencePending ? (
        <StructuredPendingBlock lang={layout.fencedLang ?? "chart"} />
      ) : null}
      {showTablePending ? <TablePendingBlock /> : null}
    </div>
  )
}

export function TypewriterAnswer({
  text,
  streaming = false,
  compact = false,
  exportRunId,
}: {
  text: string
  streaming?: boolean
  compact?: boolean
  exportRunId?: string
}) {
  // Preserve identity across live → completed so we do not remount and flash.
  const hasStreamedRef = useRef(streaming)
  if (streaming) hasStreamedRef.current = true

  if (streaming) {
    return <StreamingLiveAnswer text={text} compact={compact} exportRunId={exportRunId} />
  }
  return <SmartAnswer text={text} compact={compact} exportRunId={exportRunId} />
}

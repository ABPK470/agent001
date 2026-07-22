/**
 * TypewriterAnswer — answer reveal for agent responses.
 *
 * Live SSE: finished prose/headings render via SmartAnswer. Incomplete
 * tables and chart/KPI/dashboard blocks share one pending path — the same
 * quiet shimmer as tool "Working" — until the whole block is ready, then
 * appear as one unit. Plain prose may glyph-drip. Settled answers render
 * fully via SmartAnswer.
 */

import { useMemo, useRef } from "react"
import { getLiveStreamingRenderParts } from "./answer-stream-reveal"
import { GlyphStreamText } from "./GlyphStreamText"
import { SmartAnswer } from "./SmartAnswer"
import { StructuredPendingBlock } from "./StreamingBlocks"

const bodyClass = (compact: boolean) =>
  compact
    ? "text-text-secondary text-[15px] leading-6 w-full min-w-0"
    : "text-text-secondary text-base leading-relaxed w-full min-w-0"

/** Live stream — whole markdown blocks only; never format partial tables/charts. */
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
  // Charts/KPIs/dashboards (open fence) and pipe-tables share one pending chrome.
  const pendingLang =
    layout.remainderKind === "fenced"
      ? (layout.fencedLang ?? "chart")
      : layout.remainderKind === "table"
        ? "table"
        : null

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
      {pendingLang ? <StructuredPendingBlock lang={pendingLang} /> : null}
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

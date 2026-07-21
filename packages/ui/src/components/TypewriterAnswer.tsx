/**
 * TypewriterAnswer — answer reveal for agent responses.
 *
 * Live SSE: committed markdown blocks render immediately via SmartAnswer;
 * only plain prose drips through GlyphStreamText (ASCII settle).
 * Completed answers render fully via SmartAnswer — no re-type, no markdown
 * animation (that felt rushed and shaky).
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

/** Live stream — formatted committed blocks + paced ASCII prose tail. */
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
  const showStructuredPending =
    (layout.remainderKind === "fenced" || layout.remainderKind === "table") &&
    layout.remainder.length > 0

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
      {showStructuredPending && layout.remainderKind === "fenced" ? (
        <StructuredPendingBlock lang={layout.fencedLang ?? "chart"} />
      ) : null}
      {showStructuredPending && layout.remainderKind === "table" ? (
        <TablePendingBlock raw={layout.remainder} />
      ) : null}
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

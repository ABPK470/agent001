/**
 * TypewriterAnswer — answer reveal for agent responses.
 *
 * Live SSE: finished prose/headings render via SmartAnswer. Incomplete
 * tables and chart/KPI/dashboard blocks share one quiet pending shell
 * until the whole block is ready, then settle with the same enter motion
 * charts use. Plain prose advances by words — no glyph scramble.
 *
 * Settled answers keep the same tree when the stream just finished so a
 * trailing table (held until end) lands into its stage instead of popping.
 */

import { useMemo, useRef } from "react"
import type { AnswerBlock } from "./answer-parser"
import { parseAnswerBlocks } from "./answer-parser"
import { getLiveStreamingRenderParts } from "./answer-stream-reveal"
import { WordStreamText } from "./WordStreamText"
import { SmartAnswer } from "./SmartAnswer"
import { StructuredPendingBlock } from "./StreamingBlocks"
import { isDiagramLang, tryInferDiagramKind } from "./InlineDiagram"

const bodyClass = (compact: boolean) =>
  compact
    ? "text-text-secondary text-[15px] leading-6 w-full min-w-0"
    : "text-text-secondary text-base leading-relaxed w-full min-w-0"

/** Stable identity for structured visuals that share the pending → settle path. */
export function structuredVisualKey(block: AnswerBlock): string | null {
  if (block.type === "table") {
    return `table:${block.headers.join("\t")}\n${block.rows.map((row) => row.join("\t")).join("\n")}`
  }
  if (block.type !== "code") return null
  const lower = (block.lang ?? "").toLowerCase()
  if (isDiagramLang(lower)) return `diagram:${lower}:${block.text}`
  if (lower === "" || lower === "json" || lower === "json5") {
    if (tryInferDiagramKind(block.text)) return `diagram:json:${block.text}`
  }
  return null
}

/**
 * Indices of structured blocks that should play stream-diagram-enter.
 * Live sessions only — history mounts seed seen keys without animating.
 */
export function collectEnteringStructuredIndices(
  blocks: AnswerBlock[],
  allowEnter: boolean,
  seenKeys: Set<string>,
  enteredKeys: Set<string>,
): Set<number> {
  const enter = new Set<number>()
  for (let i = 0; i < blocks.length; i++) {
    const key = structuredVisualKey(blocks[i]!)
    if (!key) continue
    if (!allowEnter) {
      seenKeys.add(key)
      continue
    }
    if (!seenKeys.has(key)) {
      enteredKeys.add(key)
      seenKeys.add(key)
    }
    if (enteredKeys.has(key)) enter.add(i)
  }
  return enter
}

/** Live + post-stream settle — one tree so pending → content does not remount. */
function StreamingAnswerBody({
  text,
  streaming,
  compact,
  exportRunId,
}: {
  text: string
  streaming: boolean
  compact: boolean
  exportRunId?: string
}) {
  const allowEnterRef = useRef(streaming)
  if (streaming) allowEnterRef.current = true

  const seenKeysRef = useRef<Set<string>>(new Set())
  const enteredKeysRef = useRef<Set<string>>(new Set())

  const { blocks, glyphTail, layout } = useMemo(() => {
    if (streaming) return getLiveStreamingRenderParts(text)
    return {
      blocks: parseAnswerBlocks(text),
      glyphTail: "",
      layout: { committed: text, remainder: "", remainderKind: "none" as const },
    }
  }, [text, streaming])

  const enterBlockIndices = useMemo(
    () =>
      collectEnteringStructuredIndices(
        blocks,
        allowEnterRef.current,
        seenKeysRef.current,
        enteredKeysRef.current,
      ),
    [blocks],
  )

  const hasBlockContent = blocks.length > 0
  const hasProseTail = glyphTail.length > 0
  // Charts/KPIs/dashboards (open fence) and pipe-tables share one pending shell.
  const pendingLang =
    layout.remainderKind === "fenced"
      ? (layout.fencedLang ?? "chart")
      : layout.remainderKind === "table"
        ? "table"
        : null

  return (
    <div className={[bodyClass(compact), "space-y-3"].join(" ")}>
      {hasBlockContent ? (
        <SmartAnswer
          blocks={blocks}
          compact={compact}
          streaming={streaming}
          exportRunId={exportRunId}
          enterBlockIndices={enterBlockIndices}
        />
      ) : null}
      {hasProseTail ? (
        <div className="whitespace-pre-wrap break-words">
          <WordStreamText text={glyphTail} />
        </div>
      ) : null}
      {pendingLang ? (
        <StructuredPendingBlock lang={pendingLang} remainder={layout.remainder} />
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
  // Once a message has streamed, keep the settle body so trailing tables
  // (held until stream end) land with the same enter path as mid-stream charts.
  const hasStreamedRef = useRef(streaming)
  if (streaming) hasStreamedRef.current = true

  if (streaming || hasStreamedRef.current) {
    return (
      <StreamingAnswerBody
        text={text}
        streaming={streaming}
        compact={compact}
        exportRunId={exportRunId}
      />
    )
  }
  return <SmartAnswer text={text} compact={compact} exportRunId={exportRunId} />
}

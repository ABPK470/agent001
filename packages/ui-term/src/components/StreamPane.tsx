/**
 * StreamPane — left half. Renders the active run's transcript as a
 * tight, line-oriented "agent terminal":
 *
 *   > goal text
 *     planning…
 *   ✓ tool list_runs            12ms
 *     ↳ 14 results
 *   ⏵ thinking…
 *   ⏵ … streamed answer chunks here …
 *   ✓ done
 *
 * No bubbles, no avatars — pure typed output. The active streaming
 * answer renders with a blinking caret at the end.
 */

import type React from "react"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import type { TranscriptKind, TranscriptRow } from "../store"
import type { Run } from "../types"

export interface StreamPaneHandle {
  focus(): void
  jumpToBottom(): void
}

interface Props {
  active: boolean
  rows: TranscriptRow[]
  streaming: string
  goalPlaceholder: string | null
  activeRunId: string | null
  /** Active run — used for the stats bar (tokens, steps, elapsed, etc.) */
  run: Run | null
}

const KIND_GLYPH: Record<TranscriptKind, string> = {
  goal:        ">",
  thinking:    "..",
  tool:        "->",
  "tool-result":"ok",
  "tool-error": "!!",
  answer:      "<-",
  error:       "!!",
  "user-input":"?",
  info:        "*",
}

const KIND_COLOR: Record<TranscriptKind, string> = {
  goal:        "var(--accent)",
  thinking:    "var(--c-llm)",
  tool:        "var(--c-tool)",
  "tool-result":"var(--c-tool)",
  "tool-error": "var(--c-error)",
  answer:      "var(--fg)",
  error:       "var(--c-error)",
  "user-input":"var(--c-audit)",
  info:        "var(--fg-dim)",
}

const KIND_TEXT_COLOR: Record<TranscriptKind, string> = {
  goal:        "var(--fg)",
  thinking:    "var(--fg-dim)",
  tool:        "var(--fg)",
  "tool-result":"var(--fg-dim)",
  "tool-error": "var(--c-error)",
  answer:      "var(--fg)",
  error:       "var(--c-error)",
  "user-input":"var(--fg)",
  info:        "var(--fg-dim)",
}

export const StreamPane = forwardRef<StreamPaneHandle, Props>(function StreamPane(
  { active, rows, streaming, goalPlaceholder, activeRunId, run }, ref
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef  = useRef<HTMLDivElement>(null)

  // Elapsed timer — ticks every second while the run is active
  const [elapsed, setElapsed] = useState(0)
  const busy = !!run && (run.status === "running" || run.status === "pending")
  useEffect(() => {
    if (!run || !busy) { setElapsed(0); return }
    const t0 = new Date(run.createdAt).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - t0) / 1000))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [run?.id, busy])

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus(),
    jumpToBottom: () => {
      const el = scrollRef.current
      if (el) { el.scrollTop = el.scrollHeight; el.focus() }
    },
  }))

  // Force-scroll to bottom whenever the active run changes (switching runs
  // or starting a new one). This re-engages sticky-scroll even if the user
  // had scrolled up in the previous run.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeRunId])

  // Sticky-scroll during an active run: follow new output unless the user
  // has scrolled up more than 80px from the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [rows.length, streaming])

  // ResizeObserver: catches content growth that doesn't change rows.length
  // (e.g. long-running tool output, DOM reflows). Only scrolls when near bottom.
  useEffect(() => {
    const inner = innerRef.current
    const outer = scrollRef.current
    if (!inner || !outer) return
    const ro = new ResizeObserver(() => {
      const dist = outer.scrollHeight - outer.scrollTop - outer.clientHeight
      if (dist < 120) outer.scrollTop = outer.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  const empty = rows.length === 0 && !streaming

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--divider)",
      }}
    >
      <PaneHeader active={active} title="STREAM" hint="run output" hotkey="Ctrl+1" />

      {/* Live stats bar — shown while run is active or has data */}
      {run && (run.stepCount > 0 || run.totalTokens > 0 || busy) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "3px 14px",
            fontSize: "var(--fs-xs)",
            color: "var(--fg-mute)",
            fontFamily: "var(--font-mono)",
            borderBottom: "1px solid var(--divider)",
            flexShrink: 0,
            letterSpacing: "0.04em",
          }}
        >
          {run.stepCount > 0 && (
            <span title="Tool calls completed">{run.stepCount} steps</span>
          )}
          {run.totalTokens > 0 && (
            <span title="Total tokens used">{run.totalTokens.toLocaleString()} tk</span>
          )}
          {run.llmCalls > 0 && (
            <span title="LLM API calls">{run.llmCalls} LLM</span>
          )}
          {run.lastIteration != null && run.lastIteration > 0 && (
            <span title="Current iteration">
              iter {run.lastIteration}{run.maxIterations ? `/${run.maxIterations}` : ""}
            </span>
          )}
          {run.usedPlanner && (
            <span title="Planner was used for this run" style={{ color: "var(--accent)", opacity: 0.7 }}>planned</span>
          )}
          {busy && elapsed > 0 && (
            <span title="Elapsed time" style={{ marginLeft: "auto" }}>{elapsed}s</span>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        tabIndex={-1}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 14px 14px 14px",
          outline: "none",
        }}
      >
        <div ref={innerRef}>
        {empty ? (
          <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-sm)", padding: "8px 0" }}>
            {goalPlaceholder
              ? `idle — type a goal at the prompt below to start a run.`
              : `idle.`}
          </div>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rows.map((r) => <Row key={r.id} row={r} animateThinking={busy} />)}
            {/* Live "Thinking" shimmer when run is active but no rows yet */}
            {rows.length === 0 && busy && !streaming && (
              <li style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                <span style={{ color: "var(--c-llm)", width: 22, flexShrink: 0, whiteSpace: "pre", lineHeight: "1.5" }}>{".."}</span>
                <span className="t-shimmer" style={{ fontSize: "var(--fs-base)", lineHeight: "1.5" }}>Thinking</span>
              </li>
            )}
            {streaming ? (
              <li style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "1px 0" }}>
                <span style={{ color: "var(--c-llm)", width: 22, flexShrink: 0, whiteSpace: "pre", lineHeight: "1.5" }}>{"<-"}</span>
                <pre
                  style={{
                    margin: 0,
                    fontFamily: "inherit",
                    fontSize: "inherit",
                    color: "var(--fg)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >{streaming}<span className="t-caret" /></pre>
              </li>
            ) : null}
          </ol>
        )}
        </div>
      </div>
    </section>
  )
})

function Row({ row, animateThinking }: { row: TranscriptRow; animateThinking: boolean }) {
  const isThinking = row.kind === "thinking"
  const rawText = row.text || (isThinking ? "Thinking" : "")
  // Capitalise first letter for thinking rows
  const displayText = isThinking && rawText
    ? rawText.charAt(0).toUpperCase() + rawText.slice(1).replace(/\.+$/, "")
    : rawText

  return (
    <li style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "1px 0" }}>
      <span style={{ color: KIND_COLOR[row.kind], width: 22, flexShrink: 0, whiteSpace: "pre", lineHeight: "1.5" }}>
        {KIND_GLYPH[row.kind]}
      </span>
      {isThinking ? (
        <span
          className={animateThinking ? "t-shimmer" : undefined}
          style={{
            fontFamily: "inherit",
            fontSize: "inherit",
            lineHeight: "1.5",
            color: animateThinking ? undefined : "var(--fg-dim)",
          } as React.CSSProperties}
        >{displayText}</span>
      ) : (
        <pre
          style={{
            margin: 0,
            flex: 1,
            fontFamily: "inherit",
            fontSize: "inherit",
            color: KIND_TEXT_COLOR[row.kind],
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: "1.5",
          }}
        >{displayText}</pre>
      )}
      {row.meta ? (
        <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)", flexShrink: 0, marginLeft: 8 }}>
          {row.meta}
        </span>
      ) : null}
    </li>
  )
}

export function PaneHeader({
  active, title, hint, hotkey,
}: { active: boolean; title: string; hint?: string; hotkey?: string }) {
  return (
    <div
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        fontSize: "var(--fs-sm)",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: active ? "var(--accent)" : "var(--fg-dim)",
        borderBottom: "1px solid var(--divider)",
        userSelect: "none",
        flexShrink: 0,
        background: active ? "var(--bg-soft)" : "transparent",
      }}
    >
      {hotkey ? (
        <span style={{ color: "var(--fg-mute)", marginRight: 8, fontSize: "var(--fs-xs)" }}>[{hotkey}]</span>
      ) : null}
      <span>{title}</span>
      {hint ? (
        <span style={{ color: "var(--fg-mute)", marginLeft: 12, textTransform: "none", letterSpacing: "0.04em", fontSize: "var(--fs-xs)" }}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

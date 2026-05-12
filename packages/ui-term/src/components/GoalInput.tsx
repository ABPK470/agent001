/**
 * GoalInput — bottom prompt bar.
 *
 *   > _ enter your goal here…
 *
 * Multi-line capable (Shift+Enter newline; Enter submits). When the user
 * types `/` as the first character, a slash-command popup appears with
 * intellisense-style autocomplete:
 *
 *   ↑↓        navigate suggestions
 *   Tab       accept the highlighted slash into the input (lets you edit args later)
 *   Enter     run the highlighted slash directly (or submit normally if popup empty)
 *   Esc       close the popup without acting
 *
 * Suggestions are computed by the parent via `getSuggestions`, which closes
 * over the canonical command registry. This keeps the input dumb and lets
 * the registry stay the single source of truth for slash semantics.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import type { SlashSuggestion } from "../commands"

export interface GoalInputHandle {
  focus(): void
}

interface Props {
  busy: boolean
  pendingQuestion: string | null
  onSubmit: (text: string) => void
  /** Called with the current draft; returns slash suggestions (may be empty). */
  getSuggestions?: (text: string) => SlashSuggestion[]
}

export const GoalInput = forwardRef<GoalInputHandle, Props>(function GoalInput(
  { busy, pendingQuestion, onSubmit, getSuggestions },
  ref,
) {
  const [val, setVal] = useState("")
  const [cursor, setCursor] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }))

  // ── Suggestions ──
  // Only computed when the draft starts with "/" on its first line. Recomputed
  // on every keystroke; cheap (registry has ~10 entries).
  const suggestions = useMemo<SlashSuggestion[]>(() => {
    if (!getSuggestions) return []
    return getSuggestions(val)
  }, [val, getSuggestions])

  const popupOpen = suggestions.length > 0
  const safeCursor = popupOpen ? Math.min(cursor, suggestions.length - 1) : 0

  useEffect(() => { setCursor(0) }, [val.split("\n")[0]])

  function submit() {
    const text = val.trim()
    if (!text) return
    onSubmit(text)
    setVal("")
    setCursor(0)
  }

  function acceptIntoInput(s: SlashSuggestion) {
    // Replace the first line with the canonical slash and a trailing space.
    // Preserves anything on subsequent lines (rare for slash commands but cheap).
    const rest = val.includes("\n") ? "\n" + val.split("\n").slice(1).join("\n") : ""
    const next = `/${s.slash} ${rest}`.trimEnd()
    setVal(next.endsWith(" ") || rest ? next : next + " ")
    setCursor(0)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      const pos = `/${s.slash} `.length
      ta.setSelectionRange(pos, pos)
    })
  }

  function runSuggestion(s: SlashSuggestion) {
    setVal("")
    setCursor(0)
    void s.run()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (popupOpen) {
      if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) {
        e.preventDefault()
        setCursor((c) => (c + 1) % suggestions.length)
        return
      }
      if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) {
        e.preventDefault()
        setCursor((c) => (c - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === "Tab") {
        e.preventDefault()
        const pick = suggestions[safeCursor]
        if (pick) acceptIntoInput(pick)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        // Clear just the slash so the popup closes; keep the rest.
        setVal((v) => v.replace(/^\/[^\s]*\s?/, ""))
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        const pick = suggestions[safeCursor]
        if (pick) runSuggestion(pick)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const responding = !!pendingQuestion
  const promptGlyph = responding ? "?" : ">"
  const promptColor = responding ? "var(--c-audit)" : "var(--accent)"
  const placeholder = responding
    ? `responding to: ${pendingQuestion!.slice(0, 64)}${pendingQuestion!.length > 64 ? "\u2026" : ""}`
    : busy
      ? "run is streaming \u2014 type /cancel to abort, /rerun to restart, or /rollback to revert effects"
      : "enter a goal, or type / for commands  \u2014  Enter to submit, Shift+Enter for newline"

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      {popupOpen ? (
        <SuggestionPopup
          items={suggestions}
          cursor={safeCursor}
          onHover={setCursor}
          onPick={runSuggestion}
        />
      ) : null}

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          background: "var(--bg-input)",
          padding: "8px 12px",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <span style={{ color: promptColor, fontWeight: 500, lineHeight: "1.6", userSelect: "none" }}>
          {promptGlyph}
        </span>
        <textarea
          ref={taRef}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            resize: "none",
            minHeight: "1.6em",
            maxHeight: "10em",
            color: "var(--fg)",
            fontSize: "var(--fs-base)",
            fontFamily: "var(--font-mono)",
            lineHeight: "1.6",
          }}
        />
        <span
          style={{
            color: busy && !responding ? "var(--c-run)" : "var(--fg-mute)",
            fontSize: "var(--fs-xs)",
            letterSpacing: "0.06em",
            marginTop: 4,
            userSelect: "none",
            whiteSpace: "nowrap",
          }}
        >
          {responding ? "Enter respond" : busy ? "[busy]" : "Enter run"}
        </span>
      </div>
    </div>
  )
})

// ── Suggestion popup ─────────────────────────────────────────────────────────
//
// Floats above the input. Limited to 8 visible rows; if more match, the rest
// scroll. Click → run, hover → highlight (synced with keyboard cursor).

function SuggestionPopup({
  items,
  cursor,
  onHover,
  onPick,
}: {
  items: SlashSuggestion[]
  cursor: number
  onHover: (i: number) => void
  onPick: (s: SlashSuggestion) => void
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: "calc(100% + 4px)",
        maxHeight: "32vh",
        overflowY: "auto",
        background: "var(--bg-elev)",
        border: "1px solid var(--divider-strong)",
        boxShadow: "0 -8px 24px rgba(0,0,0,0.35)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-sm)",
        zIndex: 50,
      }}
      onMouseDown={(e) => e.preventDefault() /* keep textarea focused */}
    >
      <div
        style={{
          padding: "4px 10px",
          color: "var(--fg-mute)",
          fontSize: "var(--fs-xs)",
          letterSpacing: "0.04em",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          gap: 12,
        }}
      >
        <span>commands · {items.length}</span>
        <span style={{ flex: 1 }} />
        <span>
          <Kbd>↑↓</Kbd> nav · <Kbd>Tab</Kbd> insert · <Kbd>Enter</Kbd> run · <Kbd>Esc</Kbd> close
        </span>
      </div>
      {items.map((s, i) => {
        const active = i === cursor
        return (
          <div
            key={s.slash}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(s)}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "5px 10px",
              cursor: "pointer",
              background: active ? "var(--bg-soft)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-dim)",
              borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
            }}
          >
            <span style={{ color: "var(--accent)", minWidth: 90 }}>
              /{s.slash}
              {s.alias && s.alias !== s.slash ? (
                <span style={{ color: "var(--fg-mute)" }}> ({s.alias})</span>
              ) : null}
            </span>
            <span style={{ flex: 1 }}>{s.label}</span>
            {s.hint ? (
              <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>{s.hint}</span>
            ) : null}
            {s.keybind ? <Kbd>{s.keybind}</Kbd> : null}
          </div>
        )
      })}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      color: "var(--accent)",
      background: "var(--bg-soft)",
      padding: "1px 6px",
      borderRadius: 3,
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-xs)",
    }}>{children}</span>
  )
}

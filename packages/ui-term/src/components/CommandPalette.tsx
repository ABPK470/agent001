/**
 * CommandPalette — Ctrl+K / ?
 *
 * Centered modal. Type to fuzzy-filter; ↑↓ to move; Enter to invoke;
 * Esc to dismiss. Commands are grouped (navigate / run / log / shell).
 *
 * One palette = one entry point to every action. Keeps the HelpBar
 * tiny and avoids the "13 chips at the bottom" anti-pattern.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import type { Command, CommandGroup } from "../commands"
import { fuzzyScore } from "../commands"

interface Props {
  commands: Command[]
  onClose: () => void
}

const GROUP_LABEL: Record<CommandGroup, string> = {
  navigate: "navigate",
  run:      "run",
  log:      "log",
  shell:    "shell",
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const matches = useMemo(() => {
    const scored = commands
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.label) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label))
    return scored.map((m) => m.cmd)
  }, [commands, query])

  useEffect(() => { setCursor(0) }, [query])

  // Group while preserving cursor order across the flat list.
  const grouped = useMemo(() => {
    const out: { group: CommandGroup; items: Command[] }[] = []
    const order: CommandGroup[] = ["run", "navigate", "log", "shell"]
    for (const g of order) {
      const items = matches.filter((c) => c.group === g)
      if (items.length) out.push({ group: g, items })
    }
    return out
  }, [matches])

  // Flat index → command, used for arrow nav
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  function invoke(cmd: Command) {
    onClose()
    // Defer so the palette unmounts before the command (which may open
    // another modal) runs.
    queueMicrotask(() => { void cmd.run() })
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        background: "rgba(12,12,16,0.78)",
        display: "flex", justifyContent: "center", alignItems: "flex-start",
        paddingTop: "12vh",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 92vw)", maxHeight: "70vh",
          background: "var(--bg-elev)",
          border: "1px solid var(--divider-strong)",
          borderRadius: 4,
          display: "flex", flexDirection: "column",
          fontFamily: "var(--font-mono)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
      >
        {/* Title */}
        <div
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid var(--divider)",
            display: "flex", alignItems: "center", gap: 12,
            color: "var(--fg-dim)", fontSize: "var(--fs-xs)",
            letterSpacing: "0.14em", textTransform: "uppercase",
          }}
        >
          <span style={{ color: "var(--accent)" }}>command</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-mute)", textTransform: "none", letterSpacing: "0.04em" }}>
            {flat.length}/{commands.length} · Up/Down · Enter · Esc
          </span>
        </div>

        {/* Filter input */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--divider)",
            display: "flex", alignItems: "center", gap: 10,
            background: "var(--bg-input)",
          }}
        >
          <span style={{ color: "var(--accent)", fontSize: "var(--fs-base)" }}>&gt;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); return }
              if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) {
                e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0))); return
              }
              if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) {
                e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return
              }
              if (e.key === "Enter") {
                e.preventDefault()
                const cmd = flat[cursor]
                if (cmd) invoke(cmd)
              }
            }}
            placeholder="search commands…"
            spellCheck={false}
            style={{
              flex: 1,
              color: "var(--fg)", fontSize: "var(--fs-base)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>

        {/* List */}
        <div style={{ overflow: "auto", flex: 1, padding: "4px 0" }}>
          {flat.length === 0 ? (
            <div style={{ color: "var(--fg-mute)", padding: "16px 14px", fontSize: "var(--fs-sm)" }}>
              no commands match.
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.group} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    padding: "6px 14px 2px",
                    color: "var(--fg-mute)",
                    fontSize: "var(--fs-xs)",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                  }}
                >
                  {GROUP_LABEL[g.group]}
                </div>
                {g.items.map((cmd) => {
                  const idx = flat.indexOf(cmd)
                  const selected = idx === cursor
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => invoke(cmd)}
                      style={{
                        width: "100%", textAlign: "left",
                        display: "grid",
                        gridTemplateColumns: "1fr auto",
                        gap: 12, alignItems: "center",
                        padding: "5px 14px",
                        background: selected ? "var(--bg-soft)" : "transparent",
                        borderLeft: `2px solid ${selected ? "var(--accent)" : "transparent"}`,
                        color: "var(--fg)",
                        fontSize: "var(--fs-sm)",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
                        <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {cmd.label}
                        </span>
                        {cmd.hint ? (
                          <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>{cmd.hint}</span>
                        ) : null}
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--fg-mute)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>
                        {cmd.slash ? <kbd style={kbdStyle}>/{cmd.slash}</kbd> : null}
                        {cmd.keybind ? <kbd style={kbdStyle}>{cmd.keybind}</kbd> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  background: "var(--bg)",
  border: "1px solid var(--divider)",
  padding: "1px 6px",
  borderRadius: 3,
  color: "var(--fg-dim)",
  letterSpacing: "0.02em",
}

/**
 * RunPicker — terminal-style modal for selecting a run.
 *
 *   ┌─ runs ─────────────────────────────────────────────── esc ─┐
 *   │ > _filter_                                                 │
 *   ├────────────────────────────────────────────────────────────┤
 *   │ 2026-04-30 18:04:22  a3f9c12d  ● completed                 │
 *   │   summarise the lineage of customer orders and …           │
 *   │ ─────                                                      │
 *   │ 2026-04-30 17:51:08  9e1b774a  ◐ running                   │
 *   │   build a delta sync recipe for dbo.Customers              │
 *   └────────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useRef, useState } from "react"
import type { Run } from "../types"

interface Props {
  runs: Run[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

const STATUS_LABEL: Record<string, string> = {
  pending: "[pending]", running: "[running]", streaming: "[streaming]",
  completed: "[ok]", failed: "[fail]", cancelled: "[cancelled]",
}
const STATUS_COLOR: Record<string, string> = {
  pending: "var(--fg-dim)", running: "var(--c-run)", streaming: "var(--c-run)",
  completed: "var(--c-ok)", failed: "var(--c-error)", cancelled: "var(--fg-mute)",
}

function fmtFullTime(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch { return iso }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

export function RunPicker({ runs, activeId, onSelect, onClose }: Props) {
  const [filter, setFilter] = useState("")
  const [cursor, setCursor] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return runs
    return runs.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      (r.goal ?? "").toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q),
    )
  }, [runs, filter])

  useEffect(() => { setCursor(0) }, [filter])
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-row='${cursor}']`)
    node?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  function copyRun(r: (typeof filtered)[number]) {
    const text = `run:${r.id.slice(0, 7)}`
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedId(r.id)
    setTimeout(() => setCopiedId((prev) => prev === r.id ? null : prev), 1500)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); return
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const r = filtered[cursor]
      if (r) { onSelect(r.id); onClose() }
    }
    // / — copy highlighted run id as "run:xxxxxxx" (for pasting into ops filter)
    if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      const r = filtered[cursor]
      if (r) copyRun(r)
    }
  }

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(880px, 92vw)",
          maxHeight: "75vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-elev)",
          border: "1px solid var(--divider-strong)",
          borderRadius: 6,
          boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {/* title bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "8px 14px",
            borderBottom: "1px solid var(--divider)",
            color: "var(--fg-dim)",
            fontSize: "var(--fs-sm)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: "var(--accent)" }}>runs</span>
          <span style={{ marginLeft: 10, color: "var(--fg-mute)" }}>{filtered.length}/{runs.length}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-mute)" }}>Up/Down select &middot; Enter open &middot; / copy id &middot; Esc close</span>
        </div>

        {/* filter */}
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--divider)" }}>
          <span style={{ color: "var(--accent)", marginRight: 10, fontSize: "var(--fs-base)" }}>{">"}</span>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKey}
            placeholder="filter by id, goal, status…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--fg)",
              fontFamily: "inherit",
              fontSize: "var(--fs-base)",
            }}
          />
        </div>

        {/* list */}
        <div ref={listRef} style={{ overflowY: "auto", padding: "6px 0" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "20px 14px", color: "var(--fg-mute)" }}>no runs match</div>
          ) : filtered.map((r, idx) => {
            const isActive = r.id === activeId
            const isCursor = idx === cursor
            return (
              <div
                key={r.id}
                data-row={idx}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => { onSelect(r.id); onClose() }}
                style={{
                  padding: "10px 14px",
                  cursor: "pointer",
                  background: isCursor ? "var(--bg-soft)" : "transparent",
                  borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: "var(--fs-sm)" }}>
                  <span style={{ color: "var(--fg-mute)", width: 168 }}>{fmtFullTime(r.createdAt)}</span>
                  <span
                    style={{ color: copiedId === r.id ? "var(--c-ok)" : "var(--accent)", width: 96, cursor: "pointer" }}
                    onClick={(e) => { e.stopPropagation(); copyRun(r) }}
                    title="click or press / to copy run:id"
                  >
                    {copiedId === r.id ? ">> copied" : r.id.slice(0, 8)}
                  </span>
                  <span style={{ color: STATUS_COLOR[r.status] ?? "var(--fg-dim)", width: 110 }}>
                    {STATUS_LABEL[r.status] ?? `[${r.status}]`}
                  </span>
                  <span style={{ flex: 1, color: "var(--fg-mute)", fontSize: "var(--fs-xs)", textAlign: "right" }}>
                    {r.stepCount} steps · {r.totalTokens} tok
                  </span>
                  {/* shown when row is highlighted — press / to copy */}
                  {isCursor && copiedId !== r.id && (
                    <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>[/] copy id</span>
                  )}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    paddingLeft: 0,
                    color: isCursor ? "var(--fg)" : "var(--fg-dim)",
                    fontSize: "var(--fs-base)",
                    lineHeight: 1.45,
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                  }}
                >
                  {truncate(r.goal ?? "(no goal)", 120)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

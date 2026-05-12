/**
 * StatusBar — single line at the very top.
 *
 *   MI:A // term · joe.smith@… · run a3f9c ◐ running · 18:04:22  ● live  ⇆ classic
 *
 * The UI switcher sits inline at the right edge so it can't overlap
 * any pane content underneath.
 */

import { useEffect, useState } from "react"
import type { Me, Run } from "../types"

interface Props {
  me: Me | null
  run: Run | null
  runs: Run[]
  connected: boolean
  onSwitchUser: () => void
  onSwitchUi: () => void
  onOpenPicker: () => void
  onAbortRun?: () => void
}

const STATUS_LABEL: Record<string, string> = {
  pending:    "[pending]",
  running:    "[running]",
  streaming:  "[streaming]",
  completed:        "[ok]",
  partial_success:  "[ok!]",
  failed:           "[fail]",
  cancelled:  "[cancelled]",
}

const STATUS_COLOR: Record<string, string> = {
  pending:    "var(--fg-dim)",
  running:    "var(--c-run)",
  streaming:  "var(--c-run)",
  completed:        "var(--c-ok)",
  partial_success:  "var(--color-viz-peach)",
  failed:           "var(--c-error)",
  cancelled:  "var(--fg-mute)",
}

function fmtTime(d = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

export function StatusBar({ me, run, runs, connected, onSwitchUser, onSwitchUi, onOpenPicker, onAbortRun }: Props) {
  const [now, setNow] = useState(fmtTime())
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const t = window.setInterval(() => setNow(fmtTime()), 1000)
    return () => window.clearInterval(t)
  }, [])

  function copyRunId() {
    if (!run) return
    const text = `run:${run.id.slice(0, 7)}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }

  const sep = <span style={{ color: "var(--fg-mute)", margin: "0 12px" }}>·</span>

  return (
    <header
      style={{
        height: 32,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        borderBottom: "1px solid var(--divider)",
        fontSize: "var(--fs-sm)",
        color: "var(--fg-dim)",
        userSelect: "none",
        flexShrink: 0,
        background: "var(--bg)",
      }}
    >
      <span style={{ color: "var(--fg)", letterSpacing: "0.1em" }}>MI:A</span>
      <span style={{ color: "var(--fg-mute)", marginLeft: 8, marginRight: 8 }}>//</span>
      <span style={{ color: "var(--accent)", letterSpacing: "0.08em" }}>term</span>

      {sep}

      <button
        type="button"
        onClick={onSwitchUser}
        style={{ color: me ? "var(--fg)" : "var(--fg-mute)", cursor: "pointer" }}
        title="Switch identity"
      >
        {me?.upn ?? me?.displayName ?? "anonymous"}
        {me?.isAdmin ? <span style={{ color: "var(--accent)", marginLeft: 8 }}>admin</span> : null}
      </button>

      {sep}

      {run ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--fg-dim)" }}>run</span>
          {/* Click the ID to copy "run:xxxxxxx" for use in the ops filter */}
          <button
            type="button"
            onClick={copyRunId}
            style={{ color: copied ? "var(--c-ok)" : "var(--fg)", cursor: "pointer" }}
            title="Click to copy run:id for ops filter"
          >
            {copied ? ">> copied" : run.id.slice(0, 7)}
          </button>
          {/* Click status to open picker */}
          <button
            type="button"
            onClick={onOpenPicker}
            style={{ color: STATUS_COLOR[run.status] ?? "var(--fg-dim)", cursor: "pointer" }}
            title={`Show recent runs (${runs.length})`}
          >
            {STATUS_LABEL[run.status] ?? `[${run.status}]`}
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={onOpenPicker}
          style={{ color: "var(--fg-mute)", cursor: "pointer" }}
          title="Open run picker"
        >
          no active run {runs.length > 0 ? `(${runs.length} past)` : ""}
        </button>
      )}

      {/* Abort button — only shown while a run is active. Click sends /cancel. */}
      {run && (run.status === "running" || run.status === "pending") && onAbortRun ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAbortRun() }}
          title="Abort the active run (Ctrl+. or /cancel)"
          style={{
            marginLeft: 10,
            color: "var(--c-error)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-sm)",
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid var(--c-error)",
            borderRadius: 3,
            cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          [abort]
        </button>
      ) : null}

      <span style={{ flex: 1 }} />

      <span style={{ color: "var(--fg-mute)" }}>{now}</span>
      <span
        style={{
          marginLeft: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          color: connected ? "var(--c-ok)" : "var(--c-error)",
        }}
        title={connected ? "stream connected" : "stream disconnected"}
      >
        <span
          className={connected ? "t-spin" : ""}
          style={{
            width: 10,
            display: "inline-block",
            textAlign: "center",
            fontFamily: "var(--font-mono)",
          }}
        >
          {connected ? "" : "X"}
        </span>
      </span>

      <button
        type="button"
        onClick={onSwitchUi}
        title="Switch to classic UI"
        style={{
          marginLeft: 14,
          color: "var(--fg-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-sm)",
          padding: "2px 4px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent)" }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--fg-dim)" }}
      >
        [&lt;|&gt;]
      </button>
    </header>
  )
}

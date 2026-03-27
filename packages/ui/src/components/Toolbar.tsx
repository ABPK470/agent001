/**
 * Toolbar — top bar with branding and connection status.
 */

import { useStore } from "../store"

export function Toolbar() {
  const connected = useStore((s) => s.connected)

  return (
    <header className="flex items-center justify-between px-4 h-10 border-b border-border shrink-0 select-none">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold tracking-wide text-text">
          AGENT<span className="text-accent">001</span>
        </span>
        <span className="text-[10px] text-text-muted font-mono">COMMAND CENTER</span>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: connected ? "var(--color-success)" : "var(--color-error)" }}
          />
          <span className="text-[11px] text-text-muted">
            {connected ? "Live" : "Offline"}
          </span>
        </div>
      </div>
    </header>
  )
}

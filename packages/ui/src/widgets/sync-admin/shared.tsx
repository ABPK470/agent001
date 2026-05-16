/**
 * Shared chrome for Sync Operations Console panels.
 *
 * Every panel renders inside the same shell, so layout, spacing,
 * headers, and feedback regions are guaranteed identical across
 * Environments / Schedules / Policies / Routes / Strategies /
 * Freeze Windows. Eliminates the "every section looks slightly
 * different" feel of the old SyncAdmin.
 */

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, X } from "lucide-react"
import type { JSX, ReactNode } from "react"

export interface PanelChromeProps {
  title:    string
  subtitle?: string
  /** Right-aligned actions (buttons). */
  actions?: ReactNode
  busy?:    boolean
  onRefresh?: () => void
  err?:     string | null
  ok?:      string | null
  onClearErr?: () => void
  /** Main content. Receives full vertical scroll inside the panel body. */
  children: ReactNode
}

export function PanelChrome({
  title, subtitle, actions, busy, onRefresh, err, ok, onClearErr, children,
}: PanelChromeProps): JSX.Element {
  return (
    <section className="flex h-full flex-col bg-canvas text-text">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-panel px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="truncate text-[11px] leading-tight text-text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {actions}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              refresh
            </button>
          )}
        </div>
      </header>

      {err && (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-5 py-2 text-xs text-rose-200">
          <AlertTriangle className="h-3 w-3" />
          <span className="flex-1 truncate">{err}</span>
          {onClearErr && <button onClick={onClearErr} className="text-rose-200/70 hover:text-rose-100"><X className="h-3 w-3" /></button>}
        </div>
      )}
      {ok && (
        <div className="flex shrink-0 items-center gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-5 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="h-3 w-3" /> {ok}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  )
}

// ── Layout primitives shared across panels ────────────────────────

export function Empty({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-xs text-text-muted">
      <p className="font-medium text-text">{title}</p>
      {children && <p className="max-w-md text-[11px] text-text-faint">{children}</p>}
    </div>
  )
}

export function HelpBanner({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mx-5 mt-4 rounded-lg border border-border-subtle bg-overlay-2/40 px-3 py-2.5 text-[11px] leading-relaxed text-text-muted">
      {children}
    </div>
  )
}

export function SplitView({ list, detail }: { list: ReactNode; detail: ReactNode }): JSX.Element {
  return (
    <div className="grid h-full grid-cols-[320px_1fr] overflow-hidden">
      <div className="overflow-y-auto border-r border-border-subtle bg-panel">{list}</div>
      <div className="overflow-y-auto">{detail}</div>
    </div>
  )
}

export function ListItem({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full flex-col items-start gap-0.5 border-l-2 px-3 py-2 text-left text-xs",
        active ? "border-accent bg-overlay-2" : "border-transparent hover:bg-overlay-2",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

export function DetailRow({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text break-all">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </>
  )
}

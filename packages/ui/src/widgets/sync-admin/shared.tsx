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
import { useRef } from "react"
import { useContainerSize } from "../../hooks/useContainerSize"

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
  const ref = useRef<HTMLElement>(null)
  const { width } = useContainerSize(ref)
  const compact = width > 0 && width < 640

  return (
    <section ref={ref} className="flex h-full min-w-0 flex-col bg-canvas text-text">
      <header className="flex min-h-14 shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border-subtle bg-panel px-5 py-3">
        <div className={`min-w-0 ${compact ? "w-full" : "flex-1"}`}>
          <h2 className="truncate text-sm font-semibold leading-tight">{title}</h2>
          {subtitle && <p className={`${compact ? "mt-1 whitespace-normal" : "truncate"} text-[11px] leading-tight text-text-muted`}>{subtitle}</p>}
        </div>
        <div className={`flex min-w-0 items-center gap-1.5 ${compact ? "w-full flex-wrap" : "justify-end"}`}>
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
        <div className="flex shrink-0 items-center gap-2 border-b border-error/30 bg-error-soft px-5 py-2 text-xs text-error">
          <AlertTriangle className="h-3 w-3" />
          <span className="flex-1 truncate">{err}</span>
          {onClearErr && <button onClick={onClearErr} className="text-error/70 hover:text-error"><X className="h-3 w-3" /></button>}
        </div>
      )}
      {ok && (
        <div className="flex shrink-0 items-center gap-2 border-b border-success/30 bg-success-soft px-5 py-2 text-xs text-success">
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
  const ref = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(ref)
  const stacked = width > 0 && width < 860

  return (
    <div ref={ref} className={stacked ? "flex h-full min-w-0 flex-col overflow-hidden" : "grid h-full min-w-0 grid-cols-[minmax(260px,320px)_minmax(0,1fr)] overflow-hidden"}>
      <div className={stacked ? "max-h-[34%] min-h-[160px] overflow-y-auto border-b border-border-subtle bg-panel" : "min-w-0 overflow-y-auto border-r border-border-subtle bg-panel"}>{list}</div>
      <div className="min-w-0 overflow-y-auto">{detail}</div>
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

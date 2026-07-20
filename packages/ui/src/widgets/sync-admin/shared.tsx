/**
 * Shared chrome for Sync Operations — reuses entity-registry layout tokens.
 */

import { CheckCircle2, ChevronRight, Inbox, Loader2, MousePointer2, X, XCircle, type LucideIcon } from "lucide-react"
import type { ComponentType, JSX, ReactNode } from "react"
import { LabeledCheckbox } from "../../components/Checkbox"
import { EmptyState } from "../../components/EmptyState"
import {
  META_TEXT,
  PANEL,
  TAB_BODY,
  TAB_BODY_INNER,
  TOOLBAR_ROW,
} from "./design"
import { IconButton } from "../entity-registry/IconButton"

export { TAB_PILL } from "./design"

export interface PanelChromeProps {
  title:    string
  hint?:    string
  actions?: ReactNode
  busy?:    boolean
  err?:     string | null
  ok?:      string | null
  onClearErr?: () => void
  children: ReactNode
}

/** @deprecated use ConsolePanel */
export function PanelChrome(props: PanelChromeProps): JSX.Element {
  return <ConsolePanel {...props} />
}

/** Optional toolbar row + scrollable body for table/overview panels. */
export function ConsolePanel({
  title,
  hint,
  actions,
  busy,
  err,
  ok,
  onClearErr,
  toolbar,
  children,
}: {
  title?: string
  hint?: string
  actions?: ReactNode
  busy?: boolean
  err?: string | null
  ok?: string | null
  onClearErr?: () => void
  toolbar?: ReactNode
  children: ReactNode
}): JSX.Element {
  const showHeader = title || actions
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden text-text">
      {showHeader && (
        <div className={TOOLBAR_ROW}>
          <div className="min-w-0 flex-1">
            {title && <span className="text-sm font-medium text-text">{title}</span>}
            {hint && <span className="ml-2 text-xs text-text-muted">{hint}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {busy && <Loader2 size={14} className="animate-spin text-text-muted" aria-label="Loading" />}
            {actions}
          </div>
        </div>
      )}
      {toolbar}
      {err && (
        <div className="flex shrink-0 items-start gap-2 px-3 pb-2 text-xs text-error">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 font-mono break-all">{err}</span>
          {onClearErr && (
            <button type="button" onClick={onClearErr} className="shrink-0"><X size={14} /></button>
          )}
        </div>
      )}
      {ok && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2 text-xs text-success">
          <CheckCircle2 size={14} /> {ok}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </section>
  )
}

/** Full-width toolbar inside a section — tabs/filters left, actions right. Matches entity-rail-header height. */
export function PanelToolbar({
  children,
  actions,
  busy,
}: {
  children: ReactNode
  actions?: ReactNode
  busy?: boolean
}): JSX.Element {
  return (
    <div className={`${TOOLBAR_ROW} shrink-0`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-1">
        {busy && <Loader2 size={14} className="animate-spin text-text-muted" aria-label="Loading" />}
        {actions}
      </div>
    </div>
  )
}

/**
 * List + detail inside the main pane — mirrors entity-registry shell (rail + detail).
 * List header aligns with detail toolbar on the same row (ENTITIES | Overview pattern).
 */
export function ItemShell({
  listLabel,
  listActions,
  busy,
  detailToolbar,
  list,
  detail,
  empty,
}: {
  listLabel?: string
  listActions?: ReactNode
  busy?: boolean
  /** Tabs/filters/title row in the right column — same height as entity-rail-header. */
  detailToolbar?: ReactNode
  list: ReactNode
  detail: ReactNode
  /** Rendered in the list column when there are no rows — header actions stay visible. */
  empty?: ReactNode
}): JSX.Element {
  const showListHeader = Boolean(listLabel || listActions || busy)
  const listContent = empty != null ? empty : list

  return (
    <div className="entity-registry-shell grid min-h-0 flex-1 overflow-hidden">
      <aside className="entity-rail flex min-h-0 flex-col border-r border-border-subtle">
        {showListHeader && (
          <div className="entity-rail-header">
            {listLabel ? (
              <span className="entity-rail-header__label">{listLabel}</span>
            ) : null}
            <div className={`entity-rail-header__actions ${listLabel ? "" : "ml-auto"}`}>
              {busy && <Loader2 size={14} className="animate-spin text-text-muted" aria-label="Loading" />}
              {listActions}
            </div>
          </div>
        )}
        <div className="entity-rail-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          {listContent}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {detailToolbar}
        <div className={TAB_BODY}>
          <div className={TAB_BODY_INNER}>
            <div className={`${PANEL} flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-elevated/20`}>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-3">
                {detail}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** @deprecated use ItemShell */
export function SplitView({ list, detail }: { list: ReactNode; detail: ReactNode }): JSX.Element {
  return <ItemShell listLabel="" list={list} detail={detail} />
}

/** Detail pane body — same horizontal inset as entity-registry TAB_BODY. */
export function DetailPane({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={`${TAB_BODY} min-h-0 flex-1 overflow-y-auto`}>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Scrollable body for table-only panels. */
export function PanelBody({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`${TAB_BODY} min-h-0 flex-1 overflow-y-auto ${className}`}>
      {children}
    </div>
  )
}

export function DetailHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {subtitle && <p className={`${META_TEXT} mt-0.5 font-mono`}>{subtitle}</p>}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  )
}

/** Right-column toolbar row — aligns with entity-rail-header (use instead of DetailHeader above the card). */
export function DetailToolbar({
  title,
  subtitle,
  actions,
  children,
  busy,
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children?: ReactNode
  busy?: boolean
}): JSX.Element {
  return (
    <div className={`${TOOLBAR_ROW} shrink-0`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {children ?? (
          <>
            {title && <span className="text-sm font-medium text-text">{title}</span>}
            {subtitle && <span className="truncate text-xs font-mono text-text-muted">{subtitle}</span>}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {busy && <Loader2 size={14} className="animate-spin text-text-muted" aria-label="Loading" />}
        {actions}
      </div>
    </div>
  )
}

/** Grid container for KvRow children — labels and values stay adjacent, not stretched. */
export function DetailFields({ children }: { children: ReactNode }): JSX.Element {
  return (
    <dl className="grid grid-cols-[minmax(4.5rem,6.5rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5 text-sm">
      {children}
    </dl>
  )
}

/** Chevron row — matches entity-registry EntityOverviewSections list. */
export function SectionRow({
  title,
  subtitle,
  badge,
  onClick,
}: {
  title: string
  subtitle?: string
  badge?: string
  onClick: () => void
}): JSX.Element {
  return (
    <li className="border-b border-border-subtle last:border-b-0">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-elevated/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text">{title}</span>
          {subtitle && (
            <span className="mt-0.5 block truncate text-sm text-text-muted">{subtitle}</span>
          )}
        </span>
        {badge && (
          <span className="shrink-0 rounded border border-border-subtle bg-panel px-1.5 py-0.5 text-xs font-medium text-text-muted">
            {badge}
          </span>
        )}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
      </button>
    </li>
  )
}

export function Empty({
  title,
  children,
  icon,
}: {
  title: string
  children?: ReactNode
  icon?: LucideIcon
}): JSX.Element {
  const resolved =
    icon
    ?? (title.toLowerCase().startsWith("select") ? MousePointer2 : Inbox)
  return <EmptyState icon={resolved} message={title} detail={children} />
}

/** In-flight operation banner with optional cancel — used for scans, auth waits, etc. */
export function ActiveOperationBanner({
  label,
  detail,
  onCancel,
  cancelBusy,
  cancelLabel = "Cancel",
  children,
}: {
  label: string
  detail?: ReactNode
  onCancel?: () => void
  cancelBusy?: boolean
  cancelLabel?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="flex shrink-0 flex-col gap-0 border-b border-border-subtle">
      <div className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-muted">
        <Loader2 size={16} className="shrink-0 animate-spin text-accent" aria-hidden />
        <span className="min-w-0 flex-1">
          {label}
          {detail ? <span className="text-text">{detail}</span> : null}
        </span>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelBusy}
            className="shrink-0 rounded-md border border-border-subtle px-2.5 py-1 text-sm text-text-muted transition-colors hover:bg-overlay-2 hover:text-text disabled:opacity-40"
          >
            {cancelBusy ? <Loader2 size={14} className="animate-spin" /> : cancelLabel}
          </button>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/** Detail content — fills the panel card width (no max-width constraint). */
export function DetailBody({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`min-w-0 w-full ${className}`}>
      {children}
    </div>
  )
}

/** @deprecated */
export function InfoStrip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mb-3 rounded-lg border border-border-subtle bg-overlay-1/40 px-3 py-2 text-xs leading-relaxed text-text-muted">
      {children}
    </div>
  )
}

/** @deprecated use InfoStrip */
export function HelpBanner({ children }: { children: ReactNode }): JSX.Element {
  return <InfoStrip>{children}</InfoStrip>
}

export { RailEmpty, RailHeaderBtn, RailList, RailListGroup, RailListItem, TOOLBAR_ICON, ToolbarIconBtn } from "./rail"

/** @deprecated use RailList + RailListItem */
export function ItemList({ children }: { children: ReactNode }): JSX.Element {
  return <ul className="entity-rail-list">{children}</ul>
}

/** @deprecated use RailListItem */
export function ListItem({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <li className={`entity-rail-item-wrap ${active ? "entity-rail-item-wrap--active" : ""}`}>
      <div className="entity-rail-item-row">
        <button type="button" onClick={onClick} className="entity-rail-item min-w-0 flex-1 text-left">
          {children}
        </button>
      </div>
    </li>
  )
}

/** Label/value pair — use inside DetailFields. */
export function KvRow({
  icon: Icon,
  label,
  value,
  mono = true,
}: {
  icon?: ComponentType<{ size?: number; className?: string }>
  label: string
  value: ReactNode
  mono?: boolean
}): JSX.Element {
  const display = value === null || value === undefined || value === "" ? "—" : value
  return (
    <>
      <dt className="flex items-center gap-1.5 text-text-muted">
        {Icon && <Icon size={12} className="shrink-0 opacity-50" />}
        {label}
      </dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-text" : "text-text"}`}>
        {display}
      </dd>
    </>
  )
}

export function DetailRow({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted/80">{label}</dt>
      <dd className="text-sm text-text break-all">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </>
  )
}

export function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <IconButton label={label} onClick={onClick} disabled={disabled}>
      {children}
    </IconButton>
  )
}

export function AdminInlineForm({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`flex flex-wrap items-end gap-3 rounded-lg border border-border-subtle bg-overlay-1/40 p-4 text-sm ${className}`}>
      {children}
    </div>
  )
}

export function AdminTable({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <table className={`w-full min-w-[640px] border-collapse text-sm ${className}`}>
      {children}
    </table>
  )
}

export function AdminTh({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <th className={`px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted/80 whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

export function AdminTd({ children, className = "", colSpan, title }: { children: ReactNode; className?: string; colSpan?: number; title?: string }): JSX.Element {
  return (
    <td colSpan={colSpan} title={title} className={`border-t border-border-subtle px-3 py-2 align-middle ${className}`}>
      {children}
    </td>
  )
}

export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="field-label mb-1">{children}</h3>
}

/** Card-layout labeled checkbox for admin forms (h-auto — never stretch in split panes). */
export function FormCheck({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  hint?: string
}): JSX.Element {
  return (
    <LabeledCheckbox
      layout="card"
      label={label}
      hint={hint}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

export function ToolbarPrimary({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <IconButton label={label} variant="primary" onClick={onClick} disabled={disabled}>
      {children}
    </IconButton>
  )
}

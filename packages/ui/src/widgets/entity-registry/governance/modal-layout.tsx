/**
 * Shared split-pane modal layout for entity-registry governance editors.
 */

import { Search, X } from "lucide-react"
import type { JSX, ReactNode } from "react"

import { FORM_HEADING, HELP_TEXT, META_TEXT, PANEL } from "../chrome"

export { FormFieldGroup, FormSectionCard } from "../form-section"

const CANVAS_MAX_W = {
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  full: "max-w-none",
} as const

export function AdminModalRoot({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="entity-registry relative flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  )
}

export function AdminModalIntro({
  description,
  children,
}: {
  description?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="shrink-0 space-y-2 border-b border-border-subtle px-5 py-3">
      {children}
      {description ? (
        <p className={`${META_TEXT} max-w-3xl leading-relaxed text-text-faint`}>{description}</p>
      ) : null}
    </div>
  )
}

export function AdminModalCanvas({
  children,
  width = "full",
}: {
  children: ReactNode
  width?: keyof typeof CANVAS_MAX_W
}): JSX.Element {
  const narrow = width !== "full"
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-base/20">
      <div
        className={[
          "w-full space-y-3 p-5",
          narrow ? `mx-auto ${CANVAS_MAX_W[width]}` : "",
        ].join(" ")}
      >
        {children}
      </div>
    </div>
  )
}

export function AdminModalSplit({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      {children}
    </div>
  )
}

export function AdminModalRail({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-hidden border-b border-border-subtle p-5 lg:min-h-[28rem] lg:border-b-0 lg:border-r">
      {children}
    </div>
  )
}

export function AdminModalEditor({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:min-h-[28rem]">{children}</div>
}

export function AdminModalEditorHeader({
  eyebrow,
  title,
  hint,
  badge,
  actions,
}: {
  eyebrow: string
  title: string
  hint?: string
  badge?: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="shrink-0 border-b border-border-subtle bg-elevated/40 px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-faint">{eyebrow}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className={FORM_HEADING}>{title}</h3>
            {badge}
          </div>
          {hint ? <p className={`${META_TEXT} mt-1 font-mono`}>{hint}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  )
}

export function AdminModalEditorBody({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-base/20 p-5">
      <div className="space-y-3">{children}</div>
    </div>
  )
}

export function AdminModalEmpty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-[12rem] flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className={`${HELP_TEXT} max-w-sm text-text-muted`}>{children}</p>
    </div>
  )
}

export function AdminRailSection({
  title,
  children,
  grow = false,
}: {
  title: string
  children: ReactNode
  grow?: boolean
}): JSX.Element {
  return (
    <section className={grow ? "flex min-h-0 flex-1 flex-col gap-2" : "shrink-0 space-y-2"}>
      <h4 className="field-label shrink-0">{title}</h4>
      {children}
    </section>
  )
}

export function AdminRailList({
  items,
  selectedId,
  onSelect,
  onDelete,
  query,
  onQueryChange,
  searchPlaceholder = "Search…",
  emptyLabel = "None yet.",
}: {
  items: Array<{ id: string; label: string; hint?: string; builtIn?: boolean }>
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  query: string
  onQueryChange: (query: string) => void
  searchPlaceholder?: string
  emptyLabel?: string
}): JSX.Element {
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? items.filter(
        (item) =>
          item.id.toLowerCase().includes(trimmed)
          || item.label.toLowerCase().includes(trimmed)
          || item.hint?.toLowerCase().includes(trimmed),
      )
    : items

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="input flex shrink-0 items-center gap-2 py-0 pl-2.5 pr-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm outline-none focus:ring-0"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-elevated hover:text-text"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" aria-hidden />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <p className="text-sm text-text-muted">{emptyLabel}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-text-muted">No matches.</p>
        ) : (
          <ul className={PANEL}>
            {filtered.map((item, index) => (
              <li
                key={item.id}
                className={[
                  "flex items-center gap-2 px-3 py-2 text-sm",
                  index < filtered.length - 1 ? "border-b border-border/20" : "",
                  selectedId === item.id ? "bg-elevated" : "",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                >
                  <span className="min-w-0 truncate font-medium text-text">{item.label}</span>
                  {item.hint ? <span className={`font-mono ${META_TEXT}`}>{item.hint}</span> : null}
                </button>
                {onDelete && !item.builtIn ? (
                  <button
                    type="button"
                    onClick={() => onDelete(item.id)}
                    className="shrink-0 rounded p-1 text-text-muted hover:bg-error/10 hover:text-error"
                    aria-label={`Delete ${item.label}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

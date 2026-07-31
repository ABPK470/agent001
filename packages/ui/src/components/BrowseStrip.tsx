/**
 * Browse strip — one dialect for modals and (count slot) widgets.
 *
 * Layout:  [ search ············ ] [ count ] [ icon… ]
 *
 * Stability rules (hard):
 * - Search flexes; trailing never shrinks under it.
 * - Count reserves digit columns (tabular-nums) so growing 9→99 does not shove icons.
 * - Icon buttons are always `--control-h` squares — add/remove icons without
 *   changing control height or search geometry.
 *
 * Modal inset (`BrowseStrip`) owns px-6. Widget shells keep using WidgetToolbar
 * for leading/search chrome; they share `BrowseCount` / icon height tokens.
 */

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  JSX,
  ReactNode,
  Ref,
} from "react"
import { ModalSearchField } from "./ModalSearchField"

const BROWSE_ICON_BTN =
  "browse-icon-btn mia-control relative flex h-[var(--control-h)] w-[var(--control-h)] shrink-0 items-center justify-center"
const BROWSE_ICON_BTN_ACTIVE = "border-border-strong text-text"

/** Digits to reserve so “9” and “999” share the same count slot width. */
export function browseCountDigitSlots(filtered: number, total: number, min = 2): number {
  const widest = Math.max(filtered, total, 0)
  return Math.max(min, String(widest).length)
}

export function BrowseStrip({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={["browse-strip", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  )
}

export function BrowseStripSearch({ children }: { children: ReactNode }): JSX.Element {
  return <div className="browse-strip__search">{children}</div>
}

export function BrowseStripTrailing({ children }: { children: ReactNode }): JSX.Element {
  return <div className="browse-strip__trailing">{children}</div>
}

/** Modal search at `--control-h` — same optical size as strip icon buttons. */
export function BrowseSearchField({
  value,
  onChange,
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  "aria-label": string
}): JSX.Element {
  return (
    <ModalSearchField
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  )
}

/**
 * Filtered / total — reserved width so trailing icons don’t jump.
 * Single tally (5) uses one tight slot; filtered/total (3/12) uses two digit columns.
 * `compact` drops the reserve (icon+count clusters like Active Users).
 */
export function BrowseCount({
  filtered,
  total,
  hidden,
  compact,
  emptyLabel,
  text,
}: {
  filtered: number
  total: number
  hidden?: boolean
  compact?: boolean
  /** When total is 0, show this instead of `0` (e.g. Sync History “No runs”). */
  emptyLabel?: string
  /** Freeform label — still sits in a reserved slot. */
  text?: string
}): JSX.Element | null {
  if (hidden) return null

  if (text != null) {
    const slots = Math.min(14, Math.max(4, text.length))
    const style: CSSProperties | undefined = compact
      ? undefined
      : ({ ["--browse-count-slots" as string]: String(slots) } as CSSProperties)
    return (
      <span
        className={`browse-count browse-count--text${compact ? " browse-count--compact" : ""}`}
        style={style}
        aria-label={text}
      >
        {text}
      </span>
    )
  }

  if (emptyLabel != null && total === 0) {
    return (
      <span
        className={`browse-count browse-count--text${compact ? " browse-count--compact" : ""}`}
        aria-label={emptyLabel}
      >
        {emptyLabel}
      </span>
    )
  }

  const split = filtered !== total
  const slots = browseCountDigitSlots(filtered, total)
  const style: CSSProperties | undefined = compact
    ? undefined
    : ({ ["--browse-count-slots" as string]: String(slots) } as CSSProperties)

  return (
    <span
      className={[
        "browse-count",
        split ? "browse-count--split" : "browse-count--single",
        compact ? "browse-count--compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-label={`${filtered} of ${total} shown`}
    >
      {split ? (
        <>
          <span className="browse-count__filtered">{filtered}</span>
          <span className="browse-count__sep">/</span>
          <span className="browse-count__total">{total}</span>
        </>
      ) : (
        <span className="browse-count__total">{total}</span>
      )}
    </span>
  )
}

export function BrowseIconButton({
  active,
  badge,
  className,
  buttonRef,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  badge?: number | string | null
  buttonRef?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={[
        BROWSE_ICON_BTN,
        active ? BROWSE_ICON_BTN_ACTIVE : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
      {badge != null && badge !== "" && badge !== 0 && (
        <span className="browse-icon-btn__badge" aria-hidden>
          {typeof badge === "number" && badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  )
}

/**
 * DateField — theme-aware date picker with calendar popover.
 * Matches Listbox trigger + listbox-popover styling.
 */

import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react"
import { createPortal } from "react-dom"
import { popoverZIndex } from "../lib/modal-stack"
import {
  claimPopoverOpen,
  registerPopoverInstance,
  releasePopoverOpen,
} from "../lib/popover-dismiss"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value || !ISO_DATE.test(value)) return null
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDisplay(value: string | undefined): string | null {
  const date = parseIsoDate(value)
  if (!date) return null
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function buildCalendarDays(viewMonth: Date): Array<{ date: Date; inMonth: boolean }> {
  const month = viewMonth.getMonth()
  const first = startOfMonth(viewMonth)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  const days: Array<{ date: Date; inMonth: boolean }> = []
  for (let i = 0; i < 42; i++) {
    const date = new Date(start)
    date.setDate(start.getDate() + i)
    days.push({ date, inMonth: date.getMonth() === month })
  }
  return days
}

export function DateField({
  value,
  onChange,
  placeholder = "Select date…",
  ariaLabel,
  disabled,
  className = "",
  size = "sm",
}: {
  value?: string
  onChange: (value: string | undefined) => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  className?: string
  size?: "sm" | "md"
}): JSX.Element {
  const instanceId = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => parseIsoDate(value) ?? new Date())
  const [popPos, setPopPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)

  const selected = parseIsoDate(value)
  const today = useMemo(() => new Date(), [])
  const days = useMemo(() => buildCalendarDays(viewMonth), [viewMonth])
  const label = formatDisplay(value)

  const closePopover = useCallback((): void => {
    setOpen(false)
    releasePopoverOpen(instanceId)
  }, [instanceId])

  const openPopover = useCallback((): void => {
    claimPopoverOpen(instanceId)
    setViewMonth(parseIsoDate(value) ?? new Date())
    setOpen(true)
  }, [instanceId, value])

  useEffect(() => registerPopoverInstance(instanceId, closePopover), [instanceId, closePopover])

  const updatePopPos = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setPopPos({
      top: Math.round(rect.bottom + 4),
      left: Math.round(rect.left),
      minWidth: Math.round(rect.width),
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPopPos(null)
      return
    }
    updatePopPos()
  }, [open, updatePopPos])

  useEffect(() => {
    if (!open) return
    const onReposition = () => updatePopPos()
    window.addEventListener("resize", onReposition)
    window.addEventListener("scroll", onReposition, true)
    return () => {
      window.removeEventListener("resize", onReposition)
      window.removeEventListener("scroll", onReposition, true)
    }
  }, [open, updatePopPos])

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent): void {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popRef.current?.contains(e.target as Node)) return
      closePopover()
    }
    document.addEventListener("click", handle)
    return () => document.removeEventListener("click", handle)
  }, [open, closePopover])

  function pickDate(date: Date): void {
    onChange(toIsoDate(date))
    closePopover()
    btnRef.current?.focus()
  }

  function shiftMonth(delta: number): void {
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1))
  }

  const sizeCls = size === "md" ? "px-3 py-2 text-sm" : "px-2.5 py-1.5 text-sm"

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ?? placeholder}
        onClick={() => {
          if (disabled) return
          if (open) closePopover()
          else openPopover()
        }}
        className={[
          "listbox-control group flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-base text-left text-text transition-colors",
          "hover:bg-elevated hover:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent/40",
          "disabled:cursor-not-allowed disabled:opacity-40",
          sizeCls,
          className,
        ].join(" ")}
      >
        <Calendar size={14} className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate leading-snug">
          {label ?? <span className="text-text-muted">{placeholder}</span>}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && popPos && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: popoverZIndex() - 1, pointerEvents: "none" }} aria-hidden />
          <div
            ref={popRef}
            role="dialog"
            aria-label={ariaLabel ?? "Choose date"}
            className="listbox-popover fixed rounded-md p-3"
            style={{
              top: popPos.top,
              left: popPos.left,
              minWidth: Math.max(popPos.minWidth, 280),
              zIndex: popoverZIndex(),
            }}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <button
                type="button"
                className="rounded p-1 text-text-muted transition-colors hover:bg-elevated hover:text-text"
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-medium text-text">
                {viewMonth.toLocaleDateString([], { month: "long", year: "numeric" })}
              </span>
              <button
                type="button"
                className="rounded p-1 text-text-muted transition-colors hover:bg-elevated hover:text-text"
                aria-label="Next month"
                onClick={() => shiftMonth(1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div className="mb-1 grid grid-cols-7 gap-1">
              {WEEKDAYS.map((day) => (
                <div key={day} className="py-1 text-center text-[11px] font-medium uppercase tracking-wide text-text-muted/60">
                  {day}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {days.map(({ date, inMonth }) => {
                const iso = toIsoDate(date)
                const isSelected = selected ? sameDay(date, selected) : false
                const isToday = sameDay(date, today)
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={!inMonth}
                    onClick={() => pickDate(date)}
                    className={[
                      "h-8 rounded-md text-sm transition-colors",
                      !inMonth ? "text-text-muted/25" : "text-text hover:bg-elevated",
                      isSelected ? "bg-accent text-text-on-accent hover:bg-accent/90" : "",
                      isToday && !isSelected ? "ring-1 ring-accent/40" : "",
                    ].join(" ")}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
              <button
                type="button"
                className="rounded-md px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-elevated hover:text-text"
                onClick={() => pickDate(today)}
              >
                Today
              </button>
              {value && (
                <button
                  type="button"
                  className="rounded-md px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-elevated hover:text-text"
                  onClick={() => {
                    onChange(undefined)
                    closePopover()
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

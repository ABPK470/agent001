/**
 * IOE reusable primitive components and hooks.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { cloneElement, useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { C } from "./constants"

// ── useResizable — drag-to-resize hook ───────────────────────────

export function useResizable(
  initial: number,
  direction: "horizontal" | "vertical",
  invert = false,
) {
  const [size, setSize] = useState(initial)
  const dragging = useRef(false)
  const startPos = useRef(0)
  const startSize = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      startPos.current = direction === "horizontal" ? e.clientX : e.clientY
      startSize.current = size

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const raw = (direction === "horizontal" ? ev.clientX : ev.clientY) - startPos.current
        const delta = invert ? -raw : raw
        setSize(Math.max(40, startSize.current + delta))
      }
      const onMouseUp = () => {
        dragging.current = false
        document.removeEventListener("mousemove", onMouseMove)
        document.removeEventListener("mouseup", onMouseUp)
      }
      document.addEventListener("mousemove", onMouseMove)
      document.addEventListener("mouseup", onMouseUp)
    },
    [size, direction, invert],
  )

  return { size, onMouseDown, setSize }
}

// ── Tip — inline hover reveal for truncated text (VS Code style) ─

export function Tip({ text, children }: { text: string; children: React.ReactElement }) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const show = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    // Only show if text is actually truncated
    if (el.scrollWidth <= el.clientWidth + 1) return
    clearTimeout(timerRef.current)
    const r = el.getBoundingClientRect()
    timerRef.current = setTimeout(() => setRect(r), 150)
  }, [])

  const hide = useCallback(() => {
    clearTimeout(timerRef.current)
    setRect(null)
  }, [])

  // Dismiss on scroll anywhere
  useEffect(() => {
    if (!rect) return
    const dismiss = () => setRect(null)
    window.addEventListener("scroll", dismiss, true)
    return () => window.removeEventListener("scroll", dismiss, true)
  }, [rect])

  // Clone child to inject event handlers directly onto the truncated element
  const child = cloneElement(children, {
    onMouseEnter: show,
    onMouseLeave: hide,
  } as React.HTMLAttributes<HTMLElement>)

  return (
    <>
      {child}
      {rect && createPortal(
        <div
          onMouseLeave={hide}
          style={{
            position: "fixed",
            // Align to the same row — same Y, starts at the text's left edge
            left: rect.left,
            top: rect.top,
            maxWidth: Math.max(360, window.innerWidth - rect.left - 12),
            minHeight: rect.height,
            display: "flex",
            alignItems: "center",
            padding: "1px 10px 1px 0",
            borderRadius: 3,
            background: C.elevated,
            border: `1px solid ${C.borderSolid}`,
            boxShadow: "0 2px 8px rgba(0,0,0,0.36)",
            color: C.text,
            fontSize: 13,
            lineHeight: "1.4",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            zIndex: 9999,
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}

// ── TreeSection — collapsible section header ─────────────────────

export function TreeSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        className="w-full flex items-center gap-1 px-2 py-1 text-[13px] uppercase tracking-wide hover:bg-white/[0.03] transition-colors font-semibold cursor-pointer"
        style={{ color: C.muted }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && children}
    </div>
  )
}

// ── TreeItem — key-value row in a tree ───────────────────────────

export function TreeItem({
  label,
  value,
  valueColor,
}: {
  label: string
  value: string
  valueColor?: string
}) {
  return (
    <div className="flex items-baseline gap-2 px-4 py-0.5 text-[13px] min-w-0">
      <span className="shrink-0" style={{ color: C.muted }}>{label}</span>
      <Tip text={value}>
        <span
          className="truncate min-w-0"
          style={{ color: valueColor ?? C.textSecondary }}
        >
          {value}
        </span>
      </Tip>
    </div>
  )
}

// ── KV — inline key-value pair ───────────────────────────────────

export function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ color: C.text }}>{value}</span>
    </div>
  )
}

// ── ActionBtn — colored action button ────────────────────────────

export function ActionBtn({
  label,
  color,
  onClick,
}: {
  label: string
  color: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-0.5 rounded text-[13px] font-medium transition-colors cursor-pointer"
      style={{ background: color + "18", color, border: `1px solid ${color}30` }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = color + "35"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = color + "18"
      }}
    >
      {label}
    </button>
  )
}

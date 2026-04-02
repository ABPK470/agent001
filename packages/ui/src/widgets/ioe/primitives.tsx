/**
 * IOE reusable primitive components and hooks.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { useCallback, useRef, useState } from "react"
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
    <div className="flex items-baseline gap-2 px-4 py-0.5 text-[13px]">
      <span style={{ color: C.muted }}>{label}</span>
      <span className="truncate" style={{ color: valueColor ?? C.textSecondary }}>
        {value}
      </span>
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

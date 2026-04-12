/**
 * IOE reusable primitive components and hooks.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { cloneElement, createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
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

// ── Tip — VS Code-style hover bubble for truncated text ─────────
//
// Shared bubble: all Tip instances feed into a single TipBubble portal.
// Moving the cursor between rows smoothly updates the bubble position and
// content without any pop-out / pop-in flicker.

type TipState = { text: string; x: number; y: number; arrowY: number } | null

const TipCtx = createContext<{
  show: (text: string, el: HTMLElement) => void
  hide: (id: number) => void
  nextId: () => number
}>({ show: () => {}, hide: () => {}, nextId: () => 0 })

/** Wrap the sidebar (or any region) in TipProvider so Tip instances share one bubble. */
export function TipProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TipState>(null)
  const stateRef = useRef<TipState>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const activeId = useRef(0)
  const idCounter = useRef(0)

  // Keep ref in sync with state
  stateRef.current = state

  const nextId = useCallback(() => ++idCounter.current, [])

  const show = useCallback((text: string, el: HTMLElement) => {
    const id = idCounter.current
    activeId.current = id
    clearTimeout(timerRef.current)

    const update = () => {
      const r = el.getBoundingClientRect()
      let sidebar = el.parentElement
      while (sidebar && !sidebar.getAttribute("data-sidebar-panel")) sidebar = sidebar.parentElement
      const right = sidebar ? sidebar.getBoundingClientRect().right : r.right
      setState({ text, x: right + 8, y: r.top + r.height / 2, arrowY: r.top + r.height / 2 })
    }

    // If bubble is already visible, update immediately (no delay when moving between rows)
    if (stateRef.current) {
      update()
    } else {
      timerRef.current = setTimeout(update, 1000)
    }
  }, [])

  const hide = useCallback((id: number) => {
    // Only hide if the caller is still the active one (not superseded by a new row)
    if (id !== activeId.current) return
    clearTimeout(timerRef.current)
    // Small grace period so moving between adjacent rows doesn't flash
    timerRef.current = setTimeout(() => {
      if (id === activeId.current) setState(null)
    }, 120)
  }, [])

  // Dismiss on scroll
  useEffect(() => {
    if (!state) return
    const dismiss = () => { clearTimeout(timerRef.current); setState(null) }
    window.addEventListener("scroll", dismiss, true)
    return () => window.removeEventListener("scroll", dismiss, true)
  }, [state])

  const bubbleMaxH = 200
  const clampedTop = state ? Math.min(state.y - 14, window.innerHeight - bubbleMaxH - 12) : 0
  const arrowOffset = state ? state.arrowY - clampedTop : 0

  return (
    <TipCtx.Provider value={{ show, hide, nextId }}>
      {children}
      {state && createPortal(
        <div style={{ position: "fixed", left: state.x, top: clampedTop, zIndex: 9999, pointerEvents: "none" }}>
          {/* Chevron arrow */}
          <div style={{ position: "absolute", left: -6, top: arrowOffset - 6, width: 0, height: 0, borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderRight: `6px solid ${C.borderSolid}` }} />
          <div style={{ position: "absolute", left: -5, top: arrowOffset - 6, width: 0, height: 0, borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderRight: `6px solid ${C.elevated}` }} />
          {/* Bubble */}
          <div style={{
            maxWidth: 380, padding: "8px 12px", borderRadius: 6,
            background: C.elevated, border: `1px solid ${C.borderSolid}`,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)", color: C.text,
            fontSize: 13, lineHeight: "1.55", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {state.text}
          </div>
        </div>,
        document.body,
      )}
    </TipCtx.Provider>
  )
}

/** Wrap a truncated element — shows the shared bubble on hover. */
export function Tip({ text, children }: { text: string; children: React.ReactElement }) {
  const { show, hide, nextId } = useContext(TipCtx)
  const idRef = useRef(0)

  const onEnter = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    if (el.scrollWidth <= el.clientWidth + 1) return
    idRef.current = nextId()
    show(text, el)
  }, [text, show, nextId])

  const onLeave = useCallback(() => {
    hide(idRef.current)
  }, [hide])

  return cloneElement(children, {
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
  } as React.HTMLAttributes<HTMLElement>)
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

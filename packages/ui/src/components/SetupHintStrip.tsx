/**
 * SetupHintStrip — persistent “something needs attention” strip.
 *
 * Two placements:
 * - flush (default) — edge-to-edge under modal chrome; header wash via SetupHintChromeProvider
 * - inset — rounded card inside widget panels (matches panel border-radius)
 *
 * Prefer `open={…}` over conditional mount so height + header wash ease in/out.
 */

import type { LucideIcon } from "lucide-react"
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react"

export type SetupHintTone = "warning" | "muted"
export type SetupHintPlacement = "flush" | "inset"

type ChromeHintApi = {
  push: (tone: SetupHintTone) => void
  pop: (tone: SetupHintTone) => void
}

const ChromeHintApiContext = createContext<ChromeHintApi | null>(null)
const ChromeHintToneContext = createContext<SetupHintTone | null>(null)

/** Snappy ease — present, not sluggish. */
const STRIP_MOTION =
  "transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"

const STRIP_FADE =
  "transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"

function effectiveTone(stack: readonly SetupHintTone[]): SetupHintTone | null {
  if (stack.includes("warning")) return "warning"
  if (stack.length > 0) return "muted"
  return null
}

/** Header wash — always include color transition so appear/clear is not a snap. */
export function setupHintHeaderClass(tone: SetupHintTone | null): string {
  const wash =
    tone === "warning"
      ? "bg-warning/10"
      : tone === "muted"
        ? "bg-panel-2"
        : "bg-transparent"
  return `transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${wash}`
}

/**
 * Own widget/modal chrome headers so a mounted SetupHintStrip can paint
 * the title bar with the same tone (continuous band, not cut under the header).
 */
export function SetupHintChromeProvider({ children }: { children: ReactNode }): JSX.Element {
  const stackRef = useRef<SetupHintTone[]>([])
  const [tone, setTone] = useState<SetupHintTone | null>(null)

  const api = useMemo<ChromeHintApi>(() => ({
    push(next) {
      stackRef.current = [...stackRef.current, next]
      setTone(effectiveTone(stackRef.current))
    },
    pop(next) {
      const stack = stackRef.current
      const idx = stack.lastIndexOf(next)
      if (idx < 0) return
      stackRef.current = [...stack.slice(0, idx), ...stack.slice(idx + 1)]
      setTone(effectiveTone(stackRef.current))
    },
  }), [])

  return (
    <ChromeHintApiContext.Provider value={api}>
      <ChromeHintToneContext.Provider value={tone}>
        {children}
      </ChromeHintToneContext.Provider>
    </ChromeHintApiContext.Provider>
  )
}

/** Current chrome wash tone (null when no strip is open). */
export function useSetupHintChromeTone(): SetupHintTone | null {
  return useContext(ChromeHintToneContext)
}

export function SetupHintStrip({
  open = true,
  tone = "warning",
  placement = "flush",
  icon: Icon,
  children,
  className = "",
  actions,
}: {
  /** When false, collapses smoothly (prefer over conditional unmount). */
  open?: boolean
  tone?: SetupHintTone
  /** flush = modal band under header; inset = rounded card in widget panels */
  placement?: SetupHintPlacement
  icon?: LucideIcon
  children: ReactNode
  /** Extra classes (e.g. denser `px-3` in compact widgets). */
  className?: string
  actions?: ReactNode
}): JSX.Element {
  const chrome = useContext(ChromeHintApiContext)
  const inset = placement === "inset"

  useLayoutEffect(() => {
    if (!chrome || !open || inset) return
    chrome.push(tone)
    return () => chrome.pop(tone)
  }, [chrome, tone, open, inset])

  const toneClass =
    tone === "warning"
      ? "setup-hint-strip--warning bg-warning/10 text-text"
      : "setup-hint-strip--muted bg-panel-2 text-text-muted"

  const placementClass = inset
    ? "setup-hint-strip--inset"
    : "setup-hint-strip--flush border-b"

  const borderToneClass = inset
    ? tone === "warning"
      ? "border-warning/40"
      : "border-border-subtle"
    : tone === "warning"
      ? "border-warning/40"
      : "border-border-subtle"

  const padClass = inset ? "px-3 py-2" : "px-5 py-2.5"

  return (
    <div
      className={[
        "grid shrink-0",
        STRIP_MOTION,
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      ].join(" ")}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role="status"
          aria-live="polite"
          className={[
            "setup-hint-strip text-sm",
            padClass,
            STRIP_FADE,
            open ? "opacity-100" : "opacity-0",
            toneClass,
            placementClass,
            borderToneClass,
            inset ? "border" : "",
            className,
          ].join(" ")}
        >
          <div className="flex items-start gap-2.5">
            {Icon ? (
              <Icon
                size={16}
                className={[
                  "mt-0.5 shrink-0",
                  tone === "warning" ? "text-warning" : "text-text-muted",
                ].join(" ")}
                aria-hidden
              />
            ) : null}
            <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Shared zen surface — Z toggles focus; Esc exits after optional overlays.
 * Claims an OperatorSurface; composition root owns the window listener.
 */

import { useRef, type RefObject } from "react"
import type { OperatorSurfaceHandler } from "../lib/operator-surface"
import { useClaimOperatorSurface } from "./useClaimOperatorSurface"

export function useWidgetZenHotkeys({
  enabled,
  surfaceId,
  isZen,
  onToggleZen,
  onExitZen,
  onEscapeBeforeExit,
  /** When false, Esc is owned elsewhere (e.g. Trace Esc ladder). Default true. */
  handleEscape = true,
  /** Extra chords before Z/Esc (e.g. Active Users search). */
  beforeRef,
}: {
  enabled: boolean
  surfaceId: string
  isZen: boolean
  onToggleZen: () => void
  onExitZen: () => void
  /** Return true when Escape dismissed an overlay — do not exit zen. */
  onEscapeBeforeExit?: () => boolean
  handleEscape?: boolean
  beforeRef?: RefObject<OperatorSurfaceHandler | null>
}) {
  const isZenRef = useRef(isZen)
  const handleEscapeRef = useRef(handleEscape)
  const onToggleZenRef = useRef(onToggleZen)
  const onExitZenRef = useRef(onExitZen)
  const onEscapeBeforeExitRef = useRef(onEscapeBeforeExit)
  isZenRef.current = isZen
  handleEscapeRef.current = handleEscape
  onToggleZenRef.current = onToggleZen
  onExitZenRef.current = onExitZen
  onEscapeBeforeExitRef.current = onEscapeBeforeExit

  const onKeyDownRef = useRef<OperatorSurfaceHandler | null>(null)
  onKeyDownRef.current = (event) => {
    if (beforeRef?.current?.(event)) return true

    const key = event.key.toLowerCase()
    const mod = event.metaKey || event.ctrlKey

    if (key === "z" && !mod && !event.altKey && !event.shiftKey) {
      if (isZenRef.current) onExitZenRef.current()
      else onToggleZenRef.current()
      return true
    }

    if (!handleEscapeRef.current || !isZenRef.current) return false

    if (event.key === "Escape") {
      if (onEscapeBeforeExitRef.current?.()) return true
      onExitZenRef.current()
      return true
    }

    return false
  }

  useClaimOperatorSurface(enabled, surfaceId, onKeyDownRef)
}

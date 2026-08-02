/**
 * Shared zen hotkeys — Z toggles focus; Esc exits after optional overlays.
 */

import { useEffect } from "react"
import { isEditableKeyboardTarget } from "../lib/keyboard-target"

export function useWidgetZenHotkeys({
  enabled,
  isZen,
  onToggleZen,
  onExitZen,
  onEscapeBeforeExit,
}: {
  enabled: boolean
  isZen: boolean
  onToggleZen: () => void
  onExitZen: () => void
  /** Return true when Escape dismissed an overlay — do not exit zen. */
  onEscapeBeforeExit?: () => boolean
}) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return

      const key = event.key.toLowerCase()
      const mod = event.metaKey || event.ctrlKey

      if (key === "z" && !mod && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        if (isZen) onExitZen()
        else onToggleZen()
        return
      }

      if (!isZen) return

      if (event.key === "Escape") {
        if (onEscapeBeforeExit?.()) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        onExitZen()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, isZen, onEscapeBeforeExit, onExitZen, onToggleZen])
}

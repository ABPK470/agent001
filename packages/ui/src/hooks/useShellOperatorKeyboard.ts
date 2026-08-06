/**
 * Shell Layer 1 — Call Space, tile focus, maximize, close tile, keymap (?).
 * Summon (⌘K) is wired in App. Z stays on widget zen hooks.
 */

import { useEffect } from "react"
import { isEditableKeyboardTarget } from "../lib/keyboard-target"
import { resolveShellKeyboardAction } from "../lib/keymap"
import { neighborViewId } from "../lib/view-tab-nav"
import { useLayoutStore } from "../state/layout-store"
import { useStore } from "../state/store"

export function useShellOperatorKeyboard(enabled: boolean) {
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const views = useLayoutStore((s) => s.views)
  const callSpace = useLayoutStore((s) => s.callSpace)
  const setActiveView = useLayoutStore((s) => s.setActiveView)
  const focusTileNeighbor = useLayoutStore((s) => s.focusTileNeighbor)
  const toggleTileMaximized = useLayoutStore((s) => s.toggleTileMaximized)
  const removeWidget = useLayoutStore((s) => s.removeWidget)
  const ensureProductSpaces = useLayoutStore((s) => s.ensureProductSpaces)
  const summonOpen = useStore((s) => s.summonOpen)
  const keymapSheetOpen = useStore((s) => s.keymapSheetOpen)
  const setKeymapSheetOpen = useStore((s) => s.setKeymapSheetOpen)
  const modalWidget = useStore((s) => s.modalWidget)
  const closeModalWidget = useStore((s) => s.closeModalWidget)
  const requestWorkspaceShell = useStore((s) => s.requestWorkspaceShell)
  const requestChatShell = useStore((s) => s.requestChatShell)

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return

      // Esc: dismiss summon / peek when shell owns them (widget ladder runs too;
      // stop if we consume).
      if (event.key === "Escape") {
        // Keymap / Summon own Esc (clear filter → close). Do not steal it here.
        if (keymapSheetOpen || summonOpen) return
        if (modalWidget) {
          event.preventDefault()
          event.stopPropagation()
          closeModalWidget()
          return
        }
      }

      if (summonOpen || keymapSheetOpen || modalWidget) return

      const action = resolveShellKeyboardAction(event, {
        hasFocusedTile: Boolean(focusedTileId),
      })
      if (action.type === "none") return

      event.preventDefault()
      event.stopPropagation()

      if (action.type === "open-keymap") {
        setKeymapSheetOpen(true)
        return
      }
      if (action.type === "focus-composer") {
        requestChatShell()
        return
      }
      if (action.type === "call-space") {
        ensureProductSpaces()
        requestWorkspaceShell()
        callSpace(action.index)
        return
      }
      if (action.type === "cycle-view") {
        const nextId = neighborViewId(views, activeViewId, action.direction)
        if (!nextId) return
        requestWorkspaceShell()
        setActiveView(nextId)
        return
      }
      if (action.type === "focus-tile-neighbor") {
        focusTileNeighbor(action.key)
        return
      }
      if (!focusedTileId) return
      if (action.type === "toggle-maximize") {
        toggleTileMaximized(activeViewId, focusedTileId)
        return
      }
      if (action.type === "close-tile") {
        removeWidget(activeViewId, focusedTileId)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    activeViewId,
    callSpace,
    closeModalWidget,
    enabled,
    ensureProductSpaces,
    focusTileNeighbor,
    focusedTileId,
    keymapSheetOpen,
    modalWidget,
    removeWidget,
    requestChatShell,
    requestWorkspaceShell,
    setActiveView,
    setKeymapSheetOpen,
    summonOpen,
    toggleTileMaximized,
    views,
  ])
}

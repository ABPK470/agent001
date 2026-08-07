/**
 * Composition root — one capture-phase keydown for shell chrome + claimed surface.
 * Widgets do not register window listeners; they claim an OperatorSurface.
 */

import { useEffect, useRef } from "react"
import { isEditableKeyboardTarget } from "../lib/keyboard-target"
import {
  isOpenWidgetCatalogEvent,
  isShellModeToggleEvent,
  resolveOperatorSession,
  resolveShellKeyboardAction,
} from "../lib/keymap"
import { getActiveOperatorSurface } from "../lib/operator-surface"
import { neighborViewId } from "../lib/view-tab-nav"
import { captureSoloFlipForTileId } from "../app/workspace/layout/solo-flip"
import { useLayoutStore } from "../state/layout-store"
import { useStore } from "../state/store"

export function useOperatorKeyboardRoot(
  enabled: boolean,
  peers: {
    onToggleShellMode: () => void
    onToggleSummon: () => void
  },
) {
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

  const focusedTileIdRef = useRef(focusedTileId)
  const activeViewIdRef = useRef(activeViewId)
  const viewsRef = useRef(views)
  focusedTileIdRef.current = focusedTileId
  activeViewIdRef.current = activeViewId
  viewsRef.current = views

  const summonOpenRef = useRef(summonOpen)
  const keymapSheetOpenRef = useRef(keymapSheetOpen)
  const modalWidgetRef = useRef(modalWidget)
  summonOpenRef.current = summonOpen
  keymapSheetOpenRef.current = keymapSheetOpen
  modalWidgetRef.current = modalWidget

  const onToggleShellModeRef = useRef(peers.onToggleShellMode)
  const onToggleSummonRef = useRef(peers.onToggleSummon)
  onToggleShellModeRef.current = peers.onToggleShellMode
  onToggleSummonRef.current = peers.onToggleSummon

  useEffect(() => {
    if (!enabled) return

    function applyShell(
      event: KeyboardEvent,
      action: Exclude<ReturnType<typeof resolveShellKeyboardAction>, { type: "none" }>,
    ): boolean {
      const tileId = focusedTileIdRef.current
      const viewId = activeViewIdRef.current

      event.preventDefault()
      event.stopPropagation()

      if (action.type === "open-keymap") {
        setKeymapSheetOpen(true)
        return true
      }
      if (action.type === "focus-composer") {
        requestChatShell()
        return true
      }
      if (action.type === "call-space") {
        ensureProductSpaces()
        requestWorkspaceShell()
        callSpace(action.index)
        return true
      }
      if (action.type === "cycle-view") {
        const nextId = neighborViewId(viewsRef.current, viewId, action.direction)
        if (!nextId) return true
        requestWorkspaceShell()
        setActiveView(nextId)
        return true
      }
      if (action.type === "focus-tile-neighbor") {
        focusTileNeighbor(action.key)
        return true
      }
      if (!tileId) return true
      if (action.type === "toggle-maximize") {
        captureSoloFlipForTileId(tileId)
        toggleTileMaximized(viewId, tileId)
        return true
      }
      if (action.type === "close-tile") {
        removeWidget(viewId, tileId)
      }
      return true
    }

    function onKeyDown(event: KeyboardEvent) {
      // Always-on shell chrome — even while typing / overlays (Summon toggles).
      if (isShellModeToggleEvent(event)) {
        event.preventDefault()
        onToggleShellModeRef.current()
        return
      }
      if (isOpenWidgetCatalogEvent(event)) {
        event.preventDefault()
        onToggleSummonRef.current()
        return
      }

      const editable = isEditableKeyboardTarget(event.target)
      const isEscape = event.key === "Escape"
      const surface = getActiveOperatorSurface()

      const session = resolveOperatorSession({
        summonOpen: summonOpenRef.current,
        keymapSheetOpen: keymapSheetOpenRef.current,
        modalWidgetOpen: Boolean(modalWidgetRef.current),
        editable,
        isEscape,
        hasActiveSurface: Boolean(surface),
      })

      if (session.type === "overlay" || session.type === "none") return

      if (isEscape && session.allowShell && modalWidgetRef.current) {
        event.preventDefault()
        event.stopPropagation()
        closeModalWidget()
        return
      }

      if (session.allowShell && !isEscape) {
        const shellAction = resolveShellKeyboardAction(event, {
          hasFocusedTile: Boolean(focusedTileIdRef.current),
        })
        if (shellAction.type !== "none") {
          applyShell(event, shellAction)
          return
        }
      }

      if (session.allowSurface && surface) {
        if (surface.onKeyDown(event)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [
    callSpace,
    closeModalWidget,
    enabled,
    ensureProductSpaces,
    focusTileNeighbor,
    removeWidget,
    requestChatShell,
    requestWorkspaceShell,
    setActiveView,
    setKeymapSheetOpen,
    toggleTileMaximized,
  ])
}

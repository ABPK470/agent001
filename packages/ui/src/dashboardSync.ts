/**
 * Dashboard state auto-sync — debounced save to server.
 *
 * Subscribes to zustand store changes and persists views/activeViewId
 * to the server with a 2s debounce. On startup, restores from server
 * if available (server state wins over stale localStorage).
 */

import { api } from "./api"
import { makeDefaultView, pruneUnknownWidgets, useStore, WIDGET_DEFAULTS } from "./store"
import type { ViewConfig } from "./types"

let timer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 2000

/** Save current dashboard state to server (debounced). */
function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    const { views, activeViewId } = useStore.getState()
    api.saveDashboardState({ views, activeViewId }).catch(() => {
      // Server unreachable — localStorage already has it
    })
  }, DEBOUNCE_MS)
}

/**
 * Flush any pending debounced save immediately.
 * Call this before logout so layout changes made within the debounce window
 * are not lost when the session ends.
 */
export function flushDashboardSave(): void {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  const { views, activeViewId } = useStore.getState()
  api.saveDashboardState({ views, activeViewId }).catch(() => {
    // Server unreachable — localStorage already has it
  })
}

/** Backstop normaliser for layouts persisted **before** `updateLayouts` was
 *  fixed to enforce minW/minH at save time. New saves always include the
 *  current defaults, but legacy server/localStorage payloads from older
 *  versions may still contain undersized items — this clamps them on load
 *  so a one-time refresh fixes any stale state without manual cleanup. */
function normalizeViewLayouts(views: ViewConfig[]): ViewConfig[] {
  return pruneUnknownWidgets(views).map((view) => ({
    ...view,
    layouts: {
      ...view.layouts,
      lg: (view.layouts["lg"] ?? []).map((item) => {
        const widget = view.widgets.find((w) => w.id === item.i)
        if (!widget) return item
        const defaults = WIDGET_DEFAULTS[widget.type as keyof typeof WIDGET_DEFAULTS]
        if (!defaults) return item
        return {
          ...item,
          minW: defaults.minW,
          minH: defaults.minH,
          w: Math.max(item.w, defaults.minW),
          h: Math.max(item.h, defaults.minH),
        }
      }),
    },
  }))
}

/** Load dashboard state from server and apply it. If the server has no
 *  state for this user (new visitor), reset to a clean default view and
 *  clear stale localStorage from a prior user on the same browser. */
let _suppressSave = false
/**
 * Monotonically-increasing counter. Each call to restoreDashboardState()
 * captures the current value; if a newer call supersedes this one before
 * the fetch resolves, the stale response is silently discarded instead of
 * overwriting the newer user's layout.
 */
let _restoreVersion = 0

export async function restoreDashboardState(): Promise<void> {
  const myVersion = ++_restoreVersion
  try {
    const state = await api.getDashboardState() as { views: ViewConfig[]; activeViewId: string } | null
    // Another identity change happened while we were fetching — discard.
    if (myVersion !== _restoreVersion) return
    if (state?.views?.length) {
      _suppressSave = true   // don't echo the server's own data back as a save
      useStore.setState({
        views: normalizeViewLayouts(state.views),
        activeViewId: state.activeViewId,
      })
      _suppressSave = false
    } else {
      // Fresh user: wipe whatever the previous browser user left behind.
      try { localStorage.removeItem("mia-dashboard") } catch { /* ignore */ }
      _suppressSave = true
      useStore.setState({
        views: [makeDefaultView()],
        activeViewId: "default",
      })
      _suppressSave = false
    }
  } catch {
    // Server not available — use localStorage (zustand persist)
  }
}

/** Start watching for store changes and auto-saving to server. Idempotent. */
let syncStarted = false
export function startDashboardSync() {
  if (syncStarted) return
  syncStarted = true
  // Subscribe to views/activeViewId changes
  useStore.subscribe(
    (state, prev) => {
      if (!_suppressSave && (state.views !== prev.views || state.activeViewId !== prev.activeViewId)) {
        scheduleSave()
      }
    },
  )
}

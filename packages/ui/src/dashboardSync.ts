/**
 * Dashboard state auto-sync — debounced save to server.
 *
 * Subscribes to zustand store changes and persists views/activeViewId
 * to the server with a 2s debounce. On startup, restores from server
 * if available (server state wins over stale localStorage).
 */

import { api } from "./api"
import { useStore } from "./store"
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

/** Load dashboard state from server and apply it. If the server has no
 *  state for this user (new visitor), reset to a clean default view and
 *  clear stale localStorage from a prior user on the same browser. */
let _suppressSave = false

export async function restoreDashboardState(): Promise<void> {

  try {
    const state = await api.getDashboardState() as { views: ViewConfig[]; activeViewId: string } | null
    if (state?.views?.length) {
      _suppressSave = true   // don't echo the server's own data back as a save
      useStore.setState({
        views: state.views,
        activeViewId: state.activeViewId,
      })
      _suppressSave = false
    } else {
      // Fresh user: wipe whatever the previous browser user left behind.
      try { localStorage.removeItem("mia-dashboard") } catch { /* ignore */ }
      _suppressSave = true
      useStore.setState({
        views: [{ id: "default", name: "Main", widgets: [], layouts: {} }],
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

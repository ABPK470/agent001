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

/** Load dashboard state from server and apply it. */
export async function restoreDashboardState(): Promise<void> {
  try {
    const state = await api.getDashboardState() as { views: ViewConfig[]; activeViewId: string } | null
    if (state?.views?.length) {
      useStore.setState({
        views: state.views,
        activeViewId: state.activeViewId,
      })
    }
  } catch {
    // Server not available — use localStorage (zustand persist)
  }
}

/** Start watching for store changes and auto-saving to server. */
export function startDashboardSync() {
  // Subscribe to views/activeViewId changes
  useStore.subscribe(
    (state, prev) => {
      if (state.views !== prev.views || state.activeViewId !== prev.activeViewId) {
        scheduleSave()
      }
    },
  )
}

/**
 * Dashboard state auto-sync — debounced save to server.
 */

import { api } from "../../../client/index"
import {
  makeDefaultView,
  pruneUnknownWidgets,
  useLayoutStore,
} from "../../../state/layout-store"
import { viewFromWire, viewToWire } from "../../../lib/workspace-view"
import type { ViewConfig } from "../../../types"

let timer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 2000

function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    const { views, activeViewId } = useLayoutStore.getState()
    const wireViews = views.map(viewToWire)
    api.saveDashboardState({ views: wireViews, activeViewId }).catch(() => {
      // Server unreachable — localStorage already has it
    })
  }, DEBOUNCE_MS)
}

export function flushDashboardSave(): void {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  const { views, activeViewId } = useLayoutStore.getState()
  const wireViews = views.map(viewToWire)
  api.saveDashboardState({ views: wireViews, activeViewId }).catch(() => {})
}

function normalizeWireViews(views: ViewConfig[]): ViewConfig[] {
  return pruneUnknownWidgets(views).map((view) => viewToWire(viewFromWire(view)))
}

let _suppressSave = false
let _restoreVersion = 0

export async function restoreDashboardState(): Promise<void> {
  const myVersion = ++_restoreVersion
  try {
    const state = await api.getDashboardState() as { views: ViewConfig[]; activeViewId: string } | null
    if (myVersion !== _restoreVersion) return
    if (state?.views?.length) {
      _suppressSave = true
      useLayoutStore.setState({
        views: normalizeWireViews(state.views).map(viewFromWire),
        activeViewId: state.activeViewId,
      })
      _suppressSave = false
    } else {
      try { localStorage.removeItem("mia-layout") } catch { /* ignore */ }
      _suppressSave = true
      useLayoutStore.setState({
        views: [makeDefaultView()],
        activeViewId: "default",
      })
      _suppressSave = false
    }
  } catch {
    // Server not available — use localStorage (zustand persist)
  }
}

let syncStarted = false
export function startDashboardSync() {
  if (syncStarted) return
  syncStarted = true
  useLayoutStore.subscribe(
    (state, prev) => {
      if (!_suppressSave && (state.views !== prev.views || state.activeViewId !== prev.activeViewId)) {
        scheduleSave()
      }
    },
  )
}

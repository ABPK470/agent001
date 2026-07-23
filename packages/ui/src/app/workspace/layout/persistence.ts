/**
 * Dashboard state auto-sync — debounced save to server.
 *
 * Geometry invariant: tile y/h row-units must match the live viewport row
 * budget (`viewportRows`). Restoring with a hardcoded row count while the
 * canvas has already measured a different budget leaves tiles short of the
 * viewport — widgets look crushed to the top.
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
    api.saveDashboardState({ views: wireViews, activeViewId }).catch((err: unknown) => { console.error("[mia]", err) })
  }, DEBOUNCE_MS)
}

export function flushDashboardSave(): void {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  const { views, activeViewId } = useLayoutStore.getState()
  const wireViews = views.map(viewToWire)
  api.saveDashboardState({ views: wireViews, activeViewId }).catch((err: unknown) => { console.error("[mia]", err) })
}

/** Hydrate wire views into workspace views projected for the live row budget. */
function hydrateViews(views: ViewConfig[], rows: number) {
  return pruneUnknownWidgets(views).map((view) => viewFromWire(view, rows))
}

let _suppressSave = false
let _restoreVersion = 0

export async function restoreDashboardState(): Promise<void> {
  const myVersion = ++_restoreVersion
  try {
    const state = await api.getDashboardState() as { views: ViewConfig[]; activeViewId: string } | null
    if (myVersion !== _restoreVersion) return
    // Use the live row budget (canvas may already have measured). Never
    // reproject for a stale default — that desyncs tiles from rowPx.
    const rows = useLayoutStore.getState().viewportRows
    if (state?.views?.length) {
      _suppressSave = true
      useLayoutStore.setState({
        views: hydrateViews(state.views, rows),
        activeViewId: state.activeViewId,
      })
      _suppressSave = false
    } else {
      try { localStorage.removeItem("mia-layout") } catch (err: unknown) { console.error("[mia]", err) }
      _suppressSave = true
      useLayoutStore.setState({
        views: [makeDefaultView()],
        activeViewId: "default",
      })
      _suppressSave = false
    }
  } catch (err: unknown) { console.error("[mia]", err) }
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

/** @deprecated Kept for callers that expected wire round-trip; prefer hydrateViews. */
export function normalizeWireViews(views: ViewConfig[], rows?: number): ViewConfig[] {
  const rowBudget = rows ?? useLayoutStore.getState().viewportRows
  return hydrateViews(views, rowBudget).map(viewToWire)
}

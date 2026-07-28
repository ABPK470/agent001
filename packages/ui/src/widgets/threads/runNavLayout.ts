export interface RunNavMarker {
  id: string
  /** 0–1 position in the full thread transcript */
  fraction: number
}

export interface RunBarSlot {
  id: string
  top: number
}

export interface RunBarLayout {
  bars: RunBarSlot[]
  hasMore: boolean
  trackHeight: number
}

export const RUN_NAV_BAR_SLOT_MAX = 12
export const RUN_NAV_CAPSULE_MAX_ROWS = 16
export const RUN_NAV_CAPSULE_MAX_HEIGHT_PX = 432

const MIN_TRACK = 32
const MAX_TRACK_PX = 100
const PER_SLOT_PX = 11
const BASE_PAD_PX = 6
const MIN_RIGHT_GUTTER_PX = 56

export function rightGutterPx(viewportWidth: number): number {
  const columnWidth = Math.min(viewportWidth * 0.94, 960)
  return Math.max(0, (viewportWidth - columnWidth) / 2)
}

export function hasRoomForRunMinimap(viewportWidth: number): boolean {
  return viewportWidth >= 1024 && rightGutterPx(viewportWidth) >= MIN_RIGHT_GUTTER_PX
}

export function transcriptOverflows(clientHeight: number, contentHeight: number): boolean {
  return contentHeight > clientHeight + 8
}

/** Hide the strip until there are enough runs to jump between. */
export const RUN_NAV_MIN_RUNS = 3

/** Thread transcript must span more than this many viewports (scrollable depth). */
export const RUN_NAV_MIN_TOTAL_SCREENS = 2

/**
 * Right-gutter run minimap — only when navigation earns its chrome.
 * At least 3 runs, and a multi-screen transcript (trace / system output) so
 * scrolling alone is easy to get lost in. Short threads stay clean.
 */
export function shouldShowRunMinimap(
  runCount: number,
  clientHeight: number,
  contentHeight: number,
): boolean {
  if (runCount < RUN_NAV_MIN_RUNS) return false
  if (clientHeight <= 0) return false
  if (!transcriptOverflows(clientHeight, contentHeight)) return false
  return contentHeight > RUN_NAV_MIN_TOTAL_SCREENS * clientHeight
}

export function barTrackHeight(slotCount: number): number {
  const slots = Math.max(1, Math.min(slotCount, RUN_NAV_BAR_SLOT_MAX))
  const fromSlots = slots * PER_SLOT_PX + BASE_PAD_PX
  return Math.round(Math.min(MAX_TRACK_PX, Math.max(MIN_TRACK, fromSlots)))
}

function layoutBarsEvenly(ids: string[], trackHeight: number): RunBarSlot[] {
  const count = ids.length
  if (count === 0) return []

  const edge = 3
  const usable = Math.max(0, trackHeight - edge * 2)
  if (count === 1) {
    return [{ id: ids[0]!, top: Math.round(edge + usable / 2) }]
  }

  return ids.map((id, i) => ({
    id,
    top: Math.round(edge + (i / (count - 1)) * usable)
  }))
}

function pickEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items
  if (count <= 1) return [items[0]!]
  const picked: T[] = []
  const used = new Set<number>()
  for (let i = 0; i < count; i++) {
    let idx = Math.round((i / (count - 1)) * (items.length - 1))
    while (used.has(idx) && idx < items.length - 1) idx += 1
    while (used.has(idx) && idx > 0) idx -= 1
    used.add(idx)
    picked.push(items[idx]!)
  }
  return picked
}

export function layoutRunNavBars(markers: RunNavMarker[]): RunBarLayout {
  if (markers.length === 0) {
    return { bars: [], hasMore: false, trackHeight: MIN_TRACK }
  }

  const hasMore = markers.length > RUN_NAV_BAR_SLOT_MAX
  const barCount = hasMore ? RUN_NAV_BAR_SLOT_MAX : markers.length
  const displayMarkers = hasMore ? pickEvenly(markers, barCount) : markers
  const trackHeight = barTrackHeight(barCount)

  return {
    bars: layoutBarsEvenly(
      displayMarkers.map((marker) => marker.id),
      trackHeight
    ),
    hasMore,
    trackHeight
  }
}

export function runLabel(goal: string, max = 64): string {
  const trimmed = goal.trim()
  if (!trimmed) return "Untitled run"
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

export function anchorOffsetInContent(anchor: HTMLElement, content: HTMLElement, host: HTMLElement): number {
  return anchor.getBoundingClientRect().top - content.getBoundingClientRect().top + host.scrollTop
}

export function scrollTranscriptFraction(host: HTMLElement): number {
  const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight)
  if (maxScroll <= 0) return 0
  return Math.max(0, Math.min(1, host.scrollTop / maxScroll))
}

export function markerFractionForAnchor(
  anchor: HTMLElement,
  content: HTMLElement,
  host: HTMLElement
): number {
  const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight)
  if (maxScroll <= 0) return 0
  const offset = anchorOffsetInContent(anchor, content, host)
  return Math.max(0, Math.min(1, offset / maxScroll))
}

export function collectRunNavMarkers(
  content: HTMLElement,
  host: HTMLElement,
  transcriptRunIds: string[]
): RunNavMarker[] {
  const markers: RunNavMarker[] = []
  const total = transcriptRunIds.length
  for (let i = 0; i < total; i++) {
    const id = transcriptRunIds[i]!
    const turn = content.querySelector<HTMLElement>(`[data-run-id="${id}"]`)
    let fraction: number
    if (turn) {
      const anchor = turn.querySelector<HTMLElement>("[data-run-goal-anchor]") ?? turn
      fraction = markerFractionForAnchor(anchor, content, host)
    } else if (total <= 1) {
      fraction = 0
    } else {
      fraction = i / (total - 1)
    }
    markers.push({ id, fraction })
  }
  return markers
}

/**
 * Which run the user is reading — walk transcript order (top→bottom) and take
 * the last run whose turn has reached the reading line in the scroll host.
 *
 * Under VirtualList, only a window of turns is mounted. Prefer live DOM when
 * present; otherwise map scroll depth onto the full run index list so the
 * minimap still points at the right place (including latest / last N runs).
 */
export function pickNavRunInView(
  host: HTMLElement,
  content: HTMLElement,
  transcriptRunIds: string[]
): string | null {
  if (transcriptRunIds.length === 0) return null
  if (transcriptRunIds.length === 1) return transcriptRunIds[0]!

  const hostRect = host.getBoundingClientRect()
  const lineY = hostRect.top + Math.min(96, Math.max(56, hostRect.height * 0.16))

  let activeId = transcriptRunIds[0]!
  let sawMounted = false
  for (const id of transcriptRunIds) {
    const turn = content.querySelector<HTMLElement>(`[data-run-id="${id}"]`)
    if (!turn) continue
    sawMounted = true
    if (turn.getBoundingClientRect().top <= lineY) {
      activeId = id
    }
  }
  if (sawMounted) return activeId

  const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight)
  if (maxScroll <= 0) return transcriptRunIds[0]!
  const t = Math.max(0, Math.min(1, host.scrollTop / maxScroll))
  const idx = Math.round(t * (transcriptRunIds.length - 1))
  return transcriptRunIds[idx]!
}

/** @deprecated scroll-fraction picker — use pickNavRunInView for live scroll sync */
export function pickNavRunIdForScrollFraction(
  scrollFraction: number,
  markers: RunNavMarker[]
): string | null {
  if (markers.length === 0) return null
  if (markers.length === 1) return markers[0]!.id

  const t = Math.max(0, Math.min(1, scrollFraction))

  let active = markers[0]!
  for (const marker of markers) {
    if (marker.fraction <= t + 0.001) {
      active = marker
    } else {
      break
    }
  }
  return active.id
}

/** Minimap thumb position — tracks scroll depth, not turn body height. */
export function navBarIndexForScrollFraction(scrollFraction: number, barCount: number): number {
  if (barCount <= 0) return -1
  if (barCount === 1) return 0
  const t = Math.max(0, Math.min(1, scrollFraction))
  return Math.round(t * (barCount - 1))
}

/** Which evenly-spaced bar slot matches a run's place in the thread. */
export function navBarIndexForRun(barCount: number, orderedRunIds: string[], runId: string): number {
  if (barCount <= 0 || orderedRunIds.length === 0) return -1
  if (barCount === 1 || orderedRunIds.length === 1) return 0

  const runIndex = orderedRunIds.indexOf(runId)
  if (runIndex < 0) return -1
  return Math.round((runIndex / (orderedRunIds.length - 1)) * (barCount - 1))
}

export function activeBarIndexForRun(
  bars: RunBarSlot[],
  orderedRunIds: string[],
  runId: string | null
): number {
  if (!runId || bars.length === 0) return -1
  const exact = bars.findIndex((bar) => bar.id === runId)
  if (exact >= 0) return exact
  return navBarIndexForRun(bars.length, orderedRunIds, runId)
}

export function chatChromeDockTop(host: HTMLElement): number {
  // Center on the transcript viewport. Do not use the input dock top — when the
  // slash palette expands in-flow it moves the dock and falsely shifts the rail.
  const hostRect = host.getBoundingClientRect()
  return hostRect.top + hostRect.height / 2
}

/**
 * Viewport height for minimap eligibility. When the composer palette expands
 * it steals flex space from the transcript; add that height back so opening
 * `/` does not suddenly trip the multi-screen threshold.
 */
export function measureMinimapViewportHeight(host: HTMLElement): number {
  const shell = host.closest(".termchat-home-shell")
  const expand = shell?.querySelector<HTMLElement>(".chat-composer__expand")
  if (!expand) return host.clientHeight
  return host.clientHeight + expand.offsetHeight
}

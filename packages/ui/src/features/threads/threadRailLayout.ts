/** Mirrors TermChat home column: w-[94%] max-w-[960px] mx-auto */
export const THREAD_CHAT_MAX_WIDTH_PX = 960
export const THREAD_CHAT_WIDTH_RATIO = 0.94

/** Mirrors .thread-rail--expanded width in rem */
export const THREAD_RAIL_WIDTH_REM = 18.5
export const THREAD_RAIL_WIDTH_REM_COMPACT = 16.25

/** Extra px so the rail clears the chat column edge before we switch modes */
export const THREAD_RAIL_FIT_SAFETY_PX = 12

export function chatColumnWidthPx(viewportWidth: number): number {
  return Math.min(viewportWidth * THREAD_CHAT_WIDTH_RATIO, THREAD_CHAT_MAX_WIDTH_PX)
}

export function leftGutterPx(viewportWidth: number): number {
  return (viewportWidth - chatColumnWidthPx(viewportWidth)) / 2
}

export function sidebarFootprintPx(viewportWidth: number, rootFontPx = 16): number {
  const sidebarRem =
    viewportWidth >= 1024 && viewportWidth < 1280
      ? THREAD_RAIL_WIDTH_REM_COMPACT
      : THREAD_RAIL_WIDTH_REM
  const insetRem = viewportWidth >= 640 ? 1.5 : 0.75
  return (sidebarRem + insetRem) * rootFontPx
}

/** True when the overlay rail fits in the left gutter without covering chat content. */
export function computeThreadRailFits(
  viewportWidth: number,
  rootFontPx = 16,
): boolean {
  if (viewportWidth < 1024) return false
  return (
    leftGutterPx(viewportWidth) >=
    sidebarFootprintPx(viewportWidth, rootFontPx) + THREAD_RAIL_FIT_SAFETY_PX
  )
}

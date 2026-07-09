/** Mirrors TermChat home column — see shell/chatLayout.ts */
export { HOME_CHAT_MAX_WIDTH_PX as THREAD_CHAT_MAX_WIDTH_PX, HOME_CHAT_WIDTH_RATIO as THREAD_CHAT_WIDTH_RATIO } from "../../shell/chatLayout.js"
import { homeChatColumnWidthPx } from "../../shell/chatLayout.js"

/** Mirrors .thread-rail--expanded width in rem */
export const THREAD_RAIL_WIDTH_REM = 15
export const THREAD_RAIL_WIDTH_REM_COMPACT = 13.5

/** Extra px so the rail clears the chat column edge before we switch modes */
export const THREAD_RAIL_FIT_SAFETY_PX = 12

export function chatColumnWidthPx(viewportWidth: number): number {
  return homeChatColumnWidthPx(viewportWidth)
}

export function leftGutterPx(viewportWidth: number): number {
  return (viewportWidth - chatColumnWidthPx(viewportWidth)) / 2
}

export function sidebarFootprintPx(viewportWidth: number, rootFontPx = 16): number {
  const sidebarRem =
    viewportWidth >= 1024 && viewportWidth < 1280
      ? THREAD_RAIL_WIDTH_REM_COMPACT
      : THREAD_RAIL_WIDTH_REM
  const insetRem = viewportWidth >= 640 ? 1.5 : 1
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

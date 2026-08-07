/**
 * Event Stream detail presentation — drawer when the tile is wide enough,
 * inline expand when a side-by-side pane would crush the payload.
 */

export const EVENT_STREAM_DRAWER_MIN_WIDTH = 640

export type EventStreamDetailMode = "drawer" | "inline"

export function resolveEventStreamDetailMode(width: number): EventStreamDetailMode {
  return width >= EVENT_STREAM_DRAWER_MIN_WIDTH ? "drawer" : "inline"
}

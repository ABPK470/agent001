/**
 * Zen session — immersion over 1–2 focus-capable tiles.
 * Ephemeral until saved as a zen:* view. Not a second layout engine.
 */

import type { WidgetType } from "../types"
import { widgetSupportsFocusMode } from "./widget-focus"

export const ZEN_SESSION_MAX = 2
export const ZEN_VIEW_ID_PREFIX = "zen:"
/** Below this canvas width, paint only the focused zen tile. */
export const ZEN_NARROW_PAINT_PX = 640

export function isZenViewId(id: string): boolean {
  return id.startsWith(ZEN_VIEW_ID_PREFIX)
}

export function newZenViewId(): string {
  return `${ZEN_VIEW_ID_PREFIX}${crypto.randomUUID()}`
}

export function canJoinZenSession(type: WidgetType): boolean {
  return widgetSupportsFocusMode(type)
}

/**
 * Z on a tile already in zen:
 * - sole member → exit session (caller clears)
 * - one of two → drop it, keep the companion
 */
export function resolveZenToggleInSession(
  zenSet: readonly string[],
  tileId: string,
): { type: "exit" } | { type: "shrink"; nextSet: string[] } {
  if (!zenSet.includes(tileId)) {
    return { type: "exit" }
  }
  if (zenSet.length <= 1) return { type: "exit" }
  return {
    type: "shrink",
    nextSet: zenSet.filter((id) => id !== tileId),
  }
}

/**
 * Cap-2 Keep: add type, or replace focused member when full.
 * Never duplicates a type already in the set.
 */
export function resolveZenKeepCap(
  zenSet: readonly string[],
  zenTypesById: ReadonlyMap<string, WidgetType>,
  focusedTileId: string | null,
  keepType: WidgetType,
  newTileId: string,
): { nextSet: string[]; replaceId: string | null } {
  for (const id of zenSet) {
    if (zenTypesById.get(id) === keepType) {
      return { nextSet: [...zenSet], replaceId: null }
    }
  }
  if (zenSet.length < ZEN_SESSION_MAX) {
    return { nextSet: [...zenSet, newTileId], replaceId: null }
  }
  const replaceId =
    focusedTileId && zenSet.includes(focusedTileId)
      ? focusedTileId
      : zenSet[zenSet.length - 1]!
  return {
    nextSet: zenSet.map((id) => (id === replaceId ? newTileId : id)),
    replaceId,
  }
}

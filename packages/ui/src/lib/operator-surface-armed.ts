/**
 * Whether a widget mount should claim the operator surface.
 *
 * Peek of this type arms the peek mount (Summon may still be open underneath).
 * Otherwise a focused / zen tile arms when no Summon, Keymap, or other peek owns
 * the session. One rule for Event Stream, Pipelines, Trace, …
 */

import type { WidgetType } from "../types"
import type { WidgetInstance } from "../app/workspace/widget-instance"

export const PEEK_WIDGET_ID_PREFIX = "peek:"

export function peekWidgetInstanceId(type: WidgetType): string {
  return `${PEEK_WIDGET_ID_PREFIX}${type}`
}

export function isPeekWidgetInstance(instance: WidgetInstance | null | undefined): boolean {
  return Boolean(instance?.widgetId.startsWith(PEEK_WIDGET_ID_PREFIX))
}

export function isOperatorSurfaceArmed(ctx: {
  instance: WidgetInstance | null | undefined
  focusedTileId: string | null
  modalWidgetType: WidgetType | null
  summonOpen: boolean
  keymapSheetOpen: boolean
  /** Zen / solo on this tile mount — still a layout surface. */
  layoutFocus?: boolean
}): boolean {
  const instance = ctx.instance
  if (!instance) return false
  if (ctx.keymapSheetOpen) return false

  if (ctx.modalWidgetType != null) {
    return isPeekWidgetInstance(instance) && instance.type === ctx.modalWidgetType
  }

  if (ctx.summonOpen) return false
  if (ctx.layoutFocus) return true
  return ctx.focusedTileId === instance.widgetId
}

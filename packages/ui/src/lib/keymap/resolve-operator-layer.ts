/**
 * Operator keydown session gate — pure.
 * Overlays own the session; otherwise shell tries first, then the claimed surface.
 */

export type OperatorSession =
  | { type: "overlay" }
  | { type: "dispatch"; allowShell: boolean; allowSurface: boolean }
  | { type: "none" }

/**
 * Decide whether the composition root may dispatch shell / surface apply.
 * Summon & Keymap keep their own Esc listeners; root stays quiet while they are open.
 */
export function resolveOperatorSession(ctx: {
  summonOpen: boolean
  keymapSheetOpen: boolean
  modalWidgetOpen: boolean
  editable: boolean
  isEscape: boolean
  hasActiveSurface: boolean
}): OperatorSession {
  if (ctx.summonOpen || ctx.keymapSheetOpen) return { type: "overlay" }

  if (ctx.isEscape) {
    if (ctx.modalWidgetOpen) {
      return { type: "dispatch", allowShell: true, allowSurface: false }
    }
    if (ctx.hasActiveSurface) {
      return { type: "dispatch", allowShell: false, allowSurface: true }
    }
    return { type: "none" }
  }

  if (ctx.editable || ctx.modalWidgetOpen) return { type: "none" }

  return {
    type: "dispatch",
    allowShell: true,
    allowSurface: ctx.hasActiveSurface,
  }
}

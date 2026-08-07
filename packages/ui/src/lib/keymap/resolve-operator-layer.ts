/**
 * Operator keydown session gate — pure.
 * Overlays own the session; peeked widgets are the focused surface (not silence).
 */

export type OperatorSession =
  | { type: "overlay" }
  | { type: "dispatch"; allowShell: boolean; allowSurface: boolean }
  | { type: "none" }

/**
 * Decide whether the composition root may dispatch shell / surface apply.
 *
 * Peek (modalWidget) is a temporary focused surface — same claim path as a tile.
 * Summon under a peek stays quiet for non-Esc; Esc peels the peek at shell.
 * Keymap / Summon-alone keep their own Esc listeners; root stays quiet while they own.
 */
export function resolveOperatorSession(ctx: {
  summonOpen: boolean
  keymapSheetOpen: boolean
  modalWidgetOpen: boolean
  editable: boolean
  isEscape: boolean
  hasActiveSurface: boolean
}): OperatorSession {
  // Esc peels peek first (Summon may remain open underneath).
  if (ctx.modalWidgetOpen && ctx.isEscape) {
    return { type: "dispatch", allowShell: true, allowSurface: false }
  }

  if (ctx.keymapSheetOpen) return { type: "overlay" }
  // Summon alone owns the session; peek above Summon is handled below.
  if (ctx.summonOpen && !ctx.modalWidgetOpen) return { type: "overlay" }

  if (ctx.isEscape) {
    if (ctx.hasActiveSurface) {
      return { type: "dispatch", allowShell: false, allowSurface: true }
    }
    return { type: "none" }
  }

  if (ctx.editable) return { type: "none" }

  // Peek = focused operator surface. Shell tile chords stay quiet.
  if (ctx.modalWidgetOpen) {
    return {
      type: "dispatch",
      allowShell: false,
      allowSurface: ctx.hasActiveSurface,
    }
  }

  return {
    type: "dispatch",
    allowShell: true,
    allowSurface: ctx.hasActiveSurface,
  }
}

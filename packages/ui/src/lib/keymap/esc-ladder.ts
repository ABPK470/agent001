/**
 * Operator Esc ladder — one keydown, one step (narrowest context first).
 */

export type EscLadderContext = {
  scopeDrawerOpen: boolean
  filterOpen: boolean
  focusedPane: "tree" | "detail"
  isZen: boolean
  isSolo: boolean
  summonOpen: boolean
}

export type EscLadderAction =
  | { type: "dismiss-scope-drawer" }
  | { type: "dismiss-filter" }
  | { type: "pane-to-tree" }
  | { type: "exit-zen" }
  | { type: "restore-maximize" }
  | { type: "dismiss-summon" }
  | { type: "none" }

/**
 * Pure Esc priority.
 * Summon/peek overlays sit above widget context; then scope drawer → filter → pane → zen → max.
 */
export function resolveEscLadder(ctx: EscLadderContext): EscLadderAction {
  if (ctx.summonOpen) return { type: "dismiss-summon" }
  if (ctx.scopeDrawerOpen) return { type: "dismiss-scope-drawer" }
  if (ctx.filterOpen) return { type: "dismiss-filter" }
  if (ctx.focusedPane === "detail") return { type: "pane-to-tree" }
  if (ctx.isZen) return { type: "exit-zen" }
  if (ctx.isSolo) return { type: "restore-maximize" }
  return { type: "none" }
}

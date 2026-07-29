/**
 * One continuous stroke for the workspace sheet: stage + active tab bump.
 * Dual strokes (tab outline + stage top hole) cannot meet — they leave a
 * line cutting through the scoops. This path is the whole silhouette.
 */

export const SHEET_SCOOP_PX = 10
export const SHEET_TAB_RADIUS_PX = 11

export type SheetRect = {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Closed path in chrome-local px. When `tab` is null, a plain rounded stage.
 */
export function workspaceSheetOutlinePath(
  stage: SheetRect,
  tab: SheetRect | null,
  stageRadius: number,
  tabRadius = SHEET_TAB_RADIUS_PX,
  scoop = SHEET_SCOOP_PX,
): string {
  const sx = stage.x
  const sy = stage.y
  const sw = Math.max(1, stage.w)
  const sh = Math.max(1, stage.h)
  const R = Math.min(stageRadius, sw / 2, sh / 2)

  if (!tab || tab.w < 8) {
    return roundedRectPath(sx, sy, sw, sh, R)
  }

  const tx = tab.x
  const tw = Math.max(1, tab.w)
  const tt = Math.min(tab.y, sy - 4)
  const s = Math.min(scoop, sy - tt, tw / 2)
  const r = Math.min(tabRadius, tw / 2, sy - tt - s)

  // Scoops must sit on the stage top edge, inset past stage corner radii.
  const leftScoop = Math.max(sx + R, tx - s)
  const rightScoop = Math.min(sx + sw - R, tx + tw + s)
  const tabLeft = Math.max(leftScoop, Math.min(tx, rightScoop - 1))
  const tabRight = Math.min(rightScoop, Math.max(tx + tw, tabLeft + 1))
  const scoopL = Math.min(s, tabLeft - leftScoop)
  const scoopR = Math.min(s, rightScoop - tabRight)

  return [
    // Stage top → left scoop → tab → right scoop → rest of stage clockwise.
    // Scoops are quarter-circles through the baseline/side corner (y-down SVG:
    // both use sweep 0 / ccw for the minor arc). Sweep 1 on the right draws
    // the long way and reads as a convex "hump".
    `M ${sx + R} ${sy}`,
    `L ${leftScoop} ${sy}`,
    scoopL > 0.5 ? `A ${scoopL} ${scoopL} 0 0 0 ${tabLeft} ${sy - scoopL}` : `L ${tabLeft} ${sy}`,
    `L ${tabLeft} ${tt + r}`,
    `A ${r} ${r} 0 0 1 ${tabLeft + r} ${tt}`,
    `L ${tabRight - r} ${tt}`,
    `A ${r} ${r} 0 0 1 ${tabRight} ${tt + r}`,
    `L ${tabRight} ${sy - scoopR}`,
    scoopR > 0.5 ? `A ${scoopR} ${scoopR} 0 0 0 ${rightScoop} ${sy}` : `L ${rightScoop} ${sy}`,
    `L ${sx + sw - R} ${sy}`,
    `A ${R} ${R} 0 0 1 ${sx + sw} ${sy + R}`,
    `L ${sx + sw} ${sy + sh - R}`,
    `A ${R} ${R} 0 0 1 ${sx + sw - R} ${sy + sh}`,
    `L ${sx + R} ${sy + sh}`,
    `A ${R} ${R} 0 0 1 ${sx} ${sy + sh - R}`,
    `L ${sx} ${sy + R}`,
    `A ${R} ${R} 0 0 1 ${sx + R} ${sy}`,
    "Z",
  ].join(" ")
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return [
    `M ${x + r} ${y}`,
    `L ${x + w - r} ${y}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `L ${x + w} ${y + h - r}`,
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,
    `L ${x + r} ${y + h}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    `L ${x} ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    "Z",
  ].join(" ")
}

/** Chrome-local rect from viewport boxes. */
export function rectInHost(
  host: { left: number; top: number },
  box: { left: number; top: number; width: number; height: number },
): SheetRect {
  return {
    x: box.left - host.left,
    y: box.top - host.top,
    w: box.width,
    h: box.height,
  }
}

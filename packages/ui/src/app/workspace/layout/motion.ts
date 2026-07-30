/** Tile entrance — keep in sync with `.workspace-tile-entering` / `-entered` in index.css. */
export function entranceClassName(isEntering: boolean): string {
  return isEntering ? "workspace-tile-entering" : "workspace-tile-entered"
}

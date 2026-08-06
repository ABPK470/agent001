/**
 * Resolve which tile to focus for a widget type on a layout.
 * First match in tiles order — never invent a new tile id.
 */

export function firstTileIdForWidgetType(
  tiles: readonly { id: string; type: string }[],
  type: string,
): string | null {
  return tiles.find((tile) => tile.type === type)?.id ?? null
}

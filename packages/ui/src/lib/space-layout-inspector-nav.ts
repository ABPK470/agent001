/**
 * Spatial Inspector keyboard — digit hotkeys for tile focus (1–9).
 */

/** Inspector shell width — matches `.space-layout-preview` CSS var. */
export const SPACE_PREVIEW_WIDTH_REM = 26.5

export function spaceLayoutInspectorEligible(tileCount: number): boolean {
  return tileCount >= 2
}

/** Map digit key to zero-based selectable leaf index, or null if out of range. */
export function tileHotkeyIndex(key: string, leafCount: number): number | null {
  if (leafCount <= 0) return null
  if (key.length !== 1 || key < "1" || key > "9") return null
  const index = Number(key) - 1
  if (index < 0 || index >= leafCount) return null
  return index
}

/**
 * Multi-select filter choice — empty set means “all” when `emptyMeansAll`.
 *
 * Left-click → select what was clicked (from all → only X; else toggle).
 * Right-click → inverse (all except X). Same set again clears back to all.
 */

function sameAsSet<T extends string>(values: readonly T[], next: readonly T[]): boolean {
  if (values.length !== next.length) return false
  const set = new Set(values)
  return next.every((value) => set.has(value))
}

/** Left-click: select the clicked option. */
export function selectMultiFilterChoice<T extends string>(
  options: readonly T[],
  values: readonly T[],
  clicked: T,
): T[] {
  const selected = new Set(values)

  // Single option (e.g. Errors only) — plain on/off.
  if (options.length <= 1) {
    if (selected.has(clicked)) return []
    return [clicked]
  }

  // Empty = implicit all → left isolates the target.
  if (selected.size === 0) return [clicked]

  if (selected.has(clicked)) selected.delete(clicked)
  else selected.add(clicked)

  if (selected.size === 0) return []
  if (selected.size === options.length) return []
  return [...selected]
}

/** Right-click: inverse of left — all except the clicked option. */
export function invertMultiFilterChoice<T extends string>(
  options: readonly T[],
  values: readonly T[],
  clicked: T,
): T[] {
  if (options.length <= 1) {
    return selectMultiFilterChoice(options, values, clicked)
  }

  const except = options.filter((value) => value !== clicked)
  // Already “all except X” → clear back to implicit all.
  if (sameAsSet(values, except)) return []
  return except
}

/**
 * @deprecated Prefer selectMultiFilterChoice (left) / invertMultiFilterChoice (right).
 * Kept as left-click alias for transitional imports.
 */
export function toggleMultiFilterChoice<T extends string>(
  options: readonly T[],
  values: readonly T[],
  clicked: T,
): T[] {
  return selectMultiFilterChoice(options, values, clicked)
}

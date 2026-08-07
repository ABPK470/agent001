/**
 * Multi-select filter choice — empty set means “all” for Event Stream / Pipelines.
 * First click excludes the target (all except X); selecting every option clears
 * back to empty (same lens as no filter).
 */

export function toggleMultiFilterChoice<T extends string>(
  options: readonly T[],
  values: readonly T[],
  clicked: T,
): T[] {
  const selected = new Set(values)

  // Empty = implicit all → one click excludes the target.
  if (selected.size === 0 && options.length > 1) {
    return options.filter((value) => value !== clicked)
  }

  if (selected.has(clicked)) selected.delete(clicked)
  else selected.add(clicked)

  // All selected ≡ no filter (only when exclude-on-empty applies).
  if (options.length > 1 && selected.size === options.length) return []
  return [...selected]
}

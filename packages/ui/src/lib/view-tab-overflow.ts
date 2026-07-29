/**
 * Fit whole view chips into a strip width — never mid-clip a tab.
 * Active view is always kept visible; overflow goes to a More menu.
 */

export type ViewTabWidth = {
  id: string
  widthPx: number
}

/**
 * Pick which view ids fit as whole chips in `budgetPx` (gap between chips).
 * `moreBtnPx` is reserved only when not everything fits.
 */
export function fitVisibleViewIds(
  items: readonly ViewTabWidth[],
  activeId: string,
  budgetPx: number,
  gapPx: number,
  moreBtnPx: number,
): string[] {
  if (items.length === 0) return []
  if (budgetPx <= 0) {
    const active = items.find((item) => item.id === activeId)
    return active ? [active.id] : [items[0]!.id]
  }

  let total = 0
  for (let i = 0; i < items.length; i++) {
    total += items[i]!.widthPx + (i > 0 ? gapPx : 0)
  }
  if (total <= budgetPx) return items.map((item) => item.id)

  const budget = Math.max(0, budgetPx - moreBtnPx)
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId))
  const activeWidth = items[activeIndex]?.widthPx ?? 0
  if (activeWidth > budget) return [items[activeIndex]!.id]

  // Window that includes the active chip — grow left, then right.
  let start = activeIndex
  let end = activeIndex
  let used = activeWidth

  while (start > 0) {
    const next = items[start - 1]!.widthPx + gapPx
    if (used + next > budget) break
    start -= 1
    used += next
  }
  while (end < items.length - 1) {
    const next = items[end + 1]!.widthPx + gapPx
    if (used + next > budget) break
    end += 1
    used += next
  }

  return items.slice(start, end + 1).map((item) => item.id)
}

/**
 * Map a strip-local drop index to a full-list `reorderViews` toIndex.
 * `stripIds` is DOM order including the dragged id.
 */
export function globalReorderIndex(
  allIds: readonly string[],
  stripIds: readonly string[],
  draggedId: string,
  toStripIndex: number,
): number {
  const withoutDragged = stripIds.filter((id) => id !== draggedId)
  const clamped = Math.max(0, Math.min(toStripIndex, withoutDragged.length))
  const nextStrip = [
    ...withoutDragged.slice(0, clamped),
    draggedId,
    ...withoutDragged.slice(clamped),
  ]

  const stripSet = new Set(stripIds)
  const result: string[] = []
  let inserted = false
  for (const id of allIds) {
    if (!stripSet.has(id)) {
      result.push(id)
      continue
    }
    if (!inserted) {
      result.push(...nextStrip)
      inserted = true
    }
  }
  if (!inserted) result.push(...nextStrip)

  const index = result.indexOf(draggedId)
  return index >= 0 ? index : Math.max(0, allIds.indexOf(draggedId))
}

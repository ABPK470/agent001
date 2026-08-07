/**
 * Summon surface bag — pure.
 *
 * Cursor (↑↓) and bag (Space / Shift+click) are separate.
 * Enter lands the bag when non-empty; otherwise lands the cursor item.
 *
 * Bag semantics vs the active layout:
 *   - stage an absent surface → keep (add)
 *   - stage a present surface → remove (drop)
 */

import type { WidgetType } from "../types"
import {
  resolveSummonWidgetEnter,
  resolveSummonWidgetPeek,
  resolveSummonWidgetsApply,
  type SummonOpenAction,
} from "./summon-resolve"

export function toggleSummonPick(
  bag: ReadonlySet<WidgetType>,
  type: WidgetType,
): Set<WidgetType> {
  const next = new Set(bag)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  return next
}

export function partitionSummonBag(
  bag: readonly WidgetType[],
  presentTypes: ReadonlySet<string>,
): { keep: WidgetType[]; remove: WidgetType[] } {
  const seen = new Set<WidgetType>()
  const keep: WidgetType[] = []
  const remove: WidgetType[] = []
  for (const type of bag) {
    if (seen.has(type)) continue
    seen.add(type)
    if (presentTypes.has(type)) remove.push(type)
    else keep.push(type)
  }
  return { keep, remove }
}

/**
 * Resolve the land action for the current keyboard/mouse commit.
 * Bag wins when non-empty (Mod+Enter peek is ignored while staging).
 */
export function resolveSummonLand(opts: {
  bag: readonly WidgetType[]
  presentTypes?: ReadonlySet<string>
  /** Cursor widget type when the cursor is on a surface. */
  cursorType?: WidgetType
  cursorPresent?: boolean
  modEnter?: boolean
}): SummonOpenAction | null {
  const bag = opts.bag
  if (bag.length > 0) {
    return resolveSummonWidgetsApply(
      bag,
      opts.presentTypes ?? new Set(),
      opts.cursorType,
    )
  }
  if (!opts.cursorType) return null
  if (opts.modEnter) return resolveSummonWidgetPeek(opts.cursorType)
  return resolveSummonWidgetEnter(opts.cursorType, Boolean(opts.cursorPresent))
}

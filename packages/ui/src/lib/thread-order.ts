/**
 * Thread list order — pinned first, then newest activity.
 * One comparator for store writers and list UIs (Threads widget / rail).
 */

export function compareThreadsByPinThenUpdatedAt<
  T extends { pinned?: boolean; updatedAt: string },
>(a: T, b: T): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  return b.updatedAt.localeCompare(a.updatedAt)
}

export function sortThreadsByPinThenUpdatedAt<
  T extends { pinned?: boolean; updatedAt: string },
>(threads: readonly T[]): T[] {
  return [...threads].sort(compareThreadsByPinThenUpdatedAt)
}

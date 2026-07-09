import type { EntityRegistryTable } from "./index.js"

/** Stable sort by executionOrder, then assign contiguous orders starting at 1. */
export function renumberEntityRegistryTables(tables: readonly EntityRegistryTable[]): EntityRegistryTable[] {
  return [...tables]
    .map((table, idx) => ({ table, idx }))
    .sort(
      (left, right) =>
        left.table.executionOrder - right.table.executionOrder || left.idx - right.idx,
    )
    .map(({ table }, index) => ({
      ...table,
      executionOrder: index + 1,
    }))
}

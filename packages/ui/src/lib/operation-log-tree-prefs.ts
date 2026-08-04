/**
 * Pipelines left-tree open/fold prefs — survive view switches (widget remount).
 *
 * Same dialect as Trace tree prefs:
 * - sessionStorage + in-memory mirror, keyed by tile id
 * - read returns null when nothing stored (caller applies defaults)
 * - empty snapshot clears storage — never invent a “seed” fold on remount
 */

import type { OpLogTreeFoldMode } from "../widgets/pipelines/op-log-tree-open-state"

export type OperationLogTreePrefs = {
  foldMode: OpLogTreeFoldMode
  openPipelineIds: string[]
  actExpanded: string[]
  collapsedDays: string[]
}

const STORAGE_PREFIX = "mia:operation-log-tree:"

/** Survive remount even if sessionStorage was raced empty. */
const memoryByTile = new Map<string, OperationLogTreePrefs>()

export const DEFAULT_OPERATION_LOG_TREE_PREFS: OperationLogTreePrefs = {
  foldMode: "collapsed",
  openPipelineIds: [],
  actExpanded: [],
  collapsedDays: [],
}

export function operationLogTreePrefsKey(tileId: string | null | undefined): string | null {
  if (!tileId || tileId.trim().length === 0) return null
  return `${STORAGE_PREFIX}${tileId}`
}

function parseFoldMode(raw: unknown): OpLogTreeFoldMode {
  return raw === "expanded" ? "expanded" : "collapsed"
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0)
}

export function operationLogTreePrefsHaveOpens(prefs: OperationLogTreePrefs): boolean {
  return (
    prefs.openPipelineIds.length > 0 ||
    prefs.actExpanded.length > 0 ||
    prefs.collapsedDays.length > 0 ||
    prefs.foldMode === "expanded"
  )
}

export function readOperationLogTreePrefs(
  tileId: string | null | undefined,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): OperationLogTreePrefs | null {
  const key = operationLogTreePrefsKey(tileId)
  if (!key) return null
  const fromMemory = memoryByTile.get(key)
  try {
    const raw = storage.getItem(key)
    if (!raw) {
      return fromMemory ? { ...fromMemory } : null
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const prefs: OperationLogTreePrefs = {
      foldMode: parseFoldMode(parsed["foldMode"]),
      openPipelineIds: parseStringArray(parsed["openPipelineIds"]),
      actExpanded: parseStringArray(parsed["actExpanded"]),
      collapsedDays: parseStringArray(parsed["collapsedDays"]),
    }
    // Prefer memory if storage was raced empty while we still have opens.
    if (
      !operationLogTreePrefsHaveOpens(prefs) &&
      fromMemory &&
      operationLogTreePrefsHaveOpens(fromMemory)
    ) {
      return { ...fromMemory }
    }
    memoryByTile.set(key, prefs)
    return prefs
  } catch {
    return fromMemory ? { ...fromMemory } : null
  }
}

export function writeOperationLogTreePrefs(
  tileId: string | null | undefined,
  prefs: OperationLogTreePrefs,
  storage: Pick<Storage, "setItem" | "removeItem"> = sessionStorage,
): void {
  const key = operationLogTreePrefsKey(tileId)
  if (!key) return
  const empty = !operationLogTreePrefsHaveOpens(prefs)
  try {
    if (empty) {
      memoryByTile.delete(key)
      storage.removeItem(key)
      return
    }
    memoryByTile.set(key, { ...prefs })
    storage.setItem(key, JSON.stringify(prefs))
  } catch (err: unknown) {
    console.error("[mia]", err)
  }
}

/** Test seam — drop in-memory mirror between cases. */
export function resetOperationLogTreePrefsMemory(): void {
  memoryByTile.clear()
}

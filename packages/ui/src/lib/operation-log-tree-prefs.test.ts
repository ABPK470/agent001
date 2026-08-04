import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_OPERATION_LOG_TREE_PREFS,
  readOperationLogTreePrefs,
  resetOperationLogTreePrefsMemory,
  writeOperationLogTreePrefs,
} from "./operation-log-tree-prefs"

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    map,
  }
}

describe("operation-log-tree-prefs", () => {
  afterEach(() => {
    resetOperationLogTreePrefsMemory()
  })

  it("round-trips open pipeline and activity keys", () => {
    const storage = memoryStorage()
    writeOperationLogTreePrefs(
      "tile-1",
      {
        foldMode: "collapsed",
        openPipelineIds: ["p1", "p2"],
        actExpanded: ["p1:a1"],
        collapsedDays: ["Mon"],
      },
      storage,
    )
    expect(readOperationLogTreePrefs("tile-1", storage)).toEqual({
      foldMode: "collapsed",
      openPipelineIds: ["p1", "p2"],
      actExpanded: ["p1:a1"],
      collapsedDays: ["Mon"],
    })
  })

  it("returns null when missing — caller owns defaults", () => {
    expect(readOperationLogTreePrefs("missing", memoryStorage())).toBeNull()
    expect(DEFAULT_OPERATION_LOG_TREE_PREFS.foldMode).toBe("collapsed")
  })

  it("keeps in-memory opens when storage was cleared", () => {
    const storage = memoryStorage()
    writeOperationLogTreePrefs(
      "tile-race",
      {
        foldMode: "collapsed",
        openPipelineIds: ["p1"],
        actExpanded: ["p1:a1"],
        collapsedDays: [],
      },
      storage,
    )
    storage.removeItem("mia:operation-log-tree:tile-race")
    expect(readOperationLogTreePrefs("tile-race", storage)).toEqual({
      foldMode: "collapsed",
      openPipelineIds: ["p1"],
      actExpanded: ["p1:a1"],
      collapsedDays: [],
    })
  })

  it("empty write clears store so remount does not resurrect opens", () => {
    const storage = memoryStorage()
    writeOperationLogTreePrefs(
      "tile-clear",
      {
        foldMode: "collapsed",
        openPipelineIds: ["p1"],
        actExpanded: [],
        collapsedDays: [],
      },
      storage,
    )
    writeOperationLogTreePrefs(
      "tile-clear",
      {
        foldMode: "collapsed",
        openPipelineIds: [],
        actExpanded: [],
        collapsedDays: [],
      },
      storage,
    )
    expect(readOperationLogTreePrefs("tile-clear", storage)).toBeNull()
  })
})

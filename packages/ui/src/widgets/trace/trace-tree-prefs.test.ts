import { describe, expect, it } from "vitest"
import { emptyOpen } from "./open-state"
import {
  deserializeTraceOpenState,
  readTraceTreePrefs,
  serializeTraceOpenState,
  writeTraceTreePrefs,
} from "./trace-tree-prefs"

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
  }
}

describe("trace-tree-prefs", () => {
  it("round-trips open state for a run", () => {
    const storage = memoryStorage()
    const state = emptyOpen()
    state.foldMode = "collapsed"
    state.calls.add(2)
    state.phases.add("phase-pipeline")
    state.work.add("work-1")
    writeTraceTreePrefs("tile-a", "run-1", state, storage)
    const restored = readTraceTreePrefs("tile-a", "run-1", storage)
    expect(restored).not.toBeNull()
    expect(serializeTraceOpenState(restored!)).toEqual(serializeTraceOpenState(state))
    expect(deserializeTraceOpenState(serializeTraceOpenState(state)).calls.has(2)).toBe(true)
  })

  it("returns null when missing", () => {
    expect(readTraceTreePrefs("tile-a", "run-missing", memoryStorage())).toBeNull()
  })

  it("keeps in-memory opens when storage was cleared", () => {
    const storage = memoryStorage()
    const state = emptyOpen()
    state.calls.add(1)
    state.phases.add("pipeline")
    writeTraceTreePrefs("tile-a", "run-1", state, storage)
    storage.removeItem("mia:trace-tree-open:tile-a:run-1")
    const restored = readTraceTreePrefs("tile-a", "run-1", storage)
    expect(restored).not.toBeNull()
    expect(restored!.calls.has(1)).toBe(true)
    expect(restored!.phases.has("pipeline")).toBe(true)
  })
})

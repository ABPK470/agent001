import { describe, expect, it } from "vitest"
import {
  clearEventStreamPrefs,
  DEFAULT_EVENT_STREAM_PREFS,
  eventStreamPrefsKey,
  readEventStreamPrefs,
  writeEventStreamPrefs,
} from "./event-stream-prefs"

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
    key: (i) => [...map.keys()][i] ?? null,
  }
}

describe("event-stream-prefs", () => {
  it("keys prefs by tile id", () => {
    expect(eventStreamPrefsKey("tile-1")).toBe("mia:event-stream-prefs:tile-1")
    expect(eventStreamPrefsKey(null)).toBeNull()
  })

  it("round-trips filters and time window", () => {
    const storage = memoryStorage()
    writeEventStreamPrefs(
      "tile-a",
      {
        typeFilters: ["sync", "run"],
        errorsOnly: true,
        searchText: "fail",
        window: { range: "6h", from: "2026-01-01", to: "2026-01-02" },
      },
      storage,
    )
    expect(readEventStreamPrefs("tile-a", storage)).toEqual({
      typeFilters: ["sync", "run"],
      errorsOnly: true,
      searchText: "fail",
      window: { range: "6h", from: "2026-01-01", to: "2026-01-02" },
    })
  })

  it("returns defaults when missing and clears empty prefs", () => {
    const storage = memoryStorage()
    expect(readEventStreamPrefs("missing", storage)).toEqual({
      ...DEFAULT_EVENT_STREAM_PREFS,
      window: { range: "live" },
    })
    writeEventStreamPrefs("tile-b", DEFAULT_EVENT_STREAM_PREFS, storage)
    expect(storage.getItem("mia:event-stream-prefs:tile-b")).toBeNull()
    writeEventStreamPrefs(
      "tile-b",
      { ...DEFAULT_EVENT_STREAM_PREFS, searchText: "x" },
      storage,
    )
    clearEventStreamPrefs("tile-b", storage)
    expect(storage.getItem("mia:event-stream-prefs:tile-b")).toBeNull()
  })
})

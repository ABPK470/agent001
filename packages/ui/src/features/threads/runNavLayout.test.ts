import { describe, expect, it } from "vitest"
import {
  activeBarIndexForRun,
  barTrackHeight,
  collectRunNavMarkers,
  hasRoomForRunMinimap,
  layoutRunNavBars,
  navBarIndexForRun,
  pickNavRunIdForScrollFraction,
  pickNavRunInView,
  rightGutterPx,
  RUN_NAV_BAR_SLOT_MAX,
  scrollTranscriptFraction,
  transcriptOverflows,
  type RunNavMarker,
} from "./runNavLayout"

function mockRect(top: number, height = 600) {
  return {
    top,
    left: 0,
    right: 0,
    bottom: top + height,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function mockTranscript(ids: string[], turnOffsets: number[], scrollTop: number, hostHeight = 600) {
  const hostTop = 100
  const host = {
    scrollTop,
    getBoundingClientRect: () => mockRect(hostTop, hostHeight),
  } as HTMLElement

  const content = {
    querySelector: (sel: string) => {
      const match = sel.match(/data-run-id="([^"]+)"/)
      if (!match) return null
      const idx = ids.indexOf(match[1]!)
      if (idx < 0) return null
      const top = turnOffsets[idx]! - scrollTop + hostTop
      return { getBoundingClientRect: () => mockRect(top) }
    },
  } as unknown as HTMLElement

  return { host, content, ids }
}

describe("transcriptOverflows", () => {
  it("is false when content fits the viewport", () => {
    expect(transcriptOverflows(800, 800)).toBe(false)
  })

  it("is true when content exceeds the viewport", () => {
    expect(transcriptOverflows(800, 900)).toBe(true)
  })
})

describe("scrollTranscriptFraction", () => {
  it("maps scroll position to 0–1", () => {
    const host = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 } as HTMLElement
    expect(scrollTranscriptFraction(host)).toBe(0)
    host.scrollTop = 1200
    expect(scrollTranscriptFraction(host)).toBe(1)
    host.scrollTop = 600
    expect(scrollTranscriptFraction(host)).toBe(0.5)
  })
})

describe("pickNavRunInView", () => {
  const ids = ["r0", "r1", "r2", "r3"]
  const offsets = [0, 500, 1000, 1500]

  it("tracks top, middle, and bottom scroll positions", () => {
    expect(pickNavRunInView(...Object.values(mockTranscript(ids, offsets, 0)))).toBe("r0")
    expect(pickNavRunInView(...Object.values(mockTranscript(ids, offsets, 800)))).toBe("r1")
    expect(pickNavRunInView(...Object.values(mockTranscript(ids, offsets, 1200)))).toBe("r2")
    expect(pickNavRunInView(...Object.values(mockTranscript(ids, offsets, 1600)))).toBe("r3")
  })
})

describe("pickNavRunIdForScrollFraction", () => {
  const markers: RunNavMarker[] = [
    { id: "r0", fraction: 0 },
    { id: "r1", fraction: 0.33 },
    { id: "r2", fraction: 0.66 },
    { id: "r3", fraction: 1 },
  ]

  it("picks the first run at scroll top and last run at scroll bottom", () => {
    expect(pickNavRunIdForScrollFraction(0, markers)).toBe("r0")
    expect(pickNavRunIdForScrollFraction(1, markers)).toBe("r3")
    expect(pickNavRunIdForScrollFraction(0.5, markers)).toBe("r1")
  })
})

describe("navBarIndexForRun", () => {
  it("maps run position to bar slot index", () => {
    const runs = ["r0", "r1", "r2", "r3", "r4"]
    expect(navBarIndexForRun(3, runs, "r0")).toBe(0)
    expect(navBarIndexForRun(3, runs, "r2")).toBe(1)
    expect(navBarIndexForRun(3, runs, "r4")).toBe(2)
    expect(navBarIndexForRun(3, runs, "missing")).toBe(-1)
  })
})

describe("activeBarIndexForRun", () => {
  it("prefers an exact bar id match before proportional fallback", () => {
    const markers: RunNavMarker[] = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      fraction: i / 4,
    }))
    const bars = layoutRunNavBars(markers).bars
    expect(activeBarIndexForRun(bars, markers.map((m) => m.id), "r2")).toBe(2)
    expect(activeBarIndexForRun(bars, markers.map((m) => m.id), "r4")).toBe(4)
  })
})

describe("barTrackHeight", () => {
  it("caps height at the bar slot maximum", () => {
    expect(barTrackHeight(4)).toBeLessThan(barTrackHeight(RUN_NAV_BAR_SLOT_MAX))
    expect(barTrackHeight(40)).toBe(barTrackHeight(RUN_NAV_BAR_SLOT_MAX))
  })
})

describe("collectRunNavMarkers", () => {
  it("uses index-based fractions when a run turn is not mounted yet", () => {
    const host = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      getBoundingClientRect: () => mockRect(100, 400),
    } as HTMLElement

    const content = {
      getBoundingClientRect: () => mockRect(100, 1000),
      querySelector: () => null,
    } as unknown as HTMLElement

    const markers = collectRunNavMarkers(content, host, ["r1", "r2", "r3"])
    expect(markers).toHaveLength(3)
    expect(markers[0]?.fraction).toBe(0)
    expect(markers[1]?.fraction).toBeCloseTo(0.5)
    expect(markers[2]?.fraction).toBe(1)
  })
})

describe("layoutRunNavBars", () => {
  it("maps one bar per run when under the slot cap", () => {
    const layout = layoutRunNavBars([
      { id: "a", fraction: 0.1 },
      { id: "b", fraction: 0.5 },
      { id: "c", fraction: 0.9 },
    ])
    expect(layout.bars).toHaveLength(3)
    expect(layout.hasMore).toBe(false)
  })

  it("samples bars and flags overflow when runs exceed the cap", () => {
    const markers = Array.from({ length: 20 }, (_, i) => ({
      id: `run-${i}`,
      fraction: i / 19,
    }))
    const layout = layoutRunNavBars(markers)
    expect(layout.bars).toHaveLength(RUN_NAV_BAR_SLOT_MAX)
    expect(layout.hasMore).toBe(true)
  })
})

describe("hasRoomForRunMinimap", () => {
  it("requires viewport width and gutter", () => {
    expect(hasRoomForRunMinimap(1400)).toBe(true)
    expect(hasRoomForRunMinimap(1000)).toBe(false)
    expect(rightGutterPx(1400)).toBe(220)
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import { useLayoutStore } from "./layout-store"
import {
  buildSpaceView,
  isProductSpaceAtDefault,
  PRODUCT_SPACES,
  SPACE_LAYOUT_VERSION,
} from "../lib/spaces"

function polluteObserve() {
  const observe = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!)
  const polluted = {
    ...observe,
    split:
      observe.split?.kind === "split"
        ? { ...observe.split, ratio: 0.4 }
        : observe.split,
  }
  useLayoutStore.setState({
    views: [polluted, buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:agent")!)],
    activeViewId: "space:agent",
    focusedTileId: null,
    soloTileId: null,
    zenActive: false,
    zenSet: [],
    zenExtraTiles: [],
    zenSplit: null,
    zenReturnViewId: null,
    zenTileId: null,
    viewportRows: 24,
    spaceLayoutVersion: SPACE_LAYOUT_VERSION,
    consoleIsAdmin: true,
  })
}

describe("layout store space preset", () => {
  beforeEach(() => {
    polluteObserve()
  })

  it("openSpacePreset rebuilds curated defaults in one write", () => {
    const before = useLayoutStore.getState().views.find((v) => v.id === "space:observe")!
    expect(isProductSpaceAtDefault(before, 24)).toBe(false)

    useLayoutStore.getState().openSpacePreset("space:observe", "operation-log")

    const after = useLayoutStore.getState().views.find((v) => v.id === "space:observe")!
    expect(useLayoutStore.getState().activeViewId).toBe("space:observe")
    expect(isProductSpaceAtDefault(after, 24)).toBe(true)
    expect(after.split?.kind === "split" && after.split.ratio).toBeCloseTo(0.7, 2)
    expect(after.tiles[0]?.id).not.toBe(before.tiles[0]?.id)
    expect(
      after.tiles.find((t) => t.id === useLayoutStore.getState().focusedTileId)?.type,
    ).toBe("operation-log")
  })

  it("openSpacePreset restores even when already on that Space", () => {
    useLayoutStore.getState().callSpace("space:observe")
    useLayoutStore.setState({
      views: useLayoutStore.getState().views.map((v) =>
        v.id === "space:observe" && v.split?.kind === "split"
          ? { ...v, split: { ...v.split, ratio: 0.35 } }
          : v,
      ),
    })
    expect(
      isProductSpaceAtDefault(
        useLayoutStore.getState().views.find((v) => v.id === "space:observe")!,
        24,
      ),
    ).toBe(false)

    useLayoutStore.getState().openSpacePreset("space:observe", "operation-log")
    expect(
      isProductSpaceAtDefault(
        useLayoutStore.getState().views.find((v) => v.id === "space:observe")!,
        24,
      ),
    ).toBe(true)
  })

  it("resetActiveSpace delegates to openSpacePreset for the active Space", () => {
    useLayoutStore.getState().callSpace("space:observe")
    useLayoutStore.setState({
      views: useLayoutStore.getState().views.map((v) =>
        v.id === "space:observe" && v.split?.kind === "split"
          ? { ...v, split: { ...v.split, ratio: 0.35 } }
          : v,
      ),
    })
    useLayoutStore.getState().resetActiveSpace()
    expect(
      isProductSpaceAtDefault(
        useLayoutStore.getState().views.find((v) => v.id === "space:observe")!,
        24,
      ),
    ).toBe(true)
  })
})

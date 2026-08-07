import { beforeEach, describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES, SPACE_LAYOUT_VERSION } from "../lib/spaces"
import { isZenViewId } from "../lib/zen-session"
import { useLayoutStore } from "./layout-store"

function seedObserve() {
  const observe = buildSpaceView(
    PRODUCT_SPACES.find((s) => s.id === "space:observe")!,
  )
  useLayoutStore.setState({
    views: [observe],
    activeViewId: "space:observe",
    focusedTileId: observe.tiles[0]?.id ?? null,
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
  return observe
}

describe("layout zen session", () => {
  beforeEach(() => {
    seedObserve()
  })

  it("enter zen sets session fields without mutating Space tiles", () => {
    const before = useLayoutStore.getState().views[0]!
    const tileId = before.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    const s = useLayoutStore.getState()
    expect(s.zenActive).toBe(true)
    expect(s.zenSet).toEqual([tileId])
    expect(s.zenSplit).toEqual({ kind: "leaf", tileId })
    expect(s.views[0]!.tiles.map((t) => t.id)).toEqual(
      before.tiles.map((t) => t.id),
    )
  })

  it("Keep companion adds to zenSet and leaves Space split alone", () => {
    const pipelines = useLayoutStore
      .getState()
      .views[0]!
      .tiles.find((t) => t.type === "operation-log")!
    useLayoutStore.getState().toggleTileZen("space:observe", pipelines.id)
    const splitBefore = useLayoutStore.getState().views[0]!.split
    useLayoutStore.getState().zenKeepWidget("debug-inspector")
    const s = useLayoutStore.getState()
    expect(s.zenSet).toHaveLength(2)
    expect(s.zenExtraTiles.some((t) => t.type === "debug-inspector")).toBe(true)
    expect(s.views[0]!.split).toEqual(splitBefore)
    expect(s.views[0]!.tiles.every((t) => t.type !== "debug-inspector")).toBe(
      true,
    )
  })

  it("Save creates a zen:* view and Call re-enters zen", () => {
    const tileId = useLayoutStore.getState().views[0]!.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    const zenId = useLayoutStore.getState().saveZenSpace("Pair")
    expect(zenId).toBeTruthy()
    expect(isZenViewId(zenId!)).toBe(true)
    useLayoutStore.getState().callSpace("space:observe")
    expect(useLayoutStore.getState().zenActive).toBe(false)
    useLayoutStore.getState().callZenSpace(zenId!)
    const s = useLayoutStore.getState()
    expect(s.zenActive).toBe(true)
    expect(s.activeViewId).toBe(zenId)
    expect(s.zenSet.length).toBeGreaterThan(0)
  })

  it("Esc exit from Called zen:* returns to prior Space", () => {
    const tileId = useLayoutStore.getState().views[0]!.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    const zenId = useLayoutStore.getState().saveZenSpace()!
    useLayoutStore.getState().callSpace("space:observe")
    useLayoutStore.getState().callZenSpace(zenId)
    expect(useLayoutStore.getState().zenReturnViewId).toBe("space:observe")
    useLayoutStore.getState().exitTileZen()
    const s = useLayoutStore.getState()
    expect(s.zenActive).toBe(false)
    expect(s.activeViewId).toBe("space:observe")
  })
})

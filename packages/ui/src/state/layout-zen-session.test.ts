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

  it("Save on an open zen:* updates in place instead of cloning", () => {
    const tileId = useLayoutStore.getState().views[0]!.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    const zenId = useLayoutStore.getState().saveZenSpace("Pair")!
    const beforeCount = useLayoutStore.getState().views.length
    useLayoutStore.getState().zenKeepWidget("live-logs")
    const again = useLayoutStore.getState().saveZenSpace()
    expect(again).toBe(zenId)
    expect(useLayoutStore.getState().views.length).toBe(beforeCount)
    expect(
      useLayoutStore.getState().views.find((v) => v.id === zenId)?.name,
    ).toBe("Pair")
  })

  it("Update Zen Space keeps tile ids and focus (no remount churn)", () => {
    const tileId = useLayoutStore.getState().views[0]!.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    const zenId = useLayoutStore.getState().saveZenSpace("Pair")!
    const before = useLayoutStore.getState()
    const setBefore = [...before.zenSet]
    const focusBefore = before.focusedTileId
    const tileIdsBefore = before.views
      .find((v) => v.id === zenId)!
      .tiles.map((t) => t.id)

    useLayoutStore.getState().saveZenSpace()

    const after = useLayoutStore.getState()
    expect(after.zenSet).toEqual(setBefore)
    expect(after.focusedTileId).toBe(focusBefore)
    expect(after.views.find((v) => v.id === zenId)!.tiles.map((t) => t.id)).toEqual(
      tileIdsBefore,
    )
  })

  it("removeView deletes a Zen Space without killing an unrelated zen session", () => {
    const tileId = useLayoutStore.getState().views[0]!.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    const zenId = useLayoutStore.getState().saveZenSpace("A")!
    useLayoutStore.getState().callSpace("space:observe")
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    expect(useLayoutStore.getState().zenActive).toBe(true)
    useLayoutStore.getState().removeView(zenId)
    const s = useLayoutStore.getState()
    expect(s.views.some((v) => v.id === zenId)).toBe(false)
    expect(s.zenActive).toBe(true)
    expect(s.activeViewId).toBe("space:observe")
  })

  it("M from zen exits immersion into maximize (not the Space grid)", () => {
    const tileId = useLayoutStore.getState().views[0]!.tiles[0]!.id
    useLayoutStore.getState().toggleTileZen("space:observe", tileId)
    expect(useLayoutStore.getState().zenActive).toBe(true)
    expect(useLayoutStore.getState().soloTileId).toBe(tileId)

    useLayoutStore.getState().toggleTileMaximized("space:observe", tileId)

    const s = useLayoutStore.getState()
    expect(s.zenActive).toBe(false)
    expect(s.zenSet).toEqual([])
    expect(s.soloTileId).toBe(tileId)
    expect(s.focusedTileId).toBe(tileId)
  })
})

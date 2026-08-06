import { describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES } from "./spaces"
import {
  clampSpacePreviewAnchor,
  projectSpaceLayoutPreview,
  SPACE_PREVIEW_BOUNDS,
  spacePreviewLeafStyle,
} from "./space-layout-preview"

function space(id: string) {
  return buildSpaceView(PRODUCT_SPACES.find((s) => s.id === id)!)
}

describe("projectSpaceLayoutPreview", () => {
  it("mirrors Observe 70/30 on the fixed canvas", () => {
    const view = space("space:observe")
    const leaves = projectSpaceLayoutPreview(view.split, view.tiles)
    expect(leaves).toHaveLength(2)
    const pipelines = leaves.find((l) => l.type === "operation-log")!
    const stream = leaves.find((l) => l.type === "live-logs")!
    expect(pipelines.rect.w / SPACE_PREVIEW_BOUNDS.w).toBeCloseTo(0.7, 2)
    expect(stream.rect.w / SPACE_PREVIEW_BOUNDS.w).toBeCloseTo(0.3, 2)
  })

  it("mirrors Agent 60/40 Trace | Chat", () => {
    const view = space("space:agent")
    const leaves = projectSpaceLayoutPreview(view.split, view.tiles)
    const trace = leaves.find((l) => l.type === "debug-inspector")!
    const chat = leaves.find((l) => l.type === "term-chat")!
    expect(trace.rect.w / SPACE_PREVIEW_BOUNDS.w).toBeCloseTo(0.6, 2)
    expect(chat.rect.w / SPACE_PREVIEW_BOUNDS.w).toBeCloseTo(0.4, 2)
  })

  it("fills the canvas for single-leaf Trace", () => {
    const view = space("space:trace")
    const leaves = projectSpaceLayoutPreview(view.split, view.tiles)
    expect(leaves).toHaveLength(1)
    expect(leaves[0]!.type).toBe("debug-inspector")
    expect(leaves[0]!.rect).toEqual(SPACE_PREVIEW_BOUNDS)
  })

  it("returns an empty full-bleed leaf when there is no split", () => {
    expect(projectSpaceLayoutPreview(null, [])).toEqual([
      { tileId: "__empty__", type: null, rect: SPACE_PREVIEW_BOUNDS },
    ])
  })
})

describe("spacePreviewLeafStyle", () => {
  it("emits percent boxes relative to the preview bounds", () => {
    expect(
      spacePreviewLeafStyle({ x: 0, y: 0, w: 70, h: 56 }),
    ).toEqual({
      left: "0%",
      top: "0%",
      width: "70%",
      height: "100%",
    })
  })
})

describe("clampSpacePreviewAnchor", () => {
  it("keeps the tab center when the shell fits", () => {
    expect(clampSpacePreviewAnchor(400, 352, 800)).toBe(400)
  })

  it("clamps near the left edge", () => {
    expect(clampSpacePreviewAnchor(40, 352, 800)).toBe(176)
  })

  it("centers in a narrow cluster", () => {
    expect(clampSpacePreviewAnchor(50, 352, 200)).toBe(100)
  })
})

import { describe, expect, it } from "vitest"
import {
  captureSoloFlipForTileId,
  clearSoloFlipFrom,
  soloFlipInvertTransform,
  takeSoloFlipFrom,
} from "./solo-flip.js"

describe("soloFlipInvertTransform", () => {
  it("maps tile → full canvas invert (maximize)", () => {
    const invert = soloFlipInvertTransform(
      { left: 100, top: 80, width: 400, height: 300 },
      { left: 0, top: 0, width: 1200, height: 800 },
    )
    expect(invert).toEqual({
      dx: 100,
      dy: 80,
      sx: 400 / 1200,
      sy: 300 / 800,
    })
  })

  it("maps full canvas → tile invert (restore)", () => {
    const invert = soloFlipInvertTransform(
      { left: 0, top: 0, width: 1200, height: 800 },
      { left: 100, top: 80, width: 400, height: 300 },
    )
    expect(invert).toEqual({
      dx: -100,
      dy: -80,
      sx: 1200 / 400,
      sy: 800 / 300,
    })
  })

  it("skips no-ops and degenerate rects", () => {
    expect(
      soloFlipInvertTransform(
        { left: 10, top: 10, width: 100, height: 100 },
        { left: 10, top: 10, width: 100, height: 100 },
      ),
    ).toBeNull()
    expect(
      soloFlipInvertTransform(
        { left: 0, top: 0, width: 0, height: 100 },
        { left: 0, top: 0, width: 200, height: 100 },
      ),
    ).toBeNull()
  })
})

describe("takeSoloFlipFrom", () => {
  it("starts empty and clears on take", () => {
    clearSoloFlipFrom()
    expect(takeSoloFlipFrom()).toBeNull()
  })
})

describe("captureSoloFlipForTileId", () => {
  it("no-ops when the tile is not in the document", () => {
    clearSoloFlipFrom()
    expect(captureSoloFlipForTileId("missing-tile")).toBe(false)
    expect(takeSoloFlipFrom()).toBeNull()
  })
})

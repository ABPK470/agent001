import { describe, expect, it } from "vitest"
import {
  buildShellMosaicCells,
  SHELL_MOSAIC_COLS,
  SHELL_MOSAIC_ROWS,
  shellMosaicCoverDelayMs,
  shellMosaicCoverMs,
  shellMosaicRevealDelayMs,
  shellMosaicTotalMs,
} from "./shell-mode-mosaic"

describe("shell mode glyph mosaic", () => {
  it("builds a full grid of glyph cells", () => {
    const cells = buildShellMosaicCells()
    expect(cells).toHaveLength(SHELL_MOSAIC_COLS * SHELL_MOSAIC_ROWS)
    expect(cells.every((c) => c.glyph.length === 1)).toBe(true)
  })

  it("covers from the edge and reveals from the center", () => {
    expect(shellMosaicCoverDelayMs(1, 0)).toBeLessThan(shellMosaicCoverDelayMs(0, 0))
    expect(shellMosaicRevealDelayMs(0, 0)).toBeLessThan(shellMosaicRevealDelayMs(1, 0))
  })

  it("runs cover, hold, and reveal in one envelope", () => {
    expect(shellMosaicTotalMs()).toBeGreaterThan(shellMosaicCoverMs())
    expect(shellMosaicTotalMs()).toBeLessThan(2000)
  })
})

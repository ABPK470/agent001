import { describe, expect, it } from "vitest"
import { parseAnswerBlocks } from "./answer-parser"
import {
  STRUCTURED_PENDING_CHART_HEIGHT,
  estimateTablePendingHeight,
  pendingShellMinHeight,
} from "./StreamingBlocks"
import {
  collectEnteringStructuredIndices,
  structuredVisualKey,
} from "./TypewriterAnswer"

describe("pendingShellMinHeight", () => {
  it("sizes table shells like a real CompactTable stage (not a stub)", () => {
    const remainder = "| Name | Amt |\n| --- | --- |\n| Ada | 1 |\n| Bea | 2 |"
    const height = pendingShellMinHeight("table", remainder)
    expect(height).toBeGreaterThanOrEqual(168)
    expect(height).toBe(estimateTablePendingHeight(remainder))
    expect(height).toBeLessThanOrEqual(STRUCTURED_PENDING_CHART_HEIGHT)
  })

  it("keeps chart / kpi / dashboard footprints", () => {
    expect(pendingShellMinHeight("chart")).toBe(STRUCTURED_PENDING_CHART_HEIGHT)
    expect(pendingShellMinHeight("kpi")).toBe(120)
    expect(pendingShellMinHeight("dashboard")).toBe(288)
  })
})

describe("collectEnteringStructuredIndices", () => {
  it("animates newly committed tables only while allowEnter is true", () => {
    const blocks = parseAnswerBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |")
    expect(blocks[0] && structuredVisualKey(blocks[0])).toMatch(/^table:/)

    const seen = new Set<string>()
    const entered = new Set<string>()
    const live = collectEnteringStructuredIndices(blocks, true, seen, entered)
    expect(live.has(0)).toBe(true)

    const again = collectEnteringStructuredIndices(blocks, true, seen, entered)
    expect(again.has(0)).toBe(true) // class stays; animation does not re-fire

    const historySeen = new Set<string>()
    const historyEntered = new Set<string>()
    const history = collectEnteringStructuredIndices(blocks, false, historySeen, historyEntered)
    expect(history.size).toBe(0)
    expect(historySeen.size).toBe(1)
    expect(historyEntered.size).toBe(0)
  })
})

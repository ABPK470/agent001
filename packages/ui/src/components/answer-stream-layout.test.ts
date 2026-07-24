import { describe, expect, it } from "vitest"
import { splitProseRemainder, splitStreamingAnswer } from "./answer-stream-layout"
import { getLiveStreamingRenderParts } from "./answer-stream-reveal"

describe("splitStreamingAnswer", () => {
  it("commits completed lines before an in-flight prose tail", () => {
    const layout = splitStreamingAnswer("## Top bankers\nHere is the")
    expect(layout.committed).toBe("## Top bankers")
    expect(layout.remainder).toBe("Here is the")
    expect(layout.remainderKind).toBe("prose")
  })

  it("commits through a finished heading line ending with newline", () => {
    const layout = splitStreamingAnswer("## Top bankers\n")
    expect(layout.committed).toBe("## Top bankers")
    expect(layout.remainder).toBe("")
    expect(layout.remainderKind).toBe("none")
  })

  it("keeps an open fenced block in the remainder", () => {
    const layout = splitStreamingAnswer("Intro\n```chart\n{")
    expect(layout.committed).toBe("Intro")
    expect(layout.remainderKind).toBe("fenced")
  })

  it("commits a single-line heading before newline arrives", () => {
    const layout = splitStreamingAnswer("## Top bankers")
    expect(layout.committed).toBe("## Top bankers")
    expect(layout.remainder).toBe("")
    expect(layout.remainderKind).toBe("none")
  })

  it("holds a single in-progress table line like a chart fence (pending Table)", () => {
    const layout = splitStreamingAnswer("| Name | Amt |")
    expect(layout.committed).toBe("")
    expect(layout.remainderKind).toBe("table")
    expect(layout.remainder).toBe("| Name | Amt |")
  })

  it("holds a trailing pipe-table until non-table content follows", () => {
    const layout = splitStreamingAnswer(
      "## Results\n| Name | Amt |\n| --- | --- |\n| Ada | 1 |\n| Bea | 2 |",
    )
    expect(layout.committed).toBe("## Results")
    expect(layout.remainderKind).toBe("table")
    expect(layout.remainder).toContain("| Ada | 1 |")
  })

  it("holds through half-typed rows (the chart-fence equivalent)", () => {
    // Previously `|` or `| Ada` broke isTableLine, committed the table, then
    // yanked it back — UI shake. Must stay held like an open ```kpi fence.
    const midPipe = splitStreamingAnswer("| Name | Amt |\n| --- | --- |\n| Ada | 1 |\n|")
    expect(midPipe.remainderKind).toBe("table")
    expect(midPipe.committed).toBe("")

    const midCell = splitStreamingAnswer("| Name | Amt |\n| --- | --- |\n| Ada | 1 |\n| Bea")
    expect(midCell.remainderKind).toBe("table")
    expect(midCell.committed).toBe("")

    const { blocks } = getLiveStreamingRenderParts(
      "| Name | Amt |\n| --- | --- |\n| Ada | 1 |\n| Bea",
    )
    expect(blocks.some((b) => b.type === "table")).toBe(false)
  })

  it("commits a closed table once prose follows", () => {
    const layout = splitStreamingAnswer(
      "| Name | Amt |\n| --- | --- |\n| Ada | 1 |\n\nDone.",
    )
    expect(layout.remainderKind).toBe("prose")
    expect(layout.committed).toContain("| Ada | 1 |")
    expect(layout.remainder).toBe("Done.")
  })

  it("holds a trailing list until the block closes", () => {
    const layout = splitStreamingAnswer("## Results\n- First\n- Sec")
    expect(layout.committed).toBe("## Results")
    expect(layout.remainderKind).toBe("markdown")
    expect(layout.remainder).toBe("- First\n- Sec")
  })
})

describe("splitProseRemainder", () => {
  it("splits complete prose lines from the in-flight line", () => {
    const split = splitProseRemainder("Hello world\nStill typ")
    expect(split.renderable).toBe("Hello world")
    expect(split.inFlight).toBe("Still typ")
  })
})

describe("getLiveStreamingRenderParts", () => {
  it("does not format a trailing list line-by-line", () => {
    const { blocks, glyphTail, layout } = getLiveStreamingRenderParts("## Results\n- First\n- Sec")
    expect(blocks.some((b) => b.type === "heading")).toBe(true)
    expect(blocks.some((b) => b.type === "bullet-list")).toBe(false)
    expect(layout.remainderKind).toBe("markdown")
    expect(glyphTail).toBe("")
  })

  it("does not format a trailing table until it closes", () => {
    const { blocks, layout } = getLiveStreamingRenderParts(
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
    )
    expect(blocks.some((b) => b.type === "table")).toBe(false)
    expect(layout.remainderKind).toBe("table")
  })

  it("keeps an earlier committed table while a later table is still open", () => {
    const text =
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nNotes here.\n\n| C | D |\n| --- | --- |\n| 3 | 4 |"
    const { blocks, layout } = getLiveStreamingRenderParts(text)
    expect(layout.remainderKind).toBe("table")
    expect(layout.remainder).toContain("| C | D |")
    const tables = blocks.filter((b) => b.type === "table")
    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatchObject({
      type: "table",
      headers: ["A", "B"],
    })
    expect(blocks.some((b) => b.type === "paragraph")).toBe(true)
  })

  it("keeps table1 when only a blank line separates it from an open table2", () => {
    const text = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3"
    const { blocks, layout } = getLiveStreamingRenderParts(text)
    expect(layout.remainderKind).toBe("table")
    expect(blocks.filter((b) => b.type === "table")).toHaveLength(1)
  })

  it("ASCII-streams plain prose tails only", () => {
    const { glyphTail } = getLiveStreamingRenderParts("Hello there, this is still arriv")
    expect(glyphTail).toBe("Hello there, this is still arriv")
  })

  it("holds open chart fences without glyphing JSON", () => {
    const { glyphTail, layout } = getLiveStreamingRenderParts("```kpi\n{\"value\":1")
    expect(layout.remainderKind).toBe("fenced")
    expect(glyphTail).toBe("")
  })
})

import { describe, expect, it } from "vitest"
import { splitProseRemainder, splitStreamingAnswer } from "./answer-stream-layout"
import { getLiveStreamingRenderParts } from "./answer-stream-reveal"

describe("splitStreamingAnswer", () => {
  it("commits completed lines before an in-flight tail line", () => {
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
})

describe("splitProseRemainder", () => {
  it("renders complete list lines and glyphs only the in-flight line", () => {
    const split = splitProseRemainder("- Alpha\n- Beta")
    expect(split.renderable).toBe("- Alpha")
    expect(split.inFlight).toBe("- Beta")
  })
})

describe("getLiveStreamingRenderParts", () => {
  it("formats committed bullets while the last item is still arriving", () => {
    const { blocks, glyphTail } = getLiveStreamingRenderParts("## Results\n- First\n- Sec")
    expect(blocks.some((b) => b.type === "heading")).toBe(true)
    expect(blocks.some((b) => b.type === "bullet-list" && b.items.includes("First"))).toBe(true)
    expect(glyphTail).toBe("- Sec")
  })
})

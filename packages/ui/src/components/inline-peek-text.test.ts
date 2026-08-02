import { describe, expect, it } from "vitest"
import { buildPeekDisplay, countHiddenPeekLines } from "./InlinePeekText"

describe("InlinePeekText", () => {
  it("shows full text when short", () => {
    const text = "a\nb\nc"
    expect(buildPeekDisplay(text, 12, 4, false)).toEqual({
      body: text,
      hiddenLines: 0,
      totalLines: 3,
    })
  })

  it("collapses to head and tail with a hidden marker", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `LINE ${i + 1}`)
    const text = lines.join("\n")
    const peek = buildPeekDisplay(text, 12, 4, false)
    expect(peek.hiddenLines).toBe(4)
    expect(peek.totalLines).toBe(20)
    expect(peek.body).toContain("LINE 1")
    expect(peek.body).toContain("LINE 12")
    expect(peek.body).toContain("(4 lines hidden)")
    expect(peek.body).toContain("LINE 17")
    expect(peek.body).toContain("LINE 20")
  })

  it("expands to full body", () => {
    const text = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n")
    const peek = buildPeekDisplay(text, 10, 3, true)
    expect(peek.body).toBe(text)
    expect(peek.hiddenLines).toBe(0)
    expect(countHiddenPeekLines(30, 10, 3)).toBe(17)
  })
})

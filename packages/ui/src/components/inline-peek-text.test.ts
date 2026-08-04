import { describe, expect, it } from "vitest"
import { buildPeekDisplay, countHiddenPeekLines } from "./InlinePeekText"

describe("InlinePeekText", () => {
  it("shows full text when within head lines", () => {
    const text = "a\nb\nc"
    expect(buildPeekDisplay(text, 10, 0, false)).toEqual({
      body: text,
      hiddenLines: 0,
      totalLines: 3,
    })
  })

  it("collapses to the first 10 lines (head-only)", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `LINE ${i + 1}`)
    const text = lines.join("\n")
    const peek = buildPeekDisplay(text, 10, 0, false)
    expect(peek.hiddenLines).toBe(15)
    expect(peek.totalLines).toBe(25)
    expect(peek.body).toBe(lines.slice(0, 10).join("\n"))
    expect(peek.body).not.toContain("LINE 11")
    expect(peek.body).not.toContain("lines hidden")
  })

  it("expands to full body while keeping hidden count for the toggle", () => {
    const text = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n")
    const peek = buildPeekDisplay(text, 10, 0, true)
    expect(peek.body).toBe(text)
    expect(peek.hiddenLines).toBe(20)
    expect(countHiddenPeekLines(30, 10, 0)).toBe(20)
  })

  it("still supports optional head+tail callers", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `LINE ${i + 1}`)
    const text = lines.join("\n")
    const peek = buildPeekDisplay(text, 12, 4, false)
    expect(peek.hiddenLines).toBe(4)
    expect(peek.body).toContain("LINE 12")
    expect(peek.body).toContain("(4 lines hidden)")
    expect(peek.body).toContain("LINE 20")
  })
})

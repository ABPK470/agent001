import { describe, expect, it } from "vitest"
import { advanceByWords, endOfLastCompleteSentence } from "./WordStreamText"

describe("endOfLastCompleteSentence", () => {
  it("returns 0 when no sentence has completed yet", () => {
    expect(endOfLastCompleteSentence("Hello there")).toBe(0)
    expect(endOfLastCompleteSentence("Almost done")).toBe(0)
  })

  it("advances through completed sentences", () => {
    const text = "Hello there. Next one! Third?"
    expect(endOfLastCompleteSentence(text)).toBe(text.length)
    expect(endOfLastCompleteSentence("Hello there. Next")).toBe(13)
  })

  it("treats ellipsis and closing quotes as sentence ends", () => {
    expect(endOfLastCompleteSentence('She said "hi." Then')).toBe(15)
    expect(endOfLastCompleteSentence("Wait… Okay")).toBe(6)
  })

  it("treats paragraph breaks as boundaries", () => {
    expect(endOfLastCompleteSentence("Para one\n\nPara two")).toBe(10)
  })
})

describe("advanceByWords (legacy)", () => {
  it("advances one word and its trailing space", () => {
    expect(advanceByWords("Hello world there", 0, 1)).toBe(6)
    expect(advanceByWords("Hello world there", 6, 1)).toBe(12)
  })
})

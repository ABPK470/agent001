import { describe, expect, it } from "vitest"
import { advanceByWords } from "./WordStreamText"

describe("advanceByWords", () => {
  it("advances one word and its trailing space", () => {
    expect(advanceByWords("Hello world there", 0, 1)).toBe(6)
    expect(advanceByWords("Hello world there", 6, 1)).toBe(12)
  })

  it("advances multiple words", () => {
    expect(advanceByWords("Hello world there", 0, 2)).toBe(12)
    expect(advanceByWords("Hello world there", 0, 99)).toBe("Hello world there".length)
  })

  it("handles newlines as whitespace between words", () => {
    expect(advanceByWords("Hello\nworld", 0, 1)).toBe(6)
  })
})

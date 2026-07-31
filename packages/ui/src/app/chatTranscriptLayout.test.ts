import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { COMPACT_TABLE_WRAPPER_CLASS } from "../components/SmartAnswer"
import {
  FORBIDDEN_HOME_TRANSCRIPT_SCROLL_MASK_CLASSES,
  HOME_TRANSCRIPT_SCROLL_CLASS,
  homeTranscriptScrollClassName,
} from "./chatTranscriptLayout"

const here = dirname(fileURLToPath(import.meta.url))

describe("chatTranscriptLayout", () => {
  it("home transcript scroll does not use mask-image fade classes", () => {
    const scrollClass = homeTranscriptScrollClassName()
    for (const forbidden of FORBIDDEN_HOME_TRANSCRIPT_SCROLL_MASK_CLASSES) {
      expect(scrollClass).not.toContain(forbidden)
    }
    expect(scrollClass).toBe(HOME_TRANSCRIPT_SCROLL_CLASS)
    expect(scrollClass).toContain("overflow-x-hidden")
    expect(scrollClass).not.toContain("overflow-x-auto")
  })

  it("compact markdown tables use inset border shell (not ring)", () => {
    expect(COMPACT_TABLE_WRAPPER_CLASS).toContain("border")
    expect(COMPACT_TABLE_WRAPPER_CLASS).not.toMatch(/\bring-/)
    expect(COMPACT_TABLE_WRAPPER_CLASS).toContain("overflow-x-auto")
    expect(COMPACT_TABLE_WRAPPER_CLASS).toContain("w-full")
    expect(COMPACT_TABLE_WRAPPER_CLASS).toContain("rounded-lg")
    // Full-width table — no flex-1 sibling rail that steals permanent gutter.
    expect(COMPACT_TABLE_WRAPPER_CLASS).not.toContain("flex-1")
  })

  it("markdown fences in answers reuse the same CodeBlock as tool output", () => {
    const src = readFileSync(join(here, "../components/SmartAnswer.tsx"), "utf8")
    const css = readFileSync(join(here, "../boot/index.css"), "utf8")
    const code = readFileSync(join(here, "../components/CodeBlock.tsx"), "utf8")
    const compactFn = src.match(/function CompactCodeBlock[\s\S]*?\n\}/)?.[0] ?? ""
    expect(compactFn).toContain("<CodeBlock")
    expect(compactFn).not.toContain("copyTone")
    expect(compactFn).not.toContain("mia-control")
    expect(code).not.toContain("copyTone")
    expect(code).toMatch(/Copy size=\{12\}/)
    expect(css).toMatch(/\.mia-code-block__copy\s*\{[^}]*border:\s*none/s)
    expect(css).not.toContain("mia-code-block__copy--quiet")
    expect(css).not.toMatch(
      /\.mia-code-block__copy:hover\s*\{[^}]*border-color:/s,
    )
  })
})

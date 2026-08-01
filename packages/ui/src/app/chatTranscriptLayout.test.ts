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

  it("markdown fences and tool I/O share frontier CodeBlock panes", () => {
    const src = readFileSync(join(here, "../components/SmartAnswer.tsx"), "utf8")
    const css = readFileSync(join(here, "../boot/index.css"), "utf8")
    const code = readFileSync(join(here, "../components/CodeBlock.tsx"), "utf8")
    const term = readFileSync(join(here, "../widgets/TermChat.tsx"), "utf8")
    const io = readFileSync(join(here, "../components/tool-code-display.tsx"), "utf8")
    const compactFn = src.match(/function CompactCodeBlock[\s\S]*?\n\}/)?.[0] ?? ""
    expect(compactFn).toContain("<CodeBlock")
    expect(compactFn).toContain("w-fit")
    expect(compactFn).not.toContain("copyTone")
    expect(compactFn).not.toContain("mia-control")
    expect(code).not.toContain("copyTone")
    expect(code).toMatch(/Copy size=\{12\}/)
    expect(css).toMatch(/\.mia-code-block\s*\{[^}]*width:\s*100%/s)
    expect(css).toMatch(/\.mia-code-block\s*\{[^}]*background:\s*var\(--panel-2\)/s)
    expect(css).toMatch(/\.mia-callout\s*\{[^}]*width:\s*fit-content/s)
    expect(css).toMatch(/\.mia-code-block__copy\s*\{[^}]*border:\s*none/s)
    expect(css).not.toContain("mia-code-block__copy--quiet")
    expect(css).not.toMatch(
      /\.mia-code-block__copy:hover\s*\{[^}]*border-color:/s,
    )
    // Input = CodeBlock (column width); success output = bare monospace text.
    expect(term).toContain("ToolIoPane")
    expect(term).toMatch(/role="input"/)
    expect(term).toMatch(/role=\{isError \? "error" : "output"\}/)
    const ioPane = io.match(/export function ToolIoPane[\s\S]*?\n\}\n\nexport interface ParsedTable/)?.[0] ?? ""
    expect(ioPane).toContain('role === "output"')
    expect(ioPane).toContain("<pre")
    expect(ioPane).toContain("w-full")
    expect(ioPane).toContain("return (")
    expect(ioPane).toContain("<CodeBlock")
    expect(ioPane).toContain('"Input"')
    expect(ioPane).not.toContain('"Output"')
    expect(ioPane).not.toContain("ToolResultTable")
    expect(ioPane).not.toContain("parsePipeTable")
    expect(css).toMatch(/\.mia-code-block__body\s*\{[^}]*overscroll-behavior:\s*contain/s)
    expect(io).toContain("overscroll-contain")
    // Wheel at nested I/O edge must not chain into the transcript host.
    expect(term).toMatch(/Nested pane[\s\S]*?event\.preventDefault\(\)/)
    expect(term).not.toMatch(/canElementScrollVertically[\s\S]{0,200}host\.scrollTop \+= event\.deltaY/)
  })
})

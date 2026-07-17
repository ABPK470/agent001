import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  DEFINITION_MODAL_BODY_CLASS,
  DEFINITION_MODAL_FOOTER_CLASS,
  DEFINITION_MODAL_HEADER_CLASS,
  DEFINITION_TABLE_BODY_SCROLL_CLASS,
  DEFINITION_TABLE_HEADER_CLASS,
  DEFINITION_TABLE_SHELL_CLASS,
  FORBIDDEN_DEFINITION_MODAL_BODY_SCROLL_MARKERS,
} from "./definition-content-layout"

const definitionContentPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "DefinitionContent.tsx",
)

function readDefinitionContentSource(): string {
  return readFileSync(definitionContentPath, "utf8")
}

describe("definition-content-layout", () => {
  it("exports stable layout class tokens", () => {
    expect(DEFINITION_MODAL_BODY_CLASS).toContain("overflow-hidden")
    expect(DEFINITION_MODAL_BODY_CLASS).not.toContain("overflow-y-auto")
    expect(DEFINITION_TABLE_BODY_SCROLL_CLASS).toContain("overflow-y-auto")
    expect(DEFINITION_TABLE_HEADER_CLASS).toContain("shrink-0")
    expect(DEFINITION_TABLE_HEADER_CLASS).not.toContain("sticky")
    expect(DEFINITION_TABLE_SHELL_CLASS).toContain("overflow-hidden")
    expect(DEFINITION_MODAL_HEADER_CLASS).toContain("shrink-0")
    expect(DEFINITION_MODAL_FOOTER_CLASS).toContain("shrink-0")
  })

  it("DefinitionContent uses split table shell — header outside scroll body", () => {
    const src = readDefinitionContentSource()
    expect(src).toContain("DEFINITION_MODAL_BODY_CLASS")
    expect(src).toContain("DEFINITION_MODAL_HEADER_CLASS")
    expect(src).toContain("DEFINITION_TABLE_PANEL_CLASS")
    expect(src).toContain("DEFINITION_TABLE_SHELL_CLASS")
    expect(src).toContain("DEFINITION_TABLE_HEADER_CLASS")
    expect(src).toContain("DEFINITION_TABLE_BODY_SCROLL_CLASS")
    expect(src).toContain("DEFINITION_MODAL_FOOTER_CLASS")
    expect(src).toContain('className={DEFINITION_MODAL_BODY_CLASS}')
    expect(src).toContain('className={DEFINITION_TABLE_BODY_SCROLL_CLASS}')

    const headerUseIdx = src.indexOf("className={DEFINITION_TABLE_HEADER_CLASS}")
    const bodyUseIdx = src.indexOf("className={DEFINITION_TABLE_BODY_SCROLL_CLASS}")
    expect(headerUseIdx).toBeGreaterThan(-1)
    expect(bodyUseIdx).toBeGreaterThan(headerUseIdx)

    for (const forbidden of FORBIDDEN_DEFINITION_MODAL_BODY_SCROLL_MARKERS) {
      expect(src).not.toMatch(new RegExp(`className=\\{DEFINITION_MODAL_BODY_CLASS\\}[^\\n]*${forbidden}`))
    }

    expect(src).not.toContain("show-scrollbar")
    expect(src).not.toMatch(/DEFINITION_TABLE_HEADER_CLASS[\s\S]*sticky/)
  })
})

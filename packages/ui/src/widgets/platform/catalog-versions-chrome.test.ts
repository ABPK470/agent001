/**
 * Configuration versions modal — BrowseStrip dialect (px-6 + stable count).
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "CatalogVersionsModal.tsx"), "utf8")
const search = readFileSync(join(here, "../../components/ModalSearchField.tsx"), "utf8")
const css = readFileSync(join(here, "../../boot/index.css"), "utf8")

describe("CatalogVersionsModal chrome", () => {
  it("uses BrowseStrip — not WidgetToolbar", () => {
    expect(src).not.toMatch(/from ["'].*widget-toolbar["']/)
    expect(src).toContain("BrowseStrip")
    expect(src).toContain("BrowseSearchField")
    expect(src).toContain("BrowseCount")
  })
})

describe("ModalSearchField control height", () => {
  it("locks to --control-h so search matches listbox / icon buttons", () => {
    expect(search).toContain("modal-search-field")
    expect(css).toMatch(
      /\.modal-search-field\.input\s*\{[^}]*height:\s*var\(--control-h\)/s,
    )
    expect(search).not.toMatch(/\bpy-2\b/)
  })
})

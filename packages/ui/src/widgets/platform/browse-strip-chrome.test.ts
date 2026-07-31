/**
 * Browse strip dialect — Catalog versions / Sync History / Audit / widget counts.
 * Search flexes; count digit slots + --control-h icons keep trailing geometry still.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { browseCountDigitSlots } from "../../components/BrowseStrip"

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, "../../boot/index.css"), "utf8")
const strip = readFileSync(join(here, "../../components/BrowseStrip.tsx"), "utf8")
const catalog = readFileSync(join(here, "CatalogVersionsModal.tsx"), "utf8")
const history = readFileSync(join(here, "../env-sync/HistoryContent.tsx"), "utf8")
const admin = readFileSync(join(here, "admin-browse-chrome.tsx"), "utf8")
const toolbar = readFileSync(join(here, "../widget-toolbar.tsx"), "utf8")

describe("browseCountDigitSlots", () => {
  it("reserves at least two digits and grows with the wider tally", () => {
    expect(browseCountDigitSlots(5, 5)).toBe(2)
    expect(browseCountDigitSlots(9, 99)).toBe(2)
    expect(browseCountDigitSlots(100, 100)).toBe(3)
    expect(browseCountDigitSlots(3, 1000)).toBe(4)
  })
})

describe("BrowseStrip chrome", () => {
  it("defines modal strip + reserved count + control-h icons", () => {
    expect(css).toMatch(/\.browse-strip\s*\{[^}]*padding:\s*0\.75rem 1\.5rem/s)
    expect(css).toContain("--browse-count-slots")
    expect(css).toContain("browse-count--single")
    expect(css).toContain("browse-count--split")
    expect(css).toMatch(/\.modal-search-field\.input\s*\{[^}]*height:\s*var\(--control-h\)/s)
    expect(strip).toContain("BrowseCount")
    expect(strip).toContain("browse-count--single")
    expect(strip).toContain("BrowseIconButton")
  })

  it("Catalog versions / Sync History / Audit share BrowseStrip", () => {
    expect(catalog).toContain("BrowseStrip")
    expect(catalog).toContain("BrowseCount")
    expect(history).toContain("BrowseStrip")
    expect(history).toContain("BrowseCount")
    expect(admin).toContain("BrowseStrip")
    expect(admin).toContain("BrowseIconButton")
  })

  it("WidgetToolbarCount is BrowseCount (widgets stay on the same tally dialect)", () => {
    expect(toolbar).toContain("BrowseCount")
    expect(toolbar).toMatch(/function WidgetToolbarCount[\s\S]*?<BrowseCount/)
  })
})

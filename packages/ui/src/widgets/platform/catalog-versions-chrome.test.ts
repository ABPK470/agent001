/**
 * Configuration versions modal — toolbar inset must match ModalShell body (px-6).
 * Widget-shell px-3 left the search strip misaligned with the version list.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "CatalogVersionsModal.tsx"), "utf8")

describe("CatalogVersionsModal chrome", () => {
  it("toolbar / chips / list share ModalShell px-6 — not widget-shell px-3", () => {
    expect(src).toMatch(/WidgetToolbar className="px-6 py-3"/)
    expect(src).not.toMatch(/WidgetToolbar className="[^"]*px-3/)
    expect(src).toMatch(/<div className="px-6">\s*<ActiveFilterChips/s)
    expect(src).toMatch(/flex min-h-0 flex-1 flex-col gap-3 px-6/)
  })
})

/**
 * Sync History modal — BrowseStrip dialect (same as Catalog versions / Audit).
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "HistoryContent.tsx"), "utf8")

describe("Sync History modal chrome", () => {
  it("uses BrowseStrip — not WidgetToolbar", () => {
    expect(src).not.toMatch(/from ["'].*widget-toolbar["']/)
    expect(src).toContain("BrowseStrip")
    expect(src).toContain("BrowseCount")
    expect(src).toMatch(/overflow-y-auto px-6 pb-4 pt-3/)
  })
})

/**
 * Configuration versions modal — browse strip must match ModalShell body (px-6).
 * WidgetToolbar is wrong here: it assumes a widget shell owns horizontal inset.
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
  it("uses Audit-style modal browse strip — not WidgetToolbar", () => {
    expect(src).not.toMatch(/from ["'].*widget-toolbar["']/)
    expect(src).toContain("ModalSearchField")
    expect(src).toMatch(
      /flex shrink-0 items-center gap-2 border-b border-border-subtle px-6 py-3/,
    )
    expect(src).toMatch(/flex min-h-0 flex-1 flex-col gap-3[^"]*px-6/)
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

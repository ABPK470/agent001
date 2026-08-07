/**
 * Summon keyboard ownership — commands must not depend on search-input focus.
 * Mouse peek / hover must not strand ↑↓←→ / ⌘↵.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, "SummonPalette.tsx"), "utf8")

describe("Summon keyboard ownership", () => {
  it("owns nav + land on window capture, not the search input", () => {
    expect(src).toContain('window.addEventListener("keydown", onKeyDown, true)')
    expect(src).toContain('event.key === "ArrowDown"')
    expect(src).toContain('event.key === "ArrowUp"')
    expect(src).toContain("shouldSummonFilterArrow")
    expect(src).toContain("landRef.current(event.metaKey || event.ctrlKey)")
    // Search field must not be the sole owner of list/filter keys.
    expect(src).not.toContain("onKeyDown={onInputKeyDown}")
  })

  it("restores search focus when peek peels", () => {
    expect(src).toContain("Peek peels → restore Summon")
    expect(src).toContain("inputRef.current?.focus()")
  })
})

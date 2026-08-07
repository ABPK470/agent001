/**
 * Trace operator keyboard — source contracts for Esc ownership and focus scroll.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const hooks = join(here, "../../hooks")

describe("trace operator keyboard contracts", () => {
  it("shares pane focus / Esc with review operator keyboard (claim, no window listen)", () => {
    const shared = readFileSync(join(hooks, "useReviewOperatorKeyboard.ts"), "utf8")
    expect(shared).toContain("preventScroll: true")
    expect(shared).toContain("resolveEscLadder")
    expect(shared).toContain("useClaimOperatorSurface")
    expect(shared).toContain("section-toggle")
    expect(shared).not.toContain("window.addEventListener")

    const operator = readFileSync(join(here, "use-trace-operator-keyboard.ts"), "utf8")
    expect(operator).toContain("useReviewOperatorKeyboard")
    expect(operator).toContain("Backslash")
    expect(operator).toContain("beforePaneRef")
    expect(operator).not.toContain('lateral: "tabs"')
    expect(operator).not.toContain("window.addEventListener")
  })

  it("gates tree keys on focusedPane === tree via treeNav", () => {
    const dag = readFileSync(join(here, "TraceDag.tsx"), "utf8")
    expect(dag).toContain('focusedPane === "tree"')
    expect(dag).toContain("useTraceOperatorKeyboard")
    expect(dag).toContain("treeNav:")
    expect(dag).toContain("is-pane-focused")
    expect(dag).toContain("DetailSectionProvider")
    expect(dag).not.toContain("useTraceZenHotkeys")
    expect(dag).not.toContain("useTraceTreeKeyboard")
  })

  it("does not bind fold-all to bare [ ] (detail sections own those keys)", () => {
    const zen = readFileSync(join(here, "../../lib/keymap/resolve-trace-zen-keyboard.ts"), "utf8")
    expect(zen).not.toContain('type: "fold-all"')
    expect(zen).not.toContain("onFoldModeChange")
    expect(zen).not.toMatch(/key === ["']\[|"\]"/)
  })

  it("arms Trace via shared operator-surface gate (tile focus, zen, or peek)", () => {
    const dag = readFileSync(join(here, "TraceDag.tsx"), "utf8")
    expect(dag).toContain("useOperatorSurfaceArmed")
    expect(dag).not.toContain("!keymapSheetOpen")
    expect(dag).not.toContain("&& !modalWidget")
  })
})

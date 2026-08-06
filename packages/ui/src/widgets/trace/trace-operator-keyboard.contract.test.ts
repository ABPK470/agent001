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
  it("shares pane focus / Esc with review operator keyboard", () => {
    const shared = readFileSync(join(hooks, "useReviewOperatorKeyboard.ts"), "utf8")
    expect(shared).toContain("preventScroll: true")
    expect(shared).toContain("resolveEscLadder")
    expect(shared).toContain("stopPropagation")
    expect(shared).toContain("section-toggle")

    const operator = readFileSync(join(here, "use-trace-operator-keyboard.ts"), "utf8")
    expect(operator).toContain("useReviewOperatorKeyboard")
    expect(operator).toContain('lateral: "tabs"')
    expect(operator).toContain("Backslash")
  })

  it("gates tree keys on focusedPane === tree", () => {
    const dag = readFileSync(join(here, "TraceDag.tsx"), "utf8")
    expect(dag).toContain('focusedPane === "tree"')
    expect(dag).toContain("useTraceOperatorKeyboard")
    expect(dag).toContain("is-pane-focused")
    expect(dag).toContain("DetailSectionProvider")
  })

  it("keeps Trace fold-all [ ] on the tree pane only", () => {
    const zen = readFileSync(join(here, "use-trace-zen-hotkeys.ts"), "utf8")
    expect(zen).toContain('focusedPane !== "tree"')
    expect(zen).toContain('key === "["')
    expect(zen).toContain("onFoldModeChange")
  })
})


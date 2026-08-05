/**
 * Trace operator keyboard — source contracts for Esc ownership and focus scroll.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

describe("trace operator keyboard contracts", () => {
  it("focuses panes with preventScroll and owns Esc outside zen hotkeys", () => {
    const operator = readFileSync(join(here, "use-trace-operator-keyboard.ts"), "utf8")
    expect(operator).toContain("preventScroll: true")
    expect(operator).toContain("resolveEscLadder")
    expect(operator).toContain("stopPropagation")
  })

  it("gates tree keys on focusedPane === tree", () => {
    const dag = readFileSync(join(here, "TraceDag.tsx"), "utf8")
    expect(dag).toContain('focusedPane === "tree"')
    expect(dag).toContain("useTraceOperatorKeyboard")
    expect(dag).toContain("is-pane-focused")
  })
})

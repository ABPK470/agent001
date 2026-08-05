import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { TRACE_EXPAND_PRE_CLASS } from "./TraceExpandable"

const here = dirname(fileURLToPath(import.meta.url))

describe("ExpandableText wrap ownership", () => {
  it("owns a stable wrap class independent of caller className", () => {
    expect(TRACE_EXPAND_PRE_CLASS).toBe("trace-expand__pre")
    const src = readFileSync(resolve(here, "TraceExpandable.tsx"), "utf8")
    expect(src).toContain("TRACE_EXPAND_PRE_CLASS")
    expect(src).toMatch(/className=\{\[[\s\S]*TRACE_EXPAND_PRE_CLASS/)
  })

  it("CSS wrap lives on the component class, not only on call-site skins", () => {
    const css = readFileSync(resolve(here, "../../boot/index.css"), "utf8")
    expect(css).toMatch(
      /\.trace-expand__pre\s*\{[^}]*white-space:\s*pre-wrap/s,
    )
    expect(css).toMatch(
      /\.trace-expand__pre\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    )
    expect(css).toMatch(/\.trace-expand__pre\s*\{[^}]*min-width:\s*0/s)
  })
})

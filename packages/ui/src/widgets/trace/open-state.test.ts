import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  callToolOpenKey,
  emptyOpen,
  seedLatest,
  workToolOpenKey,
} from "./open-state.js"

describe("open-state", () => {
  it("starts collapsed with empty sets", () => {
    const o = emptyOpen()
    expect(o.preamble).toBe(false)
    expect(o.calls.size).toBe(0)
    expect(o.messages.size).toBe(0)
    expect(o.foldMode).toBe("collapsed")
  })

  it("seedLatest opens only the last call", () => {
    expect(seedLatest(0).calls.size).toBe(0)
    const o = seedLatest(3)
    expect([...o.calls]).toEqual([2])
    expect(o.sent.size).toBe(0)
  })

  it("tool open keys are parent-scoped (Call proposed ≠ Work executed)", () => {
    const id = "tc-shared"
    expect(callToolOpenKey(0, id)).toBe("call:0:tool:tc-shared")
    expect(workToolOpenKey("work-0", id)).toBe("work-0:tool:tc-shared")
    expect(callToolOpenKey(0, id)).not.toBe(workToolOpenKey("work-0", id))
    expect(callToolOpenKey(0, id)).not.toBe(callToolOpenKey(1, id))
  })

  it("Call / Work / fold expand wire parent-scoped tool keys", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const call = readFileSync(join(here, "TraceCall.tsx"), "utf8")
    const work = readFileSync(join(here, "TraceWork.tsx"), "utf8")
    const tree = readFileSync(join(here, "trace-tree-index.ts"), "utf8")
    expect(call).toContain("callToolOpenKey(call.index, tc.id)")
    expect(work).toContain("workToolOpenKey(work.id, tool.id)")
    expect(tree).toContain("callToolOpenKey(call.index, tool.id)")
    expect(tree).toContain("workToolOpenKey(work.id, tool.id)")
    // Bare toolCallId in the open set would collapse Call+Work together.
    expect(call).not.toMatch(/openState\.tools\.has\(\s*tc\.id\s*\)/)
    expect(work).not.toMatch(/openState\.tools\.has\(\s*tool\.id\s*\)/)
  })
})

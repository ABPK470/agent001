import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  callToolOpenKey,
  collapsedOpenState,
  emptyOpen,
  expandedOpenState,
  openStateForFoldMode,
  seedLatest,
  workToolOpenKey,
} from "./open-state.js"
import { buildTraceDag } from "./build-trace-dag.js"

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
    const zenHud = readFileSync(join(here, "TraceZenHud.tsx"), "utf8")
    const foldToggle = readFileSync(join(here, "TraceTreeFoldToggle.tsx"), "utf8")
    expect(call).toContain("callToolOpenKey(call.index, tc.id)")
    expect(work).toContain("workToolOpenKey(work.id, tool.id)")
    expect(tree).toContain("callToolOpenKey(call.index, tool.id)")
    expect(tree).toContain("workToolOpenKey(work.id, tool.id)")
    expect(zenHud).toContain("TraceTreeFoldToggle")
    expect(foldToggle).toContain("onFoldModeChange")
    // Bare toolCallId in the open set would collapse Call+Work together.
    expect(call).not.toMatch(/openState\.tools\.has\(\s*tc\.id\s*\)/)
    expect(work).not.toMatch(/openState\.tools\.has\(\s*tool\.id\s*\)/)
  })

  it("expandedOpenState opens all calls, phases, and work", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "sys" },
      {
        kind: "llm-request",
        iteration: 0,
        messageCount: 1,
        toolCount: 0,
        messages: [{ role: "user", content: "hi", toolCalls: [], toolCallId: null }],
      },
      {
        kind: "llm-response",
        iteration: 0,
        durationMs: 50,
        content: "ok",
        toolCalls: [{ id: "t1", name: "ask_user", arguments: {} }],
        usage: null,
      },
      {
        kind: "tool-call",
        invocationId: "i1",
        toolCallId: "t1",
        tool: "ask_user",
        argsSummary: "",
        argsFormatted: "{}",
      },
      { kind: "tool-result", invocationId: "i1", toolCallId: "t1", text: "yes" },
    ])
    const expanded = expandedOpenState(dag)
    expect(expanded.foldMode).toBe("expanded")
    expect(expanded.preamble).toBe(true)
    expect(expanded.calls.has(0)).toBe(true)
    expect(expanded.sent.has(0)).toBe(true)
    expect(expanded.received.has(0)).toBe(true)
    expect(expanded.work.size).toBeGreaterThan(0)

    const collapsed = collapsedOpenState()
    expect(collapsed.foldMode).toBe("collapsed")
    expect(collapsed.calls.size).toBe(0)
    expect(openStateForFoldMode(dag, "expanded").foldMode).toBe("expanded")
  })
})

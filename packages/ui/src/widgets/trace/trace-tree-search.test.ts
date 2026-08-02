import { describe, expect, it } from "vitest"
import { buildTraceDag } from "./build-trace-dag"
import { emptyOpen } from "./open-state"
import { buildTraceTreeIndex } from "./trace-tree-index"
import { buildTraceTreeSearch } from "./trace-tree-search"

function llmRequest(iteration: number) {
  return {
    kind: "llm-request" as const,
    iteration,
    messageCount: 1,
    toolCount: 0,
    messages: [{ role: "user", content: "Build a site", toolCalls: [], toolCallId: null }],
  }
}

function llmResponse(
  iteration: number,
  extra: {
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    content?: string | null
  } = {},
) {
  return {
    kind: "llm-response" as const,
    iteration,
    durationMs: 100,
    content: extra.content ?? null,
    toolCalls: extra.toolCalls ?? [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

describe("buildTraceTreeSearch", () => {
  it("hides non-matching phases and context when filtering by tool name", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "You are Mia" },
      {
        kind: "tools-resolved",
        tools: [{ name: "query_mssql", description: "SQL", parameters: {} }],
      },
      {
        kind: "planner-phase",
        family: "plan",
        title: "Plan",
        summary: "Subagent mode",
        status: "done" as const,
      },
      llmRequest(0),
      llmResponse(0, {
        toolCalls: [{ id: "t1", name: "ask_user", arguments: { question: "Colors?" } }],
      }),
      {
        kind: "tool-call",
        invocationId: "i1",
        toolCallId: "t1",
        tool: "ask_user",
        argsSummary: "",
        argsFormatted: "{}",
      },
      { kind: "tool-result", invocationId: "i1", toolCallId: "t1", text: "navy" },
    ])

    const search = buildTraceTreeSearch(dag, "ask_user", null, null)
    expect(search).not.toBeNull()

    const open = emptyOpen()
    open.preamble = true
    open.contextTools = true
    for (const entry of dag.spine) {
      if (entry.kind === "phase") open.phases.add(entry.phase.id)
    }

    const unfiltered = buildTraceTreeIndex(dag, open, null)
    const filtered = buildTraceTreeIndex(dag, open, search)

    expect(unfiltered.nodes.some((n) => n.name === "Context")).toBe(true)

    expect(filtered.nodes.some((n) => n.name === "Context")).toBe(false)
    expect(filtered.nodes.some((n) => n.kind === "work" && n.name.includes("ask_user"))).toBe(
      true,
    )
  })

  it("matches work by tool name even when the call headline differs", () => {
    const dag = buildTraceDag([
      llmRequest(0),
      llmResponse(0, { toolCalls: [{ id: "t1", name: "ask_user", arguments: {} }] }),
      {
        kind: "tool-call",
        invocationId: "i1",
        toolCallId: "t1",
        tool: "ask_user",
        argsSummary: "",
        argsFormatted: "{}",
      },
      { kind: "tool-result", invocationId: "i1", toolCallId: "t1", text: "ok" },
    ])

    const search = buildTraceTreeSearch(dag, "ask_user", null, null)!
    expect(search.matchedWorkIds.size).toBeGreaterThan(0)

    const open = emptyOpen()
    open.work = search.matchedWorkIds
    open.calls.add(0)
    open.received.add(0)

    const index = buildTraceTreeIndex(dag, open, search)
    expect(index.nodes.some((n) => n.kind === "work")).toBe(true)
  })

  it("shows context when a resolved tool name matches", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "sys" },
      {
        kind: "tools-resolved",
        tools: [{ name: "query_mssql", description: "Run SQL", parameters: {} }],
      },
    ])

    const search = buildTraceTreeSearch(dag, "query_mssql", null, null)!
    expect(search.contextVisible).toBe(true)
    expect(search.contextToolsVisible).toBe(true)

    const open = emptyOpen()
    open.preamble = true
    open.contextTools = true
    const index = buildTraceTreeIndex(dag, open, search)
    expect(index.nodes.some((n) => n.kind === "context")).toBe(true)
    expect(index.nodes.some((n) => n.kind === "tools")).toBe(true)
  })

  it("returns empty tree for unrelated queries", () => {
    const dag = buildTraceDag([
      { kind: "system-prompt", text: "sys" },
      llmRequest(0),
      llmResponse(0),
    ])

    const search = buildTraceTreeSearch(dag, "zzzznotfound", null, null)!
    const index = buildTraceTreeIndex(dag, emptyOpen(), search)
    expect(index.nodes).toHaveLength(0)
  })
})

import { describe, expect, it } from "vitest"
import type { TraceEntry } from "../../types"
import { buildTraceDag } from "./build-trace-dag"
import {
  buildCallCompareSnapshot,
  formatSentMessages,
  nodeSupportsCompare,
  priorRunsInThread,
  previousRunInThread,
  resolveCompareCallIndex,
} from "./trace-run-compare"
import type { TraceTreeNode } from "./trace-tree-index"

type LlmRequest = Extract<TraceEntry, { kind: "llm-request" }>

function llmRequest(
  iteration: number,
  messages: LlmRequest["messages"] = [],
): LlmRequest {
  return {
    kind: "llm-request",
    iteration,
    messageCount: messages.length,
    toolCount: 0,
    messages,
  }
}

function llmResponse(
  iteration: number,
  opts: {
    content?: string | null
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  } = {},
): Extract<TraceEntry, { kind: "llm-response" }> {
  return {
    kind: "llm-response",
    iteration,
    durationMs: 100,
    content: opts.content ?? null,
    toolCalls: opts.toolCalls ?? [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
}

const runs = [
  { id: "a", threadId: "t1", createdAt: "2026-01-01T10:00:00Z" },
  { id: "b", threadId: "t1", createdAt: "2026-01-01T11:00:00Z" },
  { id: "c", threadId: "t1", createdAt: "2026-01-01T12:00:00Z" },
  { id: "d", threadId: "t2", createdAt: "2026-01-01T12:00:00Z" },
]

describe("priorRunsInThread", () => {
  it("returns only older runs in the same thread, newest prior first", () => {
    expect(priorRunsInThread(runs, "c").map((r) => r.id)).toEqual(["b", "a"])
    expect(priorRunsInThread(runs, "b").map((r) => r.id)).toEqual(["a"])
    expect(priorRunsInThread(runs, "a").map((r) => r.id)).toEqual([])
  })

  it("previousRunInThread is the immediate chronological predecessor", () => {
    expect(previousRunInThread(runs, "c")).toBe("b")
    expect(previousRunInThread(runs, "b")).toBe("a")
    expect(previousRunInThread(runs, "a")).toBeNull()
  })

  it("does not pick a newer sibling when viewing an older run", () => {
    expect(previousRunInThread(runs, "b")).not.toBe("c")
  })
})

describe("buildCallCompareSnapshot", () => {
  it("includes full sent history and tool output", () => {
    const dag = buildTraceDag([
      llmRequest(0, [
        { role: "system", content: "Sys", toolCalls: [], toolCallId: null },
        { role: "user", content: "First ask", toolCalls: [], toolCallId: null },
        { role: "assistant", content: "Mid", toolCalls: [], toolCallId: null },
        { role: "user", content: "Follow up", toolCalls: [], toolCallId: null },
      ]),
      llmResponse(0, {
        toolCalls: [{ id: "t1", name: "ask_user", arguments: { q: "?" } }],
      }),
    ])
    const node = {
      scopeId: "sent:0",
      kind: "sent",
      callIndex: 0,
    } as TraceTreeNode
    const snap = buildCallCompareSnapshot(dag, 0, node)
    expect(snap?.system).toBe("Sys")
    expect(snap?.sent).toContain("First ask")
    expect(snap?.sent).toContain("Follow up")
    expect(snap?.output).toContain("ask_user")
  })
})

describe("formatSentMessages", () => {
  it("skips system role in sent block", () => {
    const text = formatSentMessages([
      { role: "system", content: "hidden", toolCalls: [], toolCallId: null, speaker: "System" },
      { role: "user", content: "hi", toolCalls: [], toolCallId: null, speaker: "User" },
    ])
    expect(text).not.toContain("hidden")
    expect(text).toContain("hi")
  })
})

describe("resolveCompareCallIndex", () => {
  it("uses phase first call child when phase node has no callIndex", () => {
    const dag = buildTraceDag([
      { kind: "planner-step-start", stepName: "api_layer", stepType: "subagent_task" },
      llmRequest(0),
      llmResponse(0),
      {
        kind: "planner-step-end",
        stepName: "api_layer",
        status: "pass",
        durationMs: 100,
      },
    ])
    const step = dag.spine.find(
      (e) => e.kind === "phase" && e.phase.family.startsWith("step:"),
    )
    expect(step?.kind).toBe("phase")
    if (step?.kind !== "phase") return
    const node = {
      scopeId: step.phase.id,
      kind: "phase",
      phaseId: step.phase.id,
      callIndex: null,
    } as TraceTreeNode
    expect(resolveCompareCallIndex(dag, node)).toBe(0)
    expect(nodeSupportsCompare(dag, node)).toBe(true)
  })
})

import type { LLMClient, LLMResponse, Message, Tool } from "@mia/agent"
import { describe, expect, it, vi } from "vitest"

import {
    extractObservedQnames,
    runReflectionTurn,
    type ReflectionStep,
} from "../src/orchestrator/run-reflection.js"

// ── helpers ──────────────────────────────────────────────────────

const fakeVerdictTool = (
  execute: (args: Record<string, unknown>) => Promise<string>,
): Tool => ({
  name: "record_table_verdict",
  description: "stub",
  parameters: {
    type: "object",
    properties: {
      qname: { type: "string" },
      role:  { type: "string" },
    },
    required: ["qname", "role"],
  },
  execute,
})

const fakeLlm = (response: LLMResponse): LLMClient => ({
  chat: vi.fn(async (_messages: Message[], _tools: Tool[]) => response),
})

const step = (action: string, input: unknown, output: unknown = ""): ReflectionStep => ({
  action,
  input,
  output,
})

// ── extractObservedQnames ────────────────────────────────────────

describe("extractObservedQnames", () => {
  it("returns empty when no allowed tool was used", () => {
    expect(extractObservedQnames([step("note", { qname: "publish.Revenue" })])).toEqual([])
  })

  it("extracts qnames from query_mssql input.sql", () => {
    const qs = extractObservedQnames([
      step("query_mssql", { sql: "SELECT * FROM publish.Revenue WHERE x=1" }),
    ])
    expect(qs).toContain("publish.Revenue")
  })

  it("extracts qnames from search_catalog output JSON", () => {
    const qs = extractObservedQnames([
      step("search_catalog", { query: "revenue" }, JSON.stringify({
        hits: [{ table: "publish.Revenue" }, { table: "publish.RevenueESGRules" }],
      })),
    ])
    expect(qs).toContain("publish.Revenue")
    expect(qs).toContain("publish.RevenueESGRules")
  })

  it("deduplicates and caps at 25", () => {
    const inputs = Array.from({ length: 40 }, (_, i) => ({ sql: `SELECT FROM publish.T${i}` }))
    const steps  = inputs.map((s) => step("query_mssql", s))
    expect(extractObservedQnames(steps)).toHaveLength(25)
  })

  it("ignores tools outside the scan list", () => {
    expect(extractObservedQnames([step("read_files", { sql: "publish.Revenue" })])).toEqual([])
  })
})

// ── runReflectionTurn ────────────────────────────────────────────

describe("runReflectionTurn", () => {
  it("skips when no qnames observed", async () => {
    const llm = fakeLlm({ content: null, toolCalls: [] })
    const tool = fakeVerdictTool(async () => "record_table_verdict: stored (id=1)")
    const r = await runReflectionTurn({
      runId: "r1", goal: "g", answer: "a",
      steps: [step("note", {})],
      recordVerdictTool: tool, llm,
    })
    expect(r.outcome).toBe("skipped")
    expect(llm.chat).not.toHaveBeenCalled()
  })

  it("returns no-update when model replies 'no-update'", async () => {
    const llm = fakeLlm({ content: "no-update", toolCalls: [] })
    const tool = fakeVerdictTool(async () => "record_table_verdict: stored (id=1)")
    const r = await runReflectionTurn({
      runId: "r1", goal: "g", answer: "a",
      steps: [step("query_mssql", { sql: "FROM publish.Revenue" })],
      recordVerdictTool: tool, llm,
    })
    expect(r.outcome).toBe("no-update")
    expect(r.verdictsRecorded).toBe(0)
  })

  it("records verdict when model calls record_table_verdict", async () => {
    const calls: Array<Record<string, unknown>> = []
    const tool = fakeVerdictTool(async (args) => {
      calls.push(args)
      return "record_table_verdict: stored (id=42) — publish.Revenue → canonical"
    })
    const llm = fakeLlm({
      content: null,
      toolCalls: [
        { id: "tc1", name: "record_table_verdict", arguments: {
          qname: "publish.Revenue", role: "canonical",
          evidence: ["270M rows; UNION view"],
        } },
      ],
    })
    const r = await runReflectionTurn({
      runId: "r1", goal: "top products by revenue", answer: "...",
      steps: [step("query_mssql", { sql: "FROM publish.Revenue" })],
      recordVerdictTool: tool, llm,
    })
    expect(r.outcome).toBe("recorded")
    expect(r.verdictsRecorded).toBe(1)
    expect(calls[0]).toMatchObject({ qname: "publish.Revenue", role: "canonical" })
  })

  it("caps tool calls at 2", async () => {
    const tool = fakeVerdictTool(async () => "record_table_verdict: stored (id=1)")
    const llm = fakeLlm({
      content: null,
      toolCalls: Array.from({ length: 5 }, (_, i) => ({
        id: `tc${i}`, name: "record_table_verdict",
        arguments: { qname: `publish.T${i}`, role: "canonical", evidence: ["x"] },
      })),
    })
    const r = await runReflectionTurn({
      runId: "r1", goal: "g", answer: "a",
      steps: [step("query_mssql", { sql: "FROM publish.Revenue" })],
      recordVerdictTool: tool, llm,
    })
    expect(r.verdictsRecorded).toBe(2)
    expect(r.toolResults).toHaveLength(2)
  })

  it("rejects non-allowed tool names", async () => {
    const tool = fakeVerdictTool(async () => "record_table_verdict: stored (id=1)")
    const llm = fakeLlm({
      content: null,
      toolCalls: [
        { id: "tc1", name: "query_mssql", arguments: { sql: "DROP TABLE X" } },
      ],
    })
    const r = await runReflectionTurn({
      runId: "r1", goal: "g", answer: "a",
      steps: [step("query_mssql", { sql: "FROM publish.Revenue" })],
      recordVerdictTool: tool, llm,
    })
    expect(r.verdictsRecorded).toBe(0)
    expect(r.toolResults[0]).toContain("skipped non-allowed tool")
  })

  it("does not throw when llm.chat rejects", async () => {
    const llm: LLMClient = { chat: vi.fn(async () => { throw new Error("boom") }) }
    const tool = fakeVerdictTool(async () => "record_table_verdict: stored (id=1)")
    const r = await runReflectionTurn({
      runId: "r1", goal: "g", answer: "a",
      steps: [step("query_mssql", { sql: "FROM publish.Revenue" })],
      recordVerdictTool: tool, llm,
    })
    expect(r.outcome).toBe("error")
    expect(r.detail).toContain("boom")
  })

  it("does not throw when verdict tool execute() rejects", async () => {
    const tool = fakeVerdictTool(async () => { throw new Error("write failed") })
    const llm = fakeLlm({
      content: null,
      toolCalls: [
        { id: "tc1", name: "record_table_verdict",
          arguments: { qname: "publish.Revenue", role: "canonical", evidence: ["x"] } },
      ],
    })
    const r = await runReflectionTurn({
      runId: "r1", goal: "g", answer: "a",
      steps: [step("query_mssql", { sql: "FROM publish.Revenue" })],
      recordVerdictTool: tool, llm,
    })
    expect(r.outcome).toBe("no-update")
    expect(r.verdictsRecorded).toBe(0)
    expect(r.toolResults[0]).toContain("execute threw")
  })
})

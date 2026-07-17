import { describe, expect, it } from "vitest"
import type { AgentHost } from "../src/runtime/runtime.js"
import { createListAdaptersTool, createBridgeDataTool } from "../src/tools/bridge/index.js"
import type { ConnectorInfo, MoveSummary } from "@mia/shared-types"

function hostWith(port: AgentHost["connectors"]["port"]["value"]): AgentHost {
  return { connectors: { port: { value: port } } } as unknown as AgentHost
}

const adapters: ConnectorInfo[] = [
  {
    id: "pg-src",
    kind: "postgres",
    name: "pg-src",
    displayName: "Postgres source",
    enabled: true,
    capabilities: { read: true, write: false, query: true },
  },
  {
    id: "ms-tgt",
    kind: "mssql",
    name: "ms-tgt",
    displayName: "MSSQL target",
    enabled: true,
    capabilities: { read: false, write: true, query: true },
  },
]

describe("list_adapters tool", () => {
  it("lists configured connectors with capabilities", async () => {
    const tool = createListAdaptersTool(hostWith({ listAdapters: () => adapters, moveData: async () => ({}) as MoveSummary, previewMove: async () => ({ rows: [], truncated: false }) }))
    const out = await tool.execute({})
    expect(out).toContain("2 connector(s)")
    expect(out).toContain("pg-src [postgres]")
    expect(out).toContain("read/query")
    expect(out).toContain("ms-tgt [mssql]")
    expect(out).toContain("write/query")
  })

  it("reports when the port is not wired", async () => {
    const tool = createListAdaptersTool(hostWith(null))
    const out = await tool.execute({})
    expect(out).toContain("not configured")
  })
})

describe("bridge_data tool", () => {
  it("calls the port and formats the summary", async () => {
    let captured: { source: string; target: string; transform?: unknown } | null = null
    const summary: MoveSummary = {
      status: "completed",
      rowsRead: 42,
      rowsWritten: 42,
      errors: [],
      failedAtRow: null,
    }
    const port = {
      listAdapters: () => adapters,
      moveData: async (s: { connectorId: string }, t: { connectorId: string }, o: { transform?: unknown }) => {
        captured = { source: s.connectorId, target: t.connectorId, transform: o?.transform }
        return summary
      },
      previewMove: async () => ({ rows: [], truncated: false }),
    }
    const tool = createBridgeDataTool(hostWith(port as never))
    const out = await tool.execute({
      source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT 1" } },
      target: { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "append" } },
      transform: { columns: [{ from: "a", to: "b" }] },
    })
    expect(out).toContain("completed")
    expect(out).toContain("rowsRead=42")
    expect(out).toContain("rowsWritten=42")
    expect(captured).toEqual({
      source: "pg-src",
      target: "ms-tgt",
      transform: { columns: [{ from: "a", to: "b" }] },
    })
  })

  it("validates missing source/target", async () => {
    const tool = createBridgeDataTool(hostWith({ listAdapters: () => [], moveData: async () => ({}) as MoveSummary, previewMove: async () => ({ rows: [], truncated: false }) }))
    const out = await tool.execute({ target: { connectorId: "x", spec: { kind: "sql", table: "t", mode: "append" } } })
    expect(out).toContain("source.connectorId and source.spec are required")
  })

  it("surfaces a partial summary with failedAtRow and errors", async () => {
    const port = {
      listAdapters: () => [],
      moveData: async () => ({
        status: "partial",
        rowsRead: 10,
        rowsWritten: 7,
        errors: [{ row: 7, message: "boom" }],
        failedAtRow: 7,
      } as MoveSummary),
      previewMove: async () => ({ rows: [], truncated: false }),
    }
    const tool = createBridgeDataTool(hostWith(port as never))
    const out = await tool.execute({
      source: { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT 1" } },
      target: { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "append" } },
    })
    expect(out).toContain("partial")
    expect(out).toContain("stopped at row 7")
    expect(out).toContain("row 7: boom")
  })
})

import { describe, expect, it } from "vitest"
import type {
  Connector,
  ConnectorAdapter,
  MoveSummary,
  ReadSpec,
  Row,
  Transform,
  WriteSpec,
} from "@mia/shared-types"
import { AdapterRegistry, buildConnectorPort, makeSummary } from "../src/index.js"

function connector(id: string, kind: Connector["kind"], writeEnabled: boolean): Connector {
  return {
    id,
    kind,
    name: id,
    displayName: id,
    config: { writeEnabled },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

function sourceAdapter(batches: Row[][]): ConnectorAdapter {
  return {
    kind: "postgres",
    capabilities: { read: true, write: false, query: true },
    async open() {},
    async close() {},
    async* read(_spec: ReadSpec) {
      for (const b of batches) yield b
    },
    async write() {
      return makeSummary("failed", 0, 0, [], 0)
    },
  }
}

function targetAdapter(received: Row[][]): ConnectorAdapter {
  return {
    kind: "mssql",
    capabilities: { read: false, write: true, query: true },
    async open() {},
    async close() {},
    async* read() {
      yield []
    },
    async write(_spec: WriteSpec, rows: AsyncGenerator<Row[]>) {
      let written = 0
      for await (const b of rows) {
        received.push(b)
        written += b.length
      }
      return makeSummary("completed", written, written, [], null)
    },
  }
}

describe("connector port (postgres -> mssql e2e)", () => {
  it("resolves connector ids, runs the engine, and applies the transform", async () => {
    const pg = connector("pg-src", "postgres", false)
    const mssql = connector("ms-tgt", "mssql", true)
    const received: Row[][] = []
    const registry = new AdapterRegistry()
    registry.register("postgres", () => sourceAdapter([[{ id: 1, name: "a" }], [{ id: 2, name: "b" }]]))
    registry.register("mssql", () => targetAdapter(received))

    const port = buildConnectorPort(registry, [pg, mssql])
    const transform: Transform = {
      columns: [
        { from: "id", to: "key" },
        { from: "name", to: "label" },
      ],
    }
    const summary = await port.moveData(
      { connectorId: "pg-src", spec: { kind: "sql", sql: "SELECT id, name FROM t" } },
      { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "replace" } },
      { transform },
    )

    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(2)
    expect(received).toEqual([[{ key: 1, label: "a" }], [{ key: 2, label: "b" }]])
  })

  it("listAdapters surfaces capabilities per connector", () => {
    const pg = connector("pg-src", "postgres", false)
    const mssql = connector("ms-tgt", "mssql", true)
    const registry = new AdapterRegistry()
    registry.register("postgres", () => sourceAdapter([]))
    registry.register("mssql", () => targetAdapter([]))
    const port = buildConnectorPort(registry, [pg, mssql])
    const info = port.listAdapters()
    expect(info.map((c) => c.id).sort()).toEqual(["ms-tgt", "pg-src"])
    const pgInfo = info.find((c) => c.id === "pg-src")!
    expect(pgInfo.capabilities).toEqual({ read: true, write: false, query: true })
  })

  it("throws on an unknown connector id", async () => {
    const registry = new AdapterRegistry()
    registry.register("mssql", () => targetAdapter([]))
    const port = buildConnectorPort(registry, [connector("ms-tgt", "mssql", true)])
    await expect(
      port.moveData(
        { connectorId: "nope", spec: { kind: "sql", sql: "SELECT 1" } },
        { connectorId: "ms-tgt", spec: { kind: "sql", table: "t", mode: "append" } },
      ),
    ).rejects.toThrow(/unknown connector id/)
  })
})

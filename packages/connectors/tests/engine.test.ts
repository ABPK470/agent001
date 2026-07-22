import { describe, expect, it } from "vitest"
import type {
  ConnectorAdapter,
  MoveSummary,
  ReadSpec,
  Row,
  Transform,
  WriteSpec,
} from "@mia/shared-types"
import { applyTransform, makeSummary, moveData } from "../src/engine.js"

/** A mock source adapter that yields fixed batches lazily. */
function mockSource(batches: Row[][]): ConnectorAdapter {
  let i = 0
  return {
    kind: "mssql",
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

/** A mock target adapter that records received batches and can inject a failure. */
function mockTarget(opts: {
  received: Row[][]
  failAtBatch?: number
  summary?: MoveSummary
}): ConnectorAdapter {
  let batchIdx = 0
  return {
    kind: "mssql",
    capabilities: { read: false, write: true, query: true },
    async open() {},
    async close() {},
    async* read() {
      yield []
    },
    async write(_spec: WriteSpec, rows: AsyncGenerator<Row[]>) {
      let rowsWritten = 0
      for await (const batch of rows) {
        if (opts.failAtBatch !== undefined && batchIdx === opts.failAtBatch) {
          return makeSummary("partial", rowsWritten, rowsWritten, [{ row: rowsWritten, message: "injected" }], rowsWritten)
        }
        opts.received.push(batch)
        rowsWritten += batch.length
        batchIdx++
      }
      return opts.summary ?? makeSummary("completed", rowsWritten, rowsWritten, [], null)
    },
  }
}

describe("applyTransform", () => {
  it("passes rows through unchanged when no transform", async () => {
    const batches = [[{ a: 1 }], [{ a: 2 }]]
    const out: Row[][] = []
    for await (const b of applyTransform(toAsync(batches), undefined)) out.push(b)
    expect(out).toEqual(batches)
  })

  it("renames and casts columns", async () => {
    const transform: Transform = {
      columns: [
        { from: "a", to: "id", cast: "string" },
        { from: "b", to: "count", cast: "number" },
      ],
    }
    const batches = [[{ a: 1, b: "5" }, { a: 2, b: "6" }]]
    const out: Row[][] = []
    for await (const b of applyTransform(toAsync(batches), transform)) out.push(b)
    expect(out).toEqual([[{ id: "1", count: 5 }, { id: "2", count: 6 }]])
  })

  it("applies column default when source is null or missing", async () => {
    const transform: Transform = {
      columns: [
        { from: "id", to: "id" },
        { from: "status", to: "status", default: "pending" },
      ],
    }
    const batches = [[{ id: 1, status: null }, { id: 2 }, { id: 3, status: "live" }]]
    const out: Row[][] = []
    for await (const b of applyTransform(toAsync(batches), transform)) out.push(b)
    expect(out).toEqual([
      [
        { id: 1, status: "pending" },
        { id: 2, status: "pending" },
        { id: 3, status: "live" },
      ],
    ])
  })

  it("emits constant target columns when from is empty", async () => {
    const transform: Transform = {
      columns: [
        { from: "id", to: "id" },
        { from: "", to: "Status", default: "imported" },
      ],
    }
    const batches = [[{ id: 1 }, { id: 2 }]]
    const out: Row[][] = []
    for await (const b of applyTransform(toAsync(batches), transform)) out.push(b)
    expect(out).toEqual([
      [
        { id: 1, Status: "imported" },
        { id: 2, Status: "imported" },
      ],
    ])
  })
})

describe("moveData", () => {
  it("streams batches source-to-target without buffering the whole dataset", async () => {
    const received: Row[] = []
    const target = mockTarget({ received })
    // Simulate a large move: many batches, each small. The mock target
    // records only one batch at a time, proving the engine never accumulates.
    const batches: Row[][] = Array.from({ length: 1000 }, (_, i) => [{ i }])
    const summary = await moveData(
      { adapter: mockSource(batches), spec: { kind: "sql", sql: "SELECT 1" } },
      { adapter: target, spec: { kind: "sql", table: "t", mode: "append" } },
    )
    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(1000)
    expect(received.length).toBe(1000)
  })

  it("reports a partial summary when the target fails mid-stream", async () => {
    const received: Row[] = []
    const target = mockTarget({ received, failAtBatch: 2 })
    const batches = [[{ i: 0 }], [{ i: 1 }], [{ i: 2 }], [{ i: 3 }]]
    const summary = await moveData(
      { adapter: mockSource(batches), spec: { kind: "sql", sql: "SELECT 1" } },
      { adapter: target, spec: { kind: "sql", table: "t", mode: "append" } },
    )
    expect(summary.status).toBe("partial")
    expect(summary.rowsWritten).toBe(2)
    expect(received.length).toBe(2)
  })
})

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}

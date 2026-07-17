import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { createHttpApiAdapter, type HttpDriver } from "../../src/adapters/http-api.js"

function connector(): Connector {
  return {
    id: "api",
    kind: "httpApi",
    name: "api",
    displayName: "API",
    config: { baseUrl: "https://example.com", apiKey: "k" },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

interface MockHttpDriver extends HttpDriver {
  readonly calls: { method: string; path: string; body?: unknown; headers?: Record<string, string> }[]
  response: unknown
  failOnPath?: string
}

function mockDriver(response: unknown): MockHttpDriver {
  const d: MockHttpDriver = {
    calls: [],
    response,
    async request(method, path, body, headers) {
      d.calls.push({ method, path, body, headers })
      if (d.failOnPath && path === d.failOnPath) throw new Error(`boom @ ${path}`)
      return d.response
    },
    async close() {},
  }
  return d
}

async function* toAsync(batches: Row[][]): AsyncGenerator<Row[]> {
  for (const b of batches) yield b
}

describe("httpApi adapter", () => {
  it("reads a top-level JSON array and re-batches it", async () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const driver = mockDriver(rows)
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver, batchSize: 2 })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "httpApi", method: "GET", path: "/items" })) out.push(b)
    await adapter.close()
    expect(out).toEqual([[{ a: 1 }, { a: 2 }], [{ a: 3 }]])
    expect(driver.calls).toEqual([{ method: "GET", path: "/items", body: undefined, headers: undefined }])
  })

  it("navigates jsonPath to find the rows array", async () => {
    const driver = mockDriver({ data: { items: [{ a: 1 }] }, meta: { page: 1 } })
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "httpApi", method: "GET", path: "/x", jsonPath: "data.items" })) out.push(b)
    await adapter.close()
    expect(out).toEqual([[{ a: 1 }]])
  })

  it("throws when the response is not an array", async () => {
    const driver = mockDriver({ notRows: "nope" })
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await expect(async () => {
      for await (const _ of adapter.read({ kind: "httpApi", method: "GET", path: "/x" })) {
        /* drain */
      }
    }).rejects.toThrow(/expected a JSON array/)
    await adapter.close()
  })

  it("writes one request per row and reports completed", async () => {
    const driver = mockDriver(null)
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "httpApi", method: "POST", path: "/upsert" },
      toAsync([[{ a: 1 }, { a: 2 }], [{ a: 3 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("completed")
    expect(summary.rowsRead).toBe(3)
    expect(summary.rowsWritten).toBe(3)
    expect(driver.calls).toHaveLength(3)
    expect(driver.calls[0]).toMatchObject({ method: "POST", path: "/upsert", body: { a: 1 } })
  })

  it("merges a static spec body with the row (row wins)", async () => {
    const driver = mockDriver(null)
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await adapter.write(
      { kind: "httpApi", method: "POST", path: "/upsert", body: { source: "etl", ts: 1 } },
      toAsync([[{ a: 1 }]]),
    )
    await adapter.close()
    expect(driver.calls[0]!.body).toEqual({ source: "etl", ts: 1, a: 1 })
  })

  it("continues past per-row failures and reports partial", async () => {
    const driver = mockDriver(null)
    driver.failOnPath = "/upsert"
    // fail only the first row, then succeed the rest
    let attempt = 0
    driver.request = async (method, path, body, headers) => {
      driver.calls.push({ method, path, body, headers })
      attempt++
      if (attempt === 1) throw new Error("boom @ /upsert")
      return null
    }
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "httpApi", method: "POST", path: "/upsert" },
      toAsync([[{ a: 1 }, { a: 2 }, { a: 3 }]]),
      { stopOnError: false },
    )
    await adapter.close()
    expect(summary.status).toBe("partial")
    expect(summary.rowsRead).toBe(3)
    expect(summary.rowsWritten).toBe(2)
    expect(summary.errors).toEqual([{ row: 0, message: "boom @ /upsert" }])
  })

  it("stops at the first row failure when stopOnError is true (default)", async () => {
    const driver = mockDriver(null)
    let attempt = 0
    driver.request = async (method, path, body, headers) => {
      driver.calls.push({ method, path, body, headers })
      attempt++
      if (attempt === 1) throw new Error("boom @ /upsert")
      return null
    }
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "httpApi", method: "POST", path: "/upsert" },
      toAsync([[{ a: 1 }, { a: 2 }, { a: 3 }]]),
    )
    await adapter.close()
    expect(summary.status).toBe("partial")
    expect(summary.rowsRead).toBe(1)
    expect(summary.rowsWritten).toBe(0)
    expect(summary.failedAtRow).toBe(0)
    expect(summary.errors).toEqual([{ row: 0, message: "boom @ /upsert" }])
  })

  it("rejects read/write spec kind mismatches", async () => {
    const driver = mockDriver([])
    const adapter = createHttpApiAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await expect(async () => {
      for await (const _ of adapter.read({ kind: "sql", sql: "SELECT 1" })) {
        /* drain */
      }
    }).rejects.toThrow(/cannot read spec kind 'sql'/)
    await expect(
      adapter.write({ kind: "sql", table: "t", mode: "append" } as never, toAsync([[{ a: 1 }]])),
    ).rejects.toThrow(/cannot write spec kind 'sql'/)
    await adapter.close()
  })
})

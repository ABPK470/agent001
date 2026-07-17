import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { createDenodoAdapter, type DenodoDriver } from "../../src/adapters/denodo.js"

function connector(): Connector {
  return {
    id: "denodo",
    kind: "denodo",
    name: "denodo",
    displayName: "Denodo",
    config: { baseUrl: "https://denodo.example.com", user: "u", password: "p" },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

interface MockDenodoDriver extends DenodoDriver {
  readonly calls: { view: string; params?: Record<string, string> }[]
  response: unknown
}

function mockDriver(response: unknown): MockDenodoDriver {
  const d: MockDenodoDriver = {
    calls: [],
    response,
    async get(view, params) {
      d.calls.push({ view, params })
      return d.response
    },
    async close() {},
  }
  return d
}

describe("denodo adapter", () => {
  it("reads a view and re-batches the JSON array", async () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]
    const driver = mockDriver(rows)
    const adapter = createDenodoAdapter(connector(), { driverProvider: async () => driver, batchSize: 2 })
    await adapter.open()
    const out: Row[][] = []
    for await (const b of adapter.read({ kind: "denodo", view: "db/my_view", params: { limit: "10" } })) out.push(b)
    await adapter.close()
    expect(out).toEqual([[{ a: 1 }, { a: 2 }], [{ a: 3 }, { a: 4 }]])
    expect(driver.calls).toEqual([{ view: "db/my_view", params: { limit: "10" } }])
  })

  it("throws when the view response is not a JSON array", async () => {
    const driver = mockDriver({ rows: [] })
    const adapter = createDenodoAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await expect(async () => {
      for await (const _ of adapter.read({ kind: "denodo", view: "db/v" })) {
        /* drain */
      }
    }).rejects.toThrow(/expected a JSON array/)
    await adapter.close()
  })

  it("is read-only: write reports failed", async () => {
    const driver = mockDriver([])
    const adapter = createDenodoAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    const summary = await adapter.write(
      { kind: "sql", table: "t", mode: "append" },
      (async function* () {
        yield [{ a: 1 }]
      })(),
    )
    await adapter.close()
    expect(summary.status).toBe("failed")
    expect(summary.errors[0]!.message).toContain("read-only")
  })

  it("rejects a non-denodo read spec", async () => {
    const driver = mockDriver([])
    const adapter = createDenodoAdapter(connector(), { driverProvider: async () => driver })
    await adapter.open()
    await expect(async () => {
      for await (const _ of adapter.read({ kind: "sql", sql: "SELECT 1" })) {
        /* drain */
      }
    }).rejects.toThrow(/cannot read spec kind 'sql'/)
    await adapter.close()
  })

  it("advertises read-only capabilities", () => {
    const adapter = createDenodoAdapter(connector(), { driverProvider: async () => mockDriver([]) })
    expect(adapter.capabilities).toEqual({ read: true, write: false, query: false })
  })
})

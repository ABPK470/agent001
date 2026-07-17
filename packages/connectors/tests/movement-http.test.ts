/**
 * movement-http.test.ts — e2e through buildConnectorPort with httpApi + denodo
 * adapters (mocked drivers). Verifies the registry wires the new kinds and the
 * streaming engine pipes denodo (read) → httpApi (write) end-to-end.
 */

import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { AdapterRegistry, buildConnectorPort } from "../src/registry.js"
import { createDenodoAdapter, type DenodoDriver } from "../src/adapters/denodo.js"
import { createHttpApiAdapter, type HttpDriver } from "../src/adapters/http-api.js"

function connector(id: string, kind: Connector["kind"], config: Record<string, unknown>): Connector {
  return {
    id,
    kind,
    name: id,
    displayName: id,
    config: config as Connector["config"],
    enabled: true,
    createdAt: "",
    updatedAt: "",
    updatedBy: null,
  }
}

function mockDenodo(rows: Row[]): DenodoDriver {
  return {
    async get() {
      return rows
    },
    async close() {},
  }
}

function mockHttp(): HttpDriver & { posted: Row[] } {
  const posted: Row[] = []
  return {
    posted,
    async request(_method, _path, body) {
      if (body && typeof body === "object") posted.push(body as Row)
      return null
    },
    async close() {},
  }
}

describe("data movement: denodo → httpApi (e2e via port)", () => {
  it("streams rows from a denodo view into per-row HTTP POSTs", async () => {
    const denodoRows: Row[] = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const http = mockHttp()

    const registry = new AdapterRegistry()
    registry.register("denodo", (c) =>
      createDenodoAdapter(c, { driverProvider: async () => mockDenodo(denodoRows) }),
    )
    registry.register("httpApi", (c) =>
      createHttpApiAdapter(c, { driverProvider: async () => http, batchSize: 2 }),
    )

    const connectors = [
      connector("den-src", "denodo", { baseUrl: "https://d" }),
      connector("api-tgt", "httpApi", { baseUrl: "https://a" }),
    ]
    const port = buildConnectorPort(registry, connectors)

    const summary = await port.moveData(
      { connectorId: "den-src", spec: { kind: "denodo", view: "db/v" } },
      { connectorId: "api-tgt", spec: { kind: "httpApi", method: "POST", path: "/ingest" } },
    )

    expect(summary.status).toBe("completed")
    expect(summary.rowsRead).toBe(3)
    expect(summary.rowsWritten).toBe(3)
    expect(http.posted).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it("applies a transform between denodo read and httpApi write", async () => {
    const denodoRows: Row[] = [{ a: 1 }, { a: 2 }]
    const http = mockHttp()

    const registry = new AdapterRegistry()
    registry.register("denodo", (c) =>
      createDenodoAdapter(c, { driverProvider: async () => mockDenodo(denodoRows) }),
    )
    registry.register("httpApi", (c) =>
      createHttpApiAdapter(c, { driverProvider: async () => http }),
    )
    const connectors = [
      connector("den-src", "denodo", {}),
      connector("api-tgt", "httpApi", {}),
    ]
    const port = buildConnectorPort(registry, connectors)

    const summary = await port.moveData(
      { connectorId: "den-src", spec: { kind: "denodo", view: "db/v" } },
      { connectorId: "api-tgt", spec: { kind: "httpApi", method: "POST", path: "/ingest" } },
      { transform: { columns: [{ from: "a", to: "value" }], derive: [{ to: "label", template: "row-${a}" }] } },
    )

    expect(summary.status).toBe("completed")
    expect(http.posted).toEqual([
      { value: 1, label: "row-1" },
      { value: 2, label: "row-2" },
    ])
  })

  it("listAdapters reports capabilities for the new kinds", () => {
    const registry = new AdapterRegistry()
    registry.register("denodo", (c) => createDenodoAdapter(c, { driverProvider: async () => mockDenodo([]) }))
    registry.register("httpApi", (c) => createHttpApiAdapter(c, { driverProvider: async () => mockHttp() }))
    const connectors = [
      connector("den-src", "denodo", {}),
      connector("api-tgt", "httpApi", {}),
    ]
    const port = buildConnectorPort(registry, connectors)
    const list = port.listAdapters()
    expect(list).toHaveLength(2)
    expect(list.find((c) => c.id === "den-src")!.capabilities).toEqual({ read: true, write: false, query: false })
    expect(list.find((c) => c.id === "api-tgt")!.capabilities).toEqual({ read: true, write: true, query: false })
  })

  it("previewMove reads from denodo without writing", async () => {
    const denodoRows: Row[] = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const http = mockHttp()
    const registry = new AdapterRegistry()
    registry.register("denodo", (c) => createDenodoAdapter(c, { driverProvider: async () => mockDenodo(denodoRows) }))
    registry.register("httpApi", (c) => createHttpApiAdapter(c, { driverProvider: async () => http }))
    const port = buildConnectorPort(registry, [connector("den-src", "denodo", {})])

    const res = await port.previewMove(
      { connectorId: "den-src", spec: { kind: "denodo", view: "db/v" } },
      { limit: 2 },
    )
    expect(res.rows).toEqual([{ a: 1 }, { a: 2 }])
    expect(res.truncated).toBe(true)
    expect(http.posted).toEqual([])
  })
})

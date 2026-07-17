/**
 * movement-hdfs.test.ts — e2e through buildConnectorPort with webhdfs + httpApi
 * adapters (mocked drivers). Verifies the registry wires the webhdfs kind and
 * the streaming engine pipes CSV/JSON files to/from HTTP, end-to-end.
 */

import { describe, expect, it } from "vitest"
import type { Connector, Row } from "@mia/shared-types"
import { AdapterRegistry, buildConnectorPort } from "../src/registry.js"
import { createWebhdfsAdapter, type WebHdfsDriver } from "../src/adapters/webhdfs.js"
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

function mockHttp(response: unknown): HttpDriver & { posted: Row[] } {
  const posted: Row[] = []
  return {
    posted,
    async request(_method, _path, body) {
      if (body && typeof body === "object") posted.push(body as Row)
      return response
    },
    async close() {},
  }
}

function mockHdfs(files: Record<string, string>): WebHdfsDriver & { uploads: { path: string; mode: string; text: string }[] } {
  const uploads: { path: string; mode: string; text: string }[] = []
  return {
    uploads,
    async readText(path) {
      return files[path] ?? ""
    },
    async putText(path, mode, body) {
      const reader = body.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      uploads.push({ path, mode, text: new TextDecoder().decode(Buffer.concat(chunks)) })
    },
    async close() {},
  }
}

describe("data movement: httpApi ↔ webhdfs (e2e via port)", () => {
  it("reads a CSV file from HDFS and POSTs each row to an HTTP API", async () => {
    const hdfs = mockHdfs({ "/in/x.csv": "id,name\n1,alice\n2,bob\n3,carol" })
    const http = mockHttp(null)

    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs, writeEnabled: false, batchSize: 2 }))
    registry.register("httpApi", (c) => createHttpApiAdapter(c, { driverProvider: async () => http }))

    const port = buildConnectorPort(registry, [
      connector("hdfs-src", "webhdfs", { host: "nn" }),
      connector("api-tgt", "httpApi", { baseUrl: "https://a" }),
    ])

    const summary = await port.moveData(
      { connectorId: "hdfs-src", spec: { kind: "webhdfs", path: "/in/x.csv", format: "csv" } },
      { connectorId: "api-tgt", spec: { kind: "httpApi", method: "POST", path: "/ingest" } },
    )

    expect(summary.status).toBe("completed")
    expect(summary.rowsRead).toBe(3)
    expect(summary.rowsWritten).toBe(3)
    expect(http.posted).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
      { id: "3", name: "carol" },
    ])
  })

  it("reads JSON from an HTTP API and writes a CSV file to HDFS (replace)", async () => {
    const hdfs = mockHdfs({})
    const http = mockHttp([{ a: 1, b: "x" }, { a: 2, b: "y" }])

    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs, writeEnabled: true }))
    registry.register("httpApi", (c) => createHttpApiAdapter(c, { driverProvider: async () => http }))

    const port = buildConnectorPort(registry, [
      connector("api-src", "httpApi", { baseUrl: "https://a" }),
      connector("hdfs-tgt", "webhdfs", { host: "nn", writeEnabled: true }),
    ])

    const summary = await port.moveData(
      { connectorId: "api-src", spec: { kind: "httpApi", method: "GET", path: "/rows" } },
      { connectorId: "hdfs-tgt", spec: { kind: "webhdfs", path: "/out/y.csv", format: "csv", mode: "replace" } },
    )

    expect(summary.status).toBe("completed")
    expect(summary.rowsWritten).toBe(2)
    expect(hdfs.uploads).toHaveLength(1)
    expect(hdfs.uploads[0]!.path).toBe("/out/y.csv")
    expect(hdfs.uploads[0]!.mode).toBe("replace")
    expect(hdfs.uploads[0]!.text).toBe("a,b\n1,x\n2,y\n")
  })

  it("applies a transform between HDFS CSV read and HTTP write", async () => {
    const hdfs = mockHdfs({ "/in/x.csv": "k,v\n1,foo\n2,bar" })
    const http = mockHttp(null)
    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs, writeEnabled: false }))
    registry.register("httpApi", (c) => createHttpApiAdapter(c, { driverProvider: async () => http }))
    const port = buildConnectorPort(registry, [
      connector("hdfs-src", "webhdfs", {}),
      connector("api-tgt", "httpApi", {}),
    ])

    await port.moveData(
      { connectorId: "hdfs-src", spec: { kind: "webhdfs", path: "/in/x.csv", format: "csv" } },
      { connectorId: "api-tgt", spec: { kind: "httpApi", method: "POST", path: "/ingest" } },
      { transform: { columns: [{ from: "k", to: "key", cast: "string" }], derive: [{ to: "label", template: "v=${v}" }] } },
    )

    expect(http.posted).toEqual([
      { key: "1", label: "v=foo" },
      { key: "2", label: "v=bar" },
    ])
  })

  it("listAdapters reports webhdfs capabilities", () => {
    const hdfs = mockHdfs({})
    const registry = new AdapterRegistry()
    registry.register("webhdfs", (c) => createWebhdfsAdapter(c, { driverProvider: async () => hdfs, writeEnabled: true }))
    const port = buildConnectorPort(registry, [connector("hdfs", "webhdfs", {})])
    const list = port.listAdapters()
    expect(list[0]!.capabilities).toEqual({ read: true, write: true, query: false })
  })
})
